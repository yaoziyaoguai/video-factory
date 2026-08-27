"""Machine-readable media worker entrypoint."""

import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict

from .domain import Scene
from .script_service import draft_script_from_values, draft_to_dict
from .stock_assets import prepare_routed_scene_assets, prepare_scene_assets
from .technical_review import review_video
from .voiceover import synthesize_voiceover_plan
from .renderer import render_job_manifest


WORKER_PROTOCOL_VERSION = "video-factory/worker-v1"
BRIEF_PROTOCOL_VERSION = "video-factory/brief-v1"
SUPPORTED_CAPABILITIES = {
    "script.draft",
    "asset.prepare",
    "voice.synthesize",
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
    if capability == "voice.synthesize":
        return synthesize_voice(request, output_dir, started_at)
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
    script_path = require_existing_path(request["input"], "scriptPath")
    script = json.loads(script_path.read_text(encoding="utf-8"))
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
    parameters = request.get("parameters", {})
    provider = str(parameters.get("provider", "local"))
    if provider not in {"local", "pexels", "pixabay", "mock", "ai-router"}:
        raise WorkerProtocolError(f"Unsupported asset provider: {provider}")
    if provider == "ai-router":
        director_plan_path = require_existing_path(request["input"], "directorPlanPath")
        director_plan = json.loads(director_plan_path.read_text(encoding="utf-8"))
        plan_path = prepare_routed_scene_assets(
            job_id=1,
            scenes=scenes,
            workspace=output_dir,
            director_plan=director_plan,
            media_type=str(parameters.get("mediaType", "video")),
            limit=int(parameters.get("limit", 6)),
        )
    else:
        plan_path = prepare_scene_assets(
            job_id=1,
            scenes=scenes,
            workspace=output_dir,
            provider=provider,
            media_type=str(parameters.get("mediaType", "video")),
            limit=int(parameters.get("limit", 6)),
        )
    artifact = describe_artifact(
        path=plan_path,
        kind="asset_plan",
        content_type="application/json",
        request=request,
        license_note="License snapshot is stored per scene asset in this plan.",
    )
    return success_response(
        request,
        output={"assetPlanPath": str(plan_path)},
        artifacts=[artifact],
        started_at=started_at,
    )


def synthesize_voice(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    script_path = require_existing_path(request["input"], "scriptPath")
    parameters = request.get("parameters", {})
    provider = str(parameters.get("provider", "macos-say"))
    plan_path = synthesize_voiceover_plan(
        script_path=script_path,
        output_dir=output_dir,
        provider=provider,
        voice=str(parameters["voice"]) if parameters.get("voice") else None,
        rate=int(parameters.get("rate", 190)),
        profile_id=str(parameters["profileId"]) if parameters.get("profileId") else None,
        pause_scale=float(parameters.get("pauseScale", 1)),
        mastering_preset=str(parameters.get("masteringPreset", "natural")),
    )
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
    return success_response(
        request,
        output={
            "voiceoverPlanPath": str(plan_path),
            "trackPath": str(plan["track_path"]),
        },
        artifacts=artifacts,
        started_at=started_at,
    )


def render_video(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    script_path = require_existing_path(request["input"], "scriptPath")
    asset_plan_path = require_existing_path(request["input"], "assetPlanPath")
    voiceover_plan_path = require_existing_path(request["input"], "voiceoverPlanPath")
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
        output={"videoPath": str(video_path), "renderManifestPath": str(manifest_path)},
        artifacts=artifacts,
        started_at=started_at,
    )


def run_technical_review(request: Dict[str, Any], output_dir: Path, started_at: float) -> Dict[str, Any]:
    video_path = require_existing_path(request["input"], "videoPath")
    asset_plan_path = require_existing_path(request["input"], "assetPlanPath")
    script_path = require_existing_path(request["input"], "scriptPath")
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
) -> Dict[str, Any]:
    content = path.read_bytes()
    return {
        "kind": kind,
        "uri": str(path.resolve()),
        "sha256": hashlib.sha256(content).hexdigest(),
        "sizeBytes": len(content),
        "contentType": content_type,
        "provenance": {
            "providerId": str(request.get("parameters", {}).get("providerId", "unknown")),
            "producerNodeId": request["nodeRunId"],
            "attempt": request["attempt"],
            "licenseNote": license_note,
        },
    }


def success_response(
    request: Dict[str, Any],
    output: Dict[str, Any],
    artifacts: list,
    started_at: float,
) -> Dict[str, Any]:
    return {
        "protocolVersion": WORKER_PROTOCOL_VERSION,
        "commandId": request["commandId"],
        "status": "succeeded",
        "output": output,
        "artifacts": artifacts,
        "diagnostics": {"durationMs": round((time.monotonic() - started_at) * 1000, 3)},
    }


def main() -> int:
    request: Dict[str, Any] = {}
    try:
        payload = sys.stdin.read()
        request = json.loads(payload)
        if not isinstance(request, dict):
            raise WorkerProtocolError("Worker request must be a JSON object")
        response = handle_request(request)
    except Exception as error:
        response = {
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "commandId": request.get("commandId") if isinstance(request, dict) else None,
            "status": "failed",
            "error": {
                "code": "WORKER_REQUEST_FAILED",
                "message": str(error),
            },
            "artifacts": [],
        }
    sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
