"""免费真实素材冒烟验证：查询、正式 worker 下载、来源持久化、ffprobe 与解码。"""

import argparse
import json
import subprocess
import time
from pathlib import Path

from video_factory.worker import WORKER_PROTOCOL_VERSION, handle_request
from video_factory.renderer import render_job_manifest


def probe_and_decode(target):
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", str(target),
    ], check=True, capture_output=True, text=True, timeout=30)
    subprocess.run([
        "ffmpeg", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(target), "-frames:v", "3", "-f", "null", "-",
    ], check=True, capture_output=True, text=True, timeout=30)
    return json.loads(probe.stdout)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--query", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--provider", choices=["wikimedia", "met", "nasa", "openverse", "cleveland", "archive"], default="wikimedia")
    parser.add_argument("--media-type", choices=["image", "video"], default="video")
    parser.add_argument("--render", action="store_true", help="使用正式 renderer 渲染 4 秒静音素材样片，不测试 TTS 或模型")
    args = parser.parse_args()
    root = args.output_dir.resolve()
    root.mkdir(parents=True, exist_ok=False)
    script = root / "script.json"
    script.write_text(json.dumps({"title": "免费素材接入验证", "duration_target": 4, "scenes": [{
        "position": 1, "duration": 4, "narration": "免费素材接入验证", "visual_strategy": "stock",
        "visual_prompt": args.query, "search_terms": [args.query],
    }]}, ensure_ascii=False), encoding="utf-8")
    started = time.monotonic()
    evidence = {"provider": args.provider, "media_type": args.media_type, "query": args.query,
                "paid_calls": 0, "status": "running", "stage": "search_and_download"}
    try:
        result = handle_request({
            "protocolVersion": WORKER_PROTOCOL_VERSION, "commandId": "stock-verification", "runId": "stock-verification",
            "nodeRunId": "assets", "attempt": 1, "capability": "asset.prepare", "outputDir": str(root / "worker"),
            "input": {"scriptPath": str(script)}, "parameters": {"provider": args.provider, "mediaType": args.media_type, "limit": 1},
        })
        evidence['worker'] = result
        media = next(item for item in result["artifacts"] if item["kind"] == "media_asset")
        target = media["uri"]
        evidence.update(stage='decode', media=target, bytes=Path(target).stat().st_size)
        evidence['ffprobe'] = probe_and_decode(target)
        evidence['decode'] = 'passed'
        if args.render:
            evidence['stage'] = 'render'
            manifest = render_job_manifest(1, script, root, require_assets=True,
                asset_plan_path=Path(result['output']['assetPlanPath']))
            rendered_manifest = json.loads(manifest.read_text())
            rendered = rendered_manifest['output_file']
            evidence['render'] = {'path': rendered, 'ffprobe': probe_and_decode(rendered),
                                  'image_processing': rendered_manifest.get('image_processing', []),
                                  'audio': 'silence; TTS not tested'}
        evidence['status'] = 'passed'
    except Exception as error:
        evidence.update(status='failed', error_type=type(error).__name__, error=str(error))
    finally:
        evidence['elapsed_seconds'] = round(time.monotonic() - started, 3)
        evidence_path = root / "evidence.json"
        evidence_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({'evidence': str(evidence_path), **{key: evidence.get(key) for key in
            ('provider', 'status', 'stage', 'elapsed_seconds', 'bytes', 'media', 'error')}}, ensure_ascii=False, indent=2))
    if evidence['status'] != 'passed':
        raise SystemExit(1)


if __name__ == "__main__":
    main()
