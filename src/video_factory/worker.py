"""Machine-readable media worker entrypoint."""

import hashlib
import json
import math
import mimetypes
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Dict

from .domain import Scene
from .script_service import draft_script_from_values, draft_to_dict
from .stock_assets import (
    StockSearchUnavailableError,
    prepare_routed_scene_assets,
    prepare_scene_assets,
    reuse_source_scene_position,
    search_routed_scene_asset_candidates,
)
from .technical_review import review_video
from .voiceover import VoiceDoesNotFitError, synthesize_voiceover_plan
from .continuous_voiceover import NarrationGroupDoesNotFitError, assemble_narration_track
from .narration_plan import validate_narration_plan
from .group_voiceover import synthesize_minimax_groups, forecast_minimax_groups
from .narration_subtitles import build_group_subtitles, cues_to_ass, cues_to_vtt, recover_subtitles
from .voiceover import mastering_settings, _write_bytes_durably, _write_json_durably
from .renderer import render_job_manifest
from .diagnostics import diagnostic_context, diagnostic_span


WORKER_PROTOCOL_VERSION = "video-factory/worker-v1"
BRIEF_PROTOCOL_VERSION = "video-factory/brief-v1"
SUPPORTED_CAPABILITIES = {
    "script.draft",
    "asset.search",
    "asset.prepare",
    "voice.synthesize",
    "voice.quote",
    "video.render",
    "quality.review",
}


class WorkerProtocolError(ValueError):
    pass


def validate_request(request: Dict[str, Any]) -> None:
    if request.get("protocolVersion") != WORKER_PROTOCOL_VERSION:
        raise WorkerProtocolError(
            f"Unsupported protocolVersion: {request.get('protocolVersion')!r}; expected {WORKER_PROTOCOL_VERSION}"
        )

    for field in ("commandId", "runId", "nodeRunId", "capability", "outputDir"):
        value = request.get(field)
        if not isinstance(value, str) or not value.strip():
            raise WorkerProtocolError(f"Missing or invalid {field}")
    if not isinstance(request.get("attempt"), int) or request["attempt"] < 1:
        raise WorkerProtocolError("Missing or invalid attempt")
    if request["capability"] not in SUPPORTED_CAPABILITIES:
        raise WorkerProtocolError(f"Unsupported capability: {request['capability']}")
    if not isinstance(request.get("input"), dict):
        raise WorkerProtocolError("Missing or invalid input")
    if not isinstance(request.get("parameters", {}), dict):
        raise WorkerProtocolError("Invalid parameters")


def handle_request(request: Dict[str, Any]) -> Dict[str, Any]:
    started_at = time.monotonic()
    validate_request(request)
    capability = request["capability"]
    output_dir = Path(request["outputDir"]).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    if capability == "asset.prepare":
        return prepare_assets(request, output_dir, started_at)
    if capability == "asset.search":
        return search_assets(request, output_dir, started_at)
    if capability == "voice.synthesize":
        return synthesize_voice(request, output_dir, started_at)
    if capability == "voice.quote":
        inputs, parameters = request["input"], request.get("parameters", {})
        plan = inputs.get("narrationPlan")
        if not isinstance(plan, dict) or plan.get("version") != "video-factory/narration-plan-v1":
            raise WorkerProtocolError("Voice quote requires a confirmed-format narration plan.")
        quote = forecast_minimax_groups(plan, output_dir.parent, voice=str(inputs.get("voice") or "female-chengshu"),
            rate=int(inputs.get("rate", 190)), pause_scale=float(inputs.get("pause_scale", 1)),
            model_id=str(parameters.get("modelId") or "speech-2.8-turbo"),
            provider_id=str(parameters.get("providerId") or "minimax-tts-v1"))
        return success_response(request, output=quote, artifacts=[], started_at=started_at)
    if capability == "video.render":
        return render_video(request, output_dir, started_at)
    if capability == "quality.review":
        return run_technical_review(request, output_dir, started_at)
    if capability != "script.draft":
        raise WorkerProtocolError(f"Capability is not implemented yet: {capability}")

    brief = require_brief(request["input"])
    draft = draft_script_from_values(
        title=brief["title"],
        angle=brief["angle"],
        niche_slug=brief["nicheSlug"],
        audience=brief["audience"],
        duration_target=int(brief["durationSeconds"]),
    )
    script_path = output_dir / "script.json"
    script_path.write_text(
        json.dumps(draft_to_dict(draft), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    artifact = describe_artifact(
        path=script_path,
        kind="script",
        content_type="application/json",
        request=request,
        license_note="VideoFactory generated script; human review required before publishing.",
    )
    return success_response(
        request,
        output={"scriptPath": str(script_path)},
        artifacts=[artifact],
        started_at=started_at,
    )


def prepare_assets(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    formal_script_path = require_existing_path(request["input"], "scriptPath")
    formal_script_bytes = formal_script_path.read_bytes()
    script_path, executable_plan = materialize_executable_script(
        request["input"], output_dir, formal_script_bytes=formal_script_bytes,
    )
    script = json.loads(script_path.read_text(encoding="utf-8")) if executable_plan is not None else json.loads(formal_script_bytes)
    scenes = [
        Scene(
            position=int(scene["position"]),
            narration=str(scene["narration"]),
            duration=float(scene["duration"]),
            visual_strategy=str(scene["visual_strategy"]),
            visual_prompt=str(scene["visual_prompt"]),
            search_terms=[str(term) for term in scene.get("search_terms", [])],
        )
        for scene in script.get("scenes", [])
    ]
    if not scenes:
        raise WorkerProtocolError("asset.prepare requires a script with scenes")
    source_ends = {
        position: (timing["source_in_frame"] + timing["duration_frames"]) / 30
        for position, timing in validate_executable_plan(executable_plan).items()
    } if executable_plan is not None else None
    parameters = request.get("parameters", {})
    provider = str(parameters.get("provider", "local"))
    if provider not in {"local", "pexels", "pixabay", "unsplash", "coverr", "wikimedia", "met", "nasa", "openverse", "cleveland", "archive", "flickr", "mock", "ai-router"}:
        raise WorkerProtocolError(f"Unsupported asset provider: {provider}")
    if provider == "local":
        raise WorkerProtocolError(
            "Local editorial cards require an explicit director route selecting local-editorial-v1 + editorial_card"
        )
    if provider == "ai-router":
        director_plan_path = require_existing_path(request["input"], "directorPlanPath")
        director_plan = json.loads(director_plan_path.read_text(encoding="utf-8"))
        ranking_path_value = request["input"].get("candidateRankingPath")
        candidate_ranking = None
        if ranking_path_value is not None:
            ranking_path = require_existing_path(request["input"], "candidateRankingPath")
            candidate_ranking = json.loads(ranking_path.read_text(encoding="utf-8"))
        inventory_path_value = request["input"].get("candidateInventoryPath")
        candidate_inventory = None
        if inventory_path_value is not None:
            inventory_path = require_existing_path(request["input"], "candidateInventoryPath")
            candidate_inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
        accepted_quality_scenes: set[int] = set()
        acceptance = candidate_ranking.get("deliveryAcceptance") if isinstance(candidate_ranking, dict) else None
        if acceptance is not None:
            if not isinstance(acceptance, dict) or acceptance.get("policyVersion") != "playable-first-v1":
                raise WorkerProtocolError("Stock delivery acceptance contract is invalid")
            if candidate_inventory is None:
                raise WorkerProtocolError("Stock delivery acceptance requires the confirmed inventory")
            for field, digest in (("scriptSha256", hashlib.sha256(formal_script_bytes).hexdigest()),
                                  ("directorPlanSha256", hashlib.sha256(director_plan_path.read_bytes()).hexdigest()),
                                  ("inventorySha256", hashlib.sha256(inventory_path.read_bytes()).hexdigest())):
                if acceptance.get(field) != digest:
                    raise WorkerProtocolError(f"Stock delivery acceptance does not match {field}")
            positions = acceptance.get("scenePositions")
            if not isinstance(positions, list) or any(type(position) is not int or position <= 0 for position in positions):
                raise WorkerProtocolError("Stock delivery acceptance scene scope is invalid")
            accepted_quality_scenes = set(positions)
            eligible = {shot.get("scenePosition") for shot in director_plan.get("shots", [])
                        if shot.get("authenticityPolicy") == "illustrative" and shot.get("deliveryType") in {"stock_image", "stock_video"}}
            routes = {shot.get("scenePosition"): shot for shot in director_plan.get("shots", [])}
            for shot in routes.values():
                if shot.get("authenticityPolicy") != "evidence":
                    continue
                source = reuse_source_scene_position(shot)
                visited = set()
                while source is not None and source not in visited:
                    eligible.discard(source)
                    visited.add(source)
                    source = reuse_source_scene_position(routes[source]) if source in routes else None
            if not accepted_quality_scenes.issubset(eligible):
                raise WorkerProtocolError("Stock delivery acceptance cannot override evidence or non-stock routes")
        plan_path = prepare_routed_scene_assets(
            job_id=1,
            scenes=scenes,
            workspace=output_dir,
            director_plan=director_plan,
            media_type=str(parameters.get("mediaType", "video")),
            limit=int(parameters.get("limit", 6)),
            candidate_ranking=candidate_ranking,
            candidate_inventory=candidate_inventory,
            accepted_quality_scenes=accepted_quality_scenes,
            required_source_ends=source_ends,
            reusable_assets=request["input"].get("reusableStockAssets"),
        )
    else:
        plan_path = prepare_scene_assets(
            job_id=1,
            scenes=scenes,
            workspace=output_dir,
            provider=provider,
            media_type=str(parameters.get("mediaType", "video")),
            limit=int(parameters.get("limit", 6)),
            required_source_ends=source_ends,
        )
    if executable_plan is not None:
        project_executable_timings_into_asset_plan(plan_path, executable_plan)
    plan_artifact = describe_artifact(
        path=plan_path,
        kind="asset_plan",
        content_type="application/json",
        request=request,
        license_note="License snapshot is stored per scene asset in this plan.",
    )
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    pending_generation_positions = {
        int(route["scene_position"])
        for route in plan.get("director_routing", [])
        if isinstance(route, dict)
        and route.get("generation_pending") is True
        and isinstance(route.get("scene_position"), int)
    }
    media_artifacts = []
    for scene_asset in plan.get("scene_assets", []):
        if not isinstance(scene_asset, dict):
            continue
        if int(scene_asset.get("scene_position", 0)) in pending_generation_positions:
            continue
        media_path = Path(str(scene_asset.get("local_path", "")))
        if not media_path.is_file():
            raise WorkerProtocolError(f"Prepared scene asset is missing: {media_path}")
        provider_id = scene_asset_provider_id(scene_asset)
        media_artifacts.append(describe_artifact(
            path=media_path,
            kind="media_asset",
            content_type=media_content_type(media_path),
            request=request,
            license_note=str(scene_asset.get("license_note") or "Asset rights require review."),
            provider_id=provider_id,
            source_url=optional_string(scene_asset.get("source_url")),
            creator=optional_string(scene_asset.get("creator")),
            creator_url=optional_string(scene_asset.get("creator_url")),
            preview_url=optional_string(scene_asset.get("preview_url")),
            scene_position=int(scene_asset.get("scene_position", 0)) or None,
        ))
    return success_response(
        request,
        output={"assetPlanPath": str(plan_path)},
        artifacts=[plan_artifact, *media_artifacts],
        started_at=started_at,
    )


def search_assets(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    # 同机宿主传入绝对期限，在入口转换一次为单调时钟。最多留两秒落盘，
    # 不为每个来源重新分配20分钟；旧客户端未传预算时保持原行为。
    expires = request.get("executionDeadlineUnixMs")
    deadline = None
    if isinstance(expires, (int, float)) and not isinstance(expires, bool) and math.isfinite(expires):
        seconds = max(0.0, expires / 1000 - time.time())
        deadline = time.monotonic() + max(0.0, seconds - min(2.0, seconds * 0.02))
    script_path = require_existing_path(request["input"], "scriptPath")
    director_plan_path = require_existing_path(request["input"], "directorPlanPath")
    script = json.loads(script_path.read_text(encoding="utf-8"))
    director_plan = json.loads(director_plan_path.read_text(encoding="utf-8"))
    scenes = [
        Scene(
            position=int(scene["position"]),
            narration=str(scene["narration"]),
            duration=float(scene["duration"]),
            visual_strategy=str(scene["visual_strategy"]),
            visual_prompt=str(scene["visual_prompt"]),
            search_terms=[str(term) for term in scene.get("search_terms", [])],
        )
        for scene in script.get("scenes", [])
    ]
    if not scenes:
        raise WorkerProtocolError("asset.search requires a script with scenes")
    parameters = request.get("parameters", {})
    try:
        report_path, inventory_path = search_routed_scene_asset_candidates(
            job_id=1,
            scenes=scenes,
            workspace=output_dir,
            director_plan=director_plan,
            media_type=str(parameters.get("mediaType", "video")),
            limit=int(parameters.get("limit", 6)),
            **({"deadline": deadline} if deadline is not None else {}),
        )
    except StockSearchUnavailableError as error:
        # 这条 message 只由来源标识与错误类型构成（未受控异常原文不进入），可以直达界面；
        # 顶层 safe_worker_failure 会把它脱敏成「媒体处理失败（RuntimeError）」，丢失全部
        # 可操作信息，所以在这里直接返回结构化失败。
        return {
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "commandId": request["commandId"],
            "status": "failed",
            "error": {"code": "ASSET_SEARCH_SOURCES_UNAVAILABLE", "message": str(error)},
            "artifacts": [],
            "diagnostics": {"durationMs": round((time.monotonic() - started_at) * 1000, 3)},
        }
    artifact = describe_artifact(
        path=report_path,
        kind="asset_candidates",
        content_type="application/json",
        request=request,
        license_note="Preview-only candidate metadata; no media was downloaded by this node.",
    )
    return success_response(
        request,
        output={"candidateSearchPath": str(report_path), "candidateInventoryPath": str(inventory_path)},
        artifacts=[artifact],
        started_at=started_at,
    )


def synthesize_voice(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    input_values = request["input"]
    # 必须在任何合成/排轨/报价入口前分流，缓存碰巧命中不是“不会重新购买”的保证。
    if input_values.get("recover_subtitles") is True or request.get("parameters", {}).get("recoverSubtitles") is True:
        return recover_voice_subtitles(request, output_dir, started_at)
    script_path, _executable_plan = materialize_executable_script(input_values, output_dir)
    parameters = request.get("parameters", {})
    provider = str(parameters.get("provider", "macos-say"))
    voice = str(input_values.get("voice") or parameters.get("voice") or "") or None
    profile_prefix = "macos" if provider == "macos-say" else provider
    profile_id = str(input_values.get("profileId") or (
        f"{profile_prefix}:{voice}" if input_values.get("voice") else parameters.get("profileId") or ""
    )) or None
    configured_cost = parameters.get("estimatedCostCny")
    valid_configured_cost = (
        isinstance(configured_cost, (int, float))
        and not isinstance(configured_cost, bool)
        and configured_cost >= 0
    )
    try:
        if input_values.get("narrationPlanPath") is not None:
            plan_path = synthesize_continuous_voice(request, script_path, output_dir, provider, voice, profile_id)
        else:
            plan_path = synthesize_voiceover_plan(
                script_path=script_path,
                output_dir=output_dir,
                provider=provider,
                voice=voice,
                rate=int(input_values.get("rate", parameters.get("rate", 190))),
                profile_id=profile_id,
                pause_scale=float(input_values.get("pause_scale", parameters.get("pauseScale", 1))),
                mastering_preset=str(input_values.get("mastering_preset", parameters.get("masteringPreset", "natural"))),
                operation_id=request["commandId"] if provider == "minimax" else None,
                provider_id=str(parameters.get("providerId") or "minimax-tts-v1") if provider == "minimax" else None,
                model_id=optional_string(parameters.get("modelId")) if provider == "minimax" else None,
                estimated_cost_cny=float(configured_cost) if provider == "minimax" and valid_configured_cost else None,
            )
    except NarrationGroupDoesNotFitError as error:
        frame = 0
        related_cuts = []
        for scene in json.loads(script_path.read_text(encoding="utf-8"))["scenes"]:
            frames = round(scene["duration"] * 30)
            if scene["position"] in error.source_scene_positions:
                related_cuts.append({"scenePosition": scene["position"], "startFrame": frame, "frameCount": frames})
            frame += frames
        # 恢复时音频可能属于前次 attempt。复制同字节证据到本次目录以满足产物边界，原件与账本不动。
        evidence_audio = error.raw_audio_path
        if evidence_audio.parent.resolve() != output_dir.resolve():
            evidence_audio = output_dir / f"{error.group_id}-retained{error.raw_audio_path.suffix}"
            shutil.copyfile(error.raw_audio_path, evidence_audio)
        audio_artifact = describe_artifact(
            path=evidence_audio, kind="voiceover_raw", content_type=media_content_type(evidence_audio),
            request=request, license_note="Continuous narration retained for user-directed timing revision.",
        )
        return {
            "protocolVersion": WORKER_PROTOCOL_VERSION, "commandId": request["commandId"], "status": "rejected",
            "error": {"code": error.code, "message": str(error)},
            "output": {"conflict": {"code": error.code, "groupId": error.group_id,
                "sourceScenePositions": error.source_scene_positions, "window": error.window,
                "sourceAudioSamples": error.source_audio_samples, "requiredFrames": error.required_frames,
                "cuts": related_cuts,
                "audioArtifact": audio_artifact, "operationId": request["commandId"]}},
            "artifacts": [audio_artifact], "diagnostics": {
                "durationMs": round((time.monotonic() - started_at) * 1000, 3),
                **minimax_failure_diagnostics(output_dir, request["commandId"]),
            },
        }
    except VoiceDoesNotFitError as error:
        audio_artifact = describe_artifact(
            path=error.raw_audio_path,
            kind="voiceover_raw",
            content_type=media_content_type(error.raw_audio_path),
            request=request,
            license_note="Materialized natural-speed narration retained for timeline replanning.",
            scene_position=error.scene_position,
        )
        diagnostics: Dict[str, Any] = {}
        if provider == "minimax":
            diagnostics = minimax_failure_diagnostics(output_dir, request["commandId"])
        return {
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "commandId": request["commandId"],
            "status": "rejected",
            "error": {"code": error.code, "message": str(error)},
            "output": {
                "conflict": {
                    "code": error.code,
                    "scenePosition": error.scene_position,
                    "plannedSeconds": error.planned_seconds,
                    "speechSeconds": error.speech_seconds,
                    "requiredSeconds": error.required_seconds,
                    "audioArtifact": audio_artifact,
                    **({"executablePlanPath": str(input_values["executablePlanPath"])}
                       if input_values.get("executablePlanPath") else {}),
                    **({"operationId": request["commandId"]} if provider == "minimax" else {}),
                }
            },
            "artifacts": [audio_artifact],
            "diagnostics": {
                "durationMs": round((time.monotonic() - started_at) * 1000, 3),
                **diagnostics,
            },
        }
    except Exception as error:
        if provider != "minimax":
            raise
        return {
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "commandId": request["commandId"],
            "status": "failed",
            "error": {"code": "WORKER_REQUEST_FAILED", "message": safe_worker_failure(error)},
            "artifacts": [],
            "diagnostics": {
                "durationMs": round((time.monotonic() - started_at) * 1000, 3),
                **minimax_failure_diagnostics(output_dir, request["commandId"]),
            },
        }
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    artifacts = [
        describe_artifact(
            path=Path(plan["track_path"]),
            kind="voiceover",
            content_type="audio/mp4",
            request=request,
            license_note="Locally generated narration; verify the selected voice provider terms.",
        ),
        describe_artifact(
            path=plan_path,
            kind="voiceover_plan",
            content_type="application/json",
            request=request,
            license_note="VideoFactory voice timeline metadata.",
        ),
    ]
    artifacts.extend(subtitle_artifacts(request, plan_path, plan))
    diagnostics: Dict[str, Any] = {}
    if provider == "minimax" and (valid_configured_cost or plan.get("version") == "video-factory/voiceover-plan-v3"):
        synthesized_scenes = plan.get("scenes")
        metered_attempt_count = len(synthesized_scenes) if isinstance(synthesized_scenes, list) else 1
        persisted_diagnostics = minimax_failure_diagnostics(output_dir, request["commandId"])
        diagnostics = persisted_diagnostics if plan.get("version") == "video-factory/voiceover-plan-v3" or persisted_diagnostics.get("providerOutcomeKnown") is True else {
            "actualCostCny": round(float(configured_cost), 2),
            "actualCostSource": "configured_rate",
            "meteredAttemptCount": metered_attempt_count,
            "meteredFailedAttemptCount": 0,
            "providerOutcomeKnown": True,
        }
        if plan.get("version") == "video-factory/voiceover-plan-v3" and diagnostics.get("providerOutcomeKnown") is not True:
            # 有可播放文件不等于收费请求已结清；保留产物，交给原操作恢复，不能成功放行或记作零元。
            return {
                "protocolVersion": WORKER_PROTOCOL_VERSION, "commandId": request["commandId"], "status": "failed",
                "error": {"code": "VOICE_COST_EVIDENCE_UNAVAILABLE",
                          "message": "配音已保留，但原请求的费用记录暂时无法核实。请先核查原任务，不要重新合成。"},
                "artifacts": artifacts,
                "diagnostics": {"durationMs": round((time.monotonic() - started_at) * 1000, 3), **diagnostics},
            }
    return success_response(
        request,
        output={
            "voiceoverPlanPath": str(plan_path),
            "trackPath": str(plan["track_path"]),
            **({"narrationMode": "continuous_groups", "subtitleStatus": plan["subtitles"]["status"]}
               if plan.get("version") == "video-factory/voiceover-plan-v3" else {}),
        },
        artifacts=artifacts,
        started_at=started_at,
        diagnostics=diagnostics,
    )


def synthesize_continuous_voice(request: Dict[str, Any], script_path: Path, output_dir: Path,
                                provider: str, voice: str | None, profile_id: str | None) -> Path:
    """只接受正式输入绑定的可选计划；旧 run 无此字段时完全保留 v2。"""
    if provider != "minimax":
        raise WorkerProtocolError("Continuous narration currently requires the MiniMax system-voice provider.")
    inputs, parameters = request["input"], request.get("parameters", {})
    narration_path = require_existing_path(inputs, "narrationPlanPath")
    original_script = require_existing_path(inputs, "scriptPath")
    visual_path = require_existing_path(inputs, "executablePlanPath")
    scenes = json.loads(script_path.read_text(encoding="utf-8"))["scenes"]
    narration = validate_narration_plan(json.loads(narration_path.read_text(encoding="utf-8")), scenes,
        script_sha256=hashlib.sha256(original_script.read_bytes()).hexdigest(),
        visual_sha256=hashlib.sha256(visual_path.read_bytes()).hexdigest())
    rate = int(inputs.get("rate", parameters.get("rate", 190)))
    pause_scale = float(inputs.get("pause_scale", parameters.get("pauseScale", 1)))
    preset = str(inputs.get("mastering_preset", parameters.get("masteringPreset", "natural")))
    mastering = mastering_settings(preset)
    result = synthesize_minimax_groups(narration, output_dir, operation_id=request["commandId"],
        voice=voice or "female-chengshu", rate=rate, pause_scale=pause_scale,
        model_id=str(parameters.get("modelId") or "speech-2.8-turbo"),
        authorization_cny=parameters.get("maxCostCny"),
        provider_id=str(parameters.get("providerId") or "minimax-tts-v1"))
    plan = assemble_narration_track(narration, result["rawAudio"], output_dir, mastering_filter=mastering["filter"])
    narration_plan_sha256 = hashlib.sha256(narration_path.read_bytes()).hexdigest()
    # T05：已捕获的字幕证据经已核实 adapter 解析并映射到总时轴；恢复动作可指定
    # 新 adapter 重解析（纯字幕恢复，TTS 新增恒为 0）。未核实协议保持 unavailable。
    subtitle_adapter = str(inputs.get("subtitle_adapter") or parameters.get("subtitleAdapter") or "minimax-subtitles-v1")
    subtitles = build_group_subtitles(Path(result["ledgerPath"]), output_dir.parent, plan,
        narration_plan_sha256=narration_plan_sha256, adapter_version=subtitle_adapter)
    write_subtitle_sidecars(subtitles, output_dir)
    plan.update({"provider": provider, "voice": voice, "rate": rate,
        "voiceOperationId": request["commandId"],
        "trackSha256": hashlib.sha256(Path(plan["track_path"]).read_bytes()).hexdigest(),
        "direction": {"profile_id": profile_id, "rate": rate, "pause_scale": pause_scale, "mastering_preset": preset},
        "mastering": {"preset": preset, **mastering},
        # v3 的 scenes 仅索引视觉切点，不伪造逐镜音频或逐镜语音时长。
        "scenes": [{"position": scene["position"], "duration": scene["duration"]} for scene in scenes],
        "subtitles": subtitles})
    target = output_dir / "voiceover_plan.json"
    _write_json_durably(target, plan)
    return target


def write_subtitle_sidecars(subtitles: dict, output_dir: Path) -> None:
    if subtitles["status"] != "verified":
        return
    vtt_path, ass_path = output_dir / "narration.vtt", output_dir / "narration.ass"
    _write_bytes_durably(vtt_path, cues_to_vtt(subtitles["cues"]).encode("utf-8"))
    _write_bytes_durably(ass_path, cues_to_ass(subtitles["cues"]).encode("utf-8"))
    subtitles["sidecar"] = {"vtt": vtt_path.name, "ass": ass_path.name}
    subtitles["sidecarSha256"] = {kind: hashlib.sha256(file.read_bytes()).hexdigest()
        for kind, file in (("vtt", vtt_path), ("ass", ass_path))}


def subtitle_artifacts(request: dict, plan_path: Path, plan: dict) -> list[dict]:
    subtitles = plan.get("subtitles") or {}
    if subtitles.get("status") != "verified":
        return []
    return [describe_artifact(path=plan_path.parent / subtitles["sidecar"][kind],
        kind=f"narration_{kind}", content_type=content_type, request=request,
        license_note="Subtitles derived from the same retained narration audio.")
        for kind, content_type in (("vtt", "text/vtt"), ("ass", "text/x-ssa"))]


def recover_voice_subtitles(request: dict, output_dir: Path, started_at: float) -> dict:
    """复核原声音与布局后只写字幕新版本；不能进入 TTS、排轨或重买声音的路径。"""
    inputs = request["input"]
    source_path = require_existing_path(inputs, "voiceoverPlanPath").resolve()
    node_root = output_dir.parent.resolve()
    if not source_path.is_relative_to(node_root) or source_path.parent == output_dir:
        raise WorkerProtocolError("Subtitle recovery requires a retained voice plan and a new output directory.")
    source_bytes = source_path.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != inputs.get("voiceoverPlanSha256"):
        raise WorkerProtocolError("The retained voice plan has changed; refresh before recovering subtitles.")
    plan = json.loads(source_bytes)
    if plan.get("version") != "video-factory/voiceover-plan-v3" or plan.get("layoutKey") != inputs.get("layoutKey"):
        raise WorkerProtocolError("Subtitle recovery layout no longer matches the retained audio.")
    narration_path = require_existing_path(inputs, "narrationPlanPath")
    narration_sha = hashlib.sha256(narration_path.read_bytes()).hexdigest()
    if (json.loads(narration_path.read_bytes()) != plan.get("narrationPlan")
            or plan.get("subtitles", {}).get("acceptedNarrationPlanSha256") != narration_sha):
        raise WorkerProtocolError("Subtitle recovery requires the same accepted narration plan.")
    for input_key, plan_key in (("scriptPath", "script"), ("executablePlanPath", "visualPlan")):
        if hashlib.sha256(require_existing_path(inputs, input_key).read_bytes()).hexdigest() != plan["narrationPlan"][plan_key]["sha256"]:
            raise WorkerProtocolError("Subtitle recovery source binding has changed.")
    track = Path(plan["track_path"]).resolve()
    if not track.is_relative_to(node_root):
        raise WorkerProtocolError("Subtitle recovery audio is outside the retained node.")
    audio_bytes = track.read_bytes()
    audio_sha = hashlib.sha256(audio_bytes).hexdigest()
    if audio_sha != inputs.get("trackSha256") or (plan.get("trackSha256") and audio_sha != plan["trackSha256"]):
        raise WorkerProtocolError("Subtitle recovery audio content has changed.")
    operation_id = inputs.get("sourceOperationId")
    if not isinstance(operation_id, str) or not operation_id or (plan.get("voiceOperationId") and operation_id != plan["voiceOperationId"]):
        raise WorkerProtocolError("Subtitle recovery must retain the original audio request.")
    ledger_path = node_root / ".voice-operations" / (hashlib.sha256(operation_id.encode()).hexdigest() + ".json")
    ledger = json.loads(ledger_path.read_text())
    items = ledger.get("items")
    if not isinstance(items, list) or not items or any(item.get("state") != "materialized" for item in items):
        raise WorkerProtocolError("Original audio requests are not settled; recover those requests before subtitles.")
    items_by_id = {item["groupId"]: item for item in items}
    if set(items_by_id) != {group["id"] for group in plan["groups"]}:
        raise WorkerProtocolError("Subtitle recovery does not cover the retained narration groups.")
    for group in plan["groups"]:
        if group["rawAudioSha256"] != items_by_id[group["id"]].get("sha256"):
            raise WorkerProtocolError("Subtitle recovery raw audio binding has changed.")
    adapter = str(inputs.get("subtitle_adapter") or "minimax-subtitles-v1")
    subtitles = recover_subtitles(ledger_path, node_root, plan,
        narration_plan_sha256=narration_sha, adapter_version=adapter,
        refetch=inputs.get("subtitle_refetch") is True, refetch_reason=inputs.get("subtitle_refetch_reason"))
    # 写新目录，不修改已经确认的声音或稿件。复制的音轨字节必须完全一致。
    target_track = output_dir / track.name
    _write_bytes_durably(target_track, audio_bytes)
    write_subtitle_sidecars(subtitles, output_dir)
    plan.update({"subtitles": subtitles, "track_path": str(target_track), "trackSha256": audio_sha,
        "subtitleRecovery": {"commandId": request["commandId"], "sourceOperationId": operation_id,
            "sourcePlanSha256": inputs["voiceoverPlanSha256"]}})
    target = output_dir / "voiceover_plan.json"
    _write_json_durably(target, plan)
    artifacts = [describe_artifact(path=target_track, kind="voiceover", content_type="audio/mp4", request=request,
        license_note="Retained original narration bytes; no new synthesis."),
        describe_artifact(path=target, kind="voiceover_plan", content_type="application/json", request=request,
            license_note="Pure subtitle recovery; original narration retained."), *subtitle_artifacts(request, target, plan)]
    return success_response(request, output={"voiceoverPlanPath": str(target), "trackPath": str(target_track),
        "narrationMode": "continuous_groups", "subtitleStatus": subtitles["status"]}, artifacts=artifacts,
        started_at=started_at, diagnostics={"meteredAttemptCount": 0, "meteredFailedAttemptCount": 0,
            "actualCostCny": 0, "actualCostSource": "local_subtitle_recovery", "providerOutcomeKnown": True,
            "reusedVoiceOperationId": operation_id})


def minimax_failure_diagnostics(output_dir: Path, operation_id: str) -> Dict[str, Any]:
    ledger_path = output_dir.parent / ".voice-operations" / (
        hashlib.sha256(operation_id.encode("utf-8")).hexdigest() + ".json"
    )
    try:
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "meteredAttemptCount": 0,
            "meteredFailedAttemptCount": 0,
            "providerOutcomeKnown": False,
        }
    items = ledger.get("items") if isinstance(ledger, dict) else None
    if not isinstance(items, list):
        return {
            "meteredAttemptCount": 0,
            "meteredFailedAttemptCount": 0,
            "providerOutcomeKnown": False,
        }
    attempted_count = sum(
        isinstance(item, dict)
        and isinstance(item.get("stateHistory"), list)
        and "unknown" in item["stateHistory"]
        for item in items
    )
    failed_count = sum(isinstance(item, dict) and item.get("state") == "terminal_failed" for item in items)
    provider_outcome_known = all(
        isinstance(item, dict)
        and item.get("state") not in {"unknown", "submitted", "provider_succeeded"}
        for item in items
    )
    diagnostics: Dict[str, Any] = {
        "meteredAttemptCount": attempted_count,
        "meteredFailedAttemptCount": failed_count,
        "providerOutcomeKnown": provider_outcome_known,
    }
    actual_cost = ledger.get("actualCostCny")
    if provider_outcome_known:
        diagnostics["actualCostCny"] = round(float(actual_cost), 2) if isinstance(actual_cost, (int, float)) else 0
        diagnostics["actualCostSource"] = str(ledger.get("actualCostSource") or "configured_rate")
    return diagnostics


def render_video(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    script_path, executable_plan = materialize_executable_script(request["input"], output_dir)
    asset_plan_path = require_existing_path(request["input"], "assetPlanPath")
    voiceover_plan_path = require_existing_path(request["input"], "voiceoverPlanPath")
    if executable_plan is not None:
        try:
            asset_plan = json.loads(asset_plan_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise WorkerProtocolError(f"Asset plan is not valid JSON: {error}") from error
        assert_asset_plan_matches_executable_plan(asset_plan, executable_plan)
    resolution = str(request.get("parameters", {}).get("resolution", "1080x1920"))
    manifest_path = render_job_manifest(
        job_id=1,
        script_path=script_path,
        workspace=output_dir,
        require_assets=True,
        asset_plan_path=asset_plan_path,
        voiceover_plan_path=voiceover_plan_path,
        resolution=resolution,
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    video_path = Path(manifest["output_file"])
    artifacts = [
        describe_artifact(
            path=video_path,
            kind="render",
            content_type="video/mp4",
            request=request,
            license_note="Composite output; see the linked asset and voiceover plans for source terms.",
        ),
        describe_artifact(
            path=manifest_path,
            kind="render_manifest",
            content_type="application/json",
            request=request,
            license_note="VideoFactory render metadata.",
        ),
    ]
    return success_response(
        request,
        output={"videoPath": str(video_path), "renderManifestPath": str(manifest_path),
            **render_subtitle_summary(manifest, voiceover_plan_path)},
        artifacts=artifacts,
        started_at=started_at,
    )


def render_subtitle_summary(manifest: dict, voiceover_plan_path: Path) -> dict:
    """仅投影已核对的字幕摘要，浏览器用登记的产物URL，不接收本地路径。"""
    plan = manifest.get("voiceover_plan") or {}
    subtitles = plan.get("subtitles") or {}
    result = {"subtitleStatus": subtitles.get("status", "unavailable"),
        "subtitleBurnStatus": (manifest.get("subtitle_burn") or {}).get("status", "not_burned")}
    if subtitles.get("status") != "verified":
        return result
    filename = (subtitles.get("sidecar") or {}).get("vtt")
    if not isinstance(filename, str):
        return result
    candidate = (voiceover_plan_path.parent / filename).resolve()
    try:
        if candidate.parent != voiceover_plan_path.parent.resolve():
            raise ValueError("Subtitle sidecar path is outside the voice version.")
        sha = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if sha != (subtitles.get("sidecarSha256") or {}).get("vtt"):
            raise ValueError("Subtitle sidecar content changed.")
        result["subtitleVttSha256"] = sha
    except (OSError, ValueError):
        result["subtitleStatus"] = "invalid_binding"
    return result


def run_technical_review(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    video_path = require_existing_path(request["input"], "videoPath")
    asset_plan_path = require_existing_path(request["input"], "assetPlanPath")
    script_path, _executable_plan = materialize_executable_script(request["input"], output_dir)
    parameters = request.get("parameters", {})
    review_path = review_video(
        video_path=video_path,
        script_path=script_path,
        asset_plan_path=asset_plan_path,
        output_path=output_dir / "technical_review.json",
        expected_width=int(parameters.get("expectedWidth", 1080)),
        expected_height=int(parameters.get("expectedHeight", 1920)),
        production=bool(parameters.get("production", True)),
    )
    report = json.loads(review_path.read_text(encoding="utf-8"))
    artifact = describe_artifact(
        path=review_path,
        kind="review_report",
        content_type="application/json",
        request=request,
        license_note="VideoFactory technical review result.",
    )
    response = success_response(
        request,
        output={"reviewPath": str(review_path), "passed": report["status"] == "passed"},
        artifacts=[artifact],
        started_at=started_at,
    )
    if report["status"] != "passed":
        response["status"] = "rejected"
    return response


def materialize_executable_script(
    input_payload: Dict[str, Any],
    output_dir: Path,
    formal_script_bytes: bytes | None = None,
) -> tuple[Path, Dict[str, Any] | None]:
    script_path = require_existing_path(input_payload, "scriptPath")
    executable_plan_value = input_payload.get("executablePlanPath")
    if executable_plan_value is None:
        return script_path, None
    executable_plan_path = require_existing_path(input_payload, "executablePlanPath")
    try:
        script = json.loads((formal_script_bytes if formal_script_bytes is not None else script_path.read_bytes()).decode("utf-8"))
        executable_plan = json.loads(executable_plan_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise WorkerProtocolError(f"Executable production input is not valid JSON: {error}") from error
    if not isinstance(script, dict) or not isinstance(script.get("scenes"), list):
        raise WorkerProtocolError("Executable production script must contain scenes")
    timings = validate_executable_plan(executable_plan)
    scenes = script["scenes"]
    scene_by_position = {
        scene.get("position"): scene
        for scene in scenes
        if isinstance(scene, dict) and isinstance(scene.get("position"), int)
    }
    if len(scene_by_position) != len(scenes) or set(scene_by_position) != set(timings):
        raise WorkerProtocolError("Executable production plan scenes do not match the script")
    projected_scenes = []
    for scene in scenes:
        timing = timings[scene["position"]]
        projected_scenes.append({
            **scene,
            "duration": timing["duration_frames"] / 30,
            **timing,
        })
    projected = {
        **script,
        "duration_target": executable_plan["totalFrames"] / 30,
        "duration_range": executable_plan["durationRange"],
        "scenes": projected_scenes,
    }
    projected_path = output_dir / "executable_script.json"
    projected_path.write_text(json.dumps(projected, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return projected_path, executable_plan


def validate_executable_plan(value: Any) -> Dict[int, Dict[str, Any]]:
    if not isinstance(value, dict) or value.get("version") != "video-factory/executable-plan-v1":
        raise WorkerProtocolError("Unsupported executable production plan version")
    if (
        value.get("fps") != 30
        or not isinstance(value.get("totalFrames"), int)
        or isinstance(value.get("totalFrames"), bool)
        or value["totalFrames"] <= 0
    ):
        raise WorkerProtocolError("Executable production plan has invalid frame metadata")
    duration_range = value.get("durationRange")
    if not isinstance(duration_range, dict):
        raise WorkerProtocolError("Executable production plan has no duration range")
    min_seconds = duration_range.get("minSeconds")
    max_seconds = duration_range.get("maxSeconds")
    if (
        not isinstance(min_seconds, int)
        or isinstance(min_seconds, bool)
        or not isinstance(max_seconds, int)
        or isinstance(max_seconds, bool)
        or min_seconds < 20
        or max_seconds > 180
        or min_seconds > max_seconds
        or value["totalFrames"] < min_seconds * 30
        or value["totalFrames"] > max_seconds * 30
    ):
        raise WorkerProtocolError("Executable production plan has an invalid duration range")
    cuts = value.get("cuts")
    if not isinstance(cuts, list) or not cuts:
        raise WorkerProtocolError("Executable production plan has no cuts")
    timings: Dict[int, Dict[str, Any]] = {}
    next_start = 0
    for index, cut in enumerate(cuts):
        if not isinstance(cut, dict):
            raise WorkerProtocolError(f"Executable production cut {index + 1} is invalid")
        scene_position = cut.get("scenePosition")
        start_frame = cut.get("startFrame")
        duration_frames = cut.get("frameCount")
        source_in_frame = cut.get("sourceInFrame")
        asset_key = cut.get("assetKey")
        if (
            not isinstance(scene_position, int)
            or isinstance(scene_position, bool)
            or scene_position != index + 1
            or not isinstance(start_frame, int)
            or isinstance(start_frame, bool)
            or start_frame != next_start
            or not isinstance(duration_frames, int)
            or isinstance(duration_frames, bool)
            or duration_frames <= 0
            or not isinstance(source_in_frame, int)
            or isinstance(source_in_frame, bool)
            or source_in_frame < 0
            or not isinstance(asset_key, str)
            or not asset_key.strip()
        ):
            raise WorkerProtocolError(f"Executable production cut {index + 1} has invalid timing")
        timings[scene_position] = {
            "start_frame": start_frame,
            "duration_frames": duration_frames,
            "source_in_frame": source_in_frame,
            "asset_key": asset_key,
        }
        next_start += duration_frames
    if next_start != value["totalFrames"]:
        raise WorkerProtocolError("Executable production cuts do not equal totalFrames")
    return timings


def project_executable_timings_into_asset_plan(plan_path: Path, executable_plan: Dict[str, Any]) -> None:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    if not isinstance(plan, dict) or not isinstance(plan.get("scene_assets"), list):
        raise WorkerProtocolError("Asset plan must contain scene_assets")
    timings = validate_executable_plan(executable_plan)
    positions = set()
    for index, scene_asset in enumerate(plan["scene_assets"]):
        if not isinstance(scene_asset, dict) or not isinstance(scene_asset.get("scene_position"), int):
            raise WorkerProtocolError(f"Asset plan scene {index + 1} has no valid scene position")
        position = scene_asset["scene_position"]
        timing = timings.get(position)
        if timing is None or position in positions:
            raise WorkerProtocolError("Asset plan scenes do not match executable production cuts")
        positions.add(position)
        scene_asset.update({
            **timing,
            "duration": timing["duration_frames"] / 30,
        })
    if positions != set(timings):
        raise WorkerProtocolError("Asset plan scenes do not match executable production cuts")
    plan["duration_target"] = executable_plan["totalFrames"] / 30
    plan["duration_range"] = executable_plan["durationRange"]
    plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def assert_asset_plan_matches_executable_plan(
    asset_plan: Any,
    executable_plan: Dict[str, Any],
) -> None:
    if not isinstance(asset_plan, dict) or not isinstance(asset_plan.get("scene_assets"), list):
        raise WorkerProtocolError("Asset plan must contain scene_assets")
    timings = validate_executable_plan(executable_plan)
    seen_positions = set()
    for index, scene_asset in enumerate(asset_plan["scene_assets"]):
        if not isinstance(scene_asset, dict):
            raise WorkerProtocolError(f"Asset plan scene {index + 1} does not match executable production cuts")
        position = scene_asset.get("scene_position")
        if (not isinstance(position, int) or isinstance(position, bool)
                or position in seen_positions or position not in timings):
            raise WorkerProtocolError("Asset plan scenes do not match executable production cuts")
        seen_positions.add(position)
        timing = timings[position]
        if any(scene_asset.get(field) != timing[field] for field in (
            "duration_frames", "source_in_frame", "asset_key",
        )):
            raise WorkerProtocolError(
                f"Asset plan scene {position} does not match executable production cuts"
            )
    if seen_positions != set(timings):
        raise WorkerProtocolError("Asset plan scenes do not match executable production cuts")


def require_existing_path(input_payload: Dict[str, Any], field: str) -> Path:
    value = input_payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise WorkerProtocolError(f"Missing input.{field}")
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise WorkerProtocolError(f"input.{field} does not exist: {path}")
    return path


def require_brief(input_payload: Dict[str, Any]) -> Dict[str, Any]:
    brief = input_payload.get("brief")
    if not isinstance(brief, dict):
        raise WorkerProtocolError("script.draft requires input.brief")
    if brief.get("protocolVersion") != BRIEF_PROTOCOL_VERSION:
        raise WorkerProtocolError(
            f"Unsupported brief protocolVersion: {brief.get('protocolVersion')!r}; expected {BRIEF_PROTOCOL_VERSION}"
        )
    for field in ("title", "angle", "audience", "nicheSlug", "platform"):
        if not isinstance(brief.get(field), str) or not brief[field].strip():
            raise WorkerProtocolError(f"Brief is missing {field}")
    duration = brief.get("durationSeconds")
    if not isinstance(duration, int) or duration < 20 or duration > 180:
        raise WorkerProtocolError("Brief durationSeconds must be an integer between 20 and 180")
    return brief


def describe_artifact(
    path: Path,
    kind: str,
    content_type: str,
    request: Dict[str, Any],
    license_note: str,
    provider_id: str | None = None,
    source_url: str | None = None,
    creator: str | None = None,
    scene_position: int | None = None,
    creator_url: str | None = None,
    preview_url: str | None = None,
) -> Dict[str, Any]:
    content = path.read_bytes()
    return {
        "kind": kind,
        "uri": str(path.resolve()),
        "sha256": hashlib.sha256(content).hexdigest(),
        "sizeBytes": len(content),
        "contentType": content_type,
        "provenance": {
            "providerId": provider_id or str(request.get("parameters", {}).get("providerId", "unknown")),
            "producerNodeId": request["nodeRunId"],
            "attempt": request["attempt"],
            "licenseNote": license_note,
            **({"sourceUrl": source_url} if source_url else {}),
            **({"creator": creator} if creator else {}),
            **({"creatorUrl": creator_url} if creator_url else {}),
            **({"previewUrl": preview_url} if preview_url else {}),
            **({"scenePosition": scene_position} if scene_position else {}),
        },
    }


def scene_asset_provider_id(scene_asset: Dict[str, Any]) -> str:
    explicit = optional_string(scene_asset.get("provider_id"))
    if explicit:
        return explicit
    provider = str(scene_asset.get("provider") or "unknown")
    return {
        "local": "local-editorial-v1",
        "pexels": "pexels-stock-v1",
        "pixabay": "pixabay-stock-v1",
        "unsplash": "unsplash-stock-v1",
        "coverr": "coverr-stock-v1",
        "wikimedia": "wikimedia-stock-v1",
        "met": "met-stock-v1",
        "cleveland": "cleveland-stock-v1",
        "archive": "archive-stock-v1",
        "flickr": "flickr-stock-v1",
        "nasa": "nasa-stock-v1",
        "openverse": "openverse-stock-v1",
        "mock": "mock-stock-v1",
    }.get(provider, provider)


def media_content_type(path: Path) -> str:
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def optional_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def success_response(
    request: Dict[str, Any],
    output: Dict[str, Any],
    artifacts: list,
    started_at: float,
    diagnostics: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    return {
        "protocolVersion": WORKER_PROTOCOL_VERSION,
        "commandId": request["commandId"],
        "status": "succeeded",
        "output": output,
        "artifacts": artifacts,
        "diagnostics": {
            "durationMs": round((time.monotonic() - started_at) * 1000, 3),
            **(diagnostics or {}),
        },
    }


def safe_worker_failure(error: Exception) -> str:
    # 未受控的供应商异常可能含密钥、URL或用户原文；保留错误类型与阶段日志定位。
    kind = type(error).__name__
    if not kind.isidentifier() or len(kind) > 80:
        kind = "WorkerError"
    return f"媒体处理失败（{kind}），请查看本次任务对应的阶段诊断记录。"


def main() -> int:
    request: Dict[str, Any] = {}
    try:
        payload = sys.stdin.read()
        request = json.loads(payload)
        if not isinstance(request, dict):
            raise WorkerProtocolError("Worker request must be a JSON object")
        with diagnostic_context(request), diagnostic_span('worker.execute'):
            response = handle_request(request)
    except Exception as error:
        response = {
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "commandId": request.get("commandId") if isinstance(request, dict) else None,
            "status": "failed",
            "error": {
                "code": "WORKER_REQUEST_FAILED",
                "message": safe_worker_failure(error),
            },
            "artifacts": [],
        }
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
