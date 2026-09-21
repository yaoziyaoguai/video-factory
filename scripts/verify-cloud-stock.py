"""独立目录内逐源验证正式素材适配器；不启动生产任务、不购买素材。"""

import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from video_factory.stock_assets import (
    PROVIDER_KEY_ENV, inspect_open_stock_file, local_filename,
    materialize_candidate, search_stock_assets,
)


CASES = [
    ('pexels', 'image', 'mountain'), ('pexels', 'video', 'clouds'),
    ('pixabay', 'image', 'mountain'), ('pixabay', 'video', 'clouds'),
    ('unsplash', 'image', 'mountain'), ('coverr', 'video', 'clouds'),
    ('wikimedia', 'image', 'Shanghai skyline'), ('wikimedia', 'video', 'clouds'),
    ('met', 'image', 'Chinese painting'), ('nasa', 'image', 'PIA12235'),
    ('nasa', 'video', 'Mars helicopter first flight'),
    ('openverse', 'image', 'landscape'), ('cleveland', 'image', 'China'),
    ('archive', 'video', 'Cumulus Clouds'), ('flickr', 'image', 'mountain'),
]


def save(path, report):
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


def check_case(root, index):
    provider, media_type, query = CASES[index]
    target = root / f'{provider}-{media_type}'
    target.mkdir(exist_ok=False)
    evidence = target / 'evidence.json'
    started = time.monotonic()
    report = dict(provider=provider, media_type=media_type, query=query,
                  status='running', stage='configuration', paid_calls=0)
    try:
        key_name = PROVIDER_KEY_ENV.get(provider)
        if key_name and not os.environ.get(key_name, '').strip():
            report.update(status='missing_key', required_key=key_name)
            return
        report['stage'] = 'search'
        save(evidence, report)
        candidates = search_stock_assets(provider, query, media_type, limit=1)
        report.update(search_seconds=round(time.monotonic() - started, 3),
                      candidate_count=len(candidates))
        if not candidates:
            report['status'] = 'no_candidates'
            return
        candidate = candidates[0]
        report.update(stage='download', asset_id=candidate.asset_id,
                      source_url=candidate.source_url, creator=candidate.creator,
                      license_note=candidate.license_note)
        save(evidence, report)
        stage_start = time.monotonic()
        path = materialize_candidate(candidate, target / local_filename(1, candidate))
        report.update(download_seconds=round(time.monotonic() - stage_start, 3),
                      bytes=path.stat().st_size, stage='decode')
        save(evidence, report)
        inspect_open_stock_file(candidate, path)
        probe = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            '-show_entries', 'stream=codec_name,width,height:format=duration',
            '-of', 'json', str(path)], capture_output=True, text=True, check=True, timeout=20)
        report['probe'] = json.loads(probe.stdout)
        subprocess.run(['ffmpeg', '-v', 'error', '-threads', '1', '-protocol_whitelist',
            'file,pipe', '-i', str(path), '-frames:v', '3', '-f', 'null', '-'],
            capture_output=True, check=True, timeout=30)
        report.update(status='passed', stage='complete')
    except Exception as error:
        detail = str(error)
        for key_name in PROVIDER_KEY_ENV.values():
            key = os.environ.get(key_name)
            if key:
                detail = detail.replace(key, '[REDACTED]')
        report.update(status='failed', error_type=type(error).__name__, error=detail[:800])
    finally:
        report['elapsed_seconds'] = round(time.monotonic() - started, 3)
        save(evidence, report)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--case', type=int)
    args = parser.parse_args()
    root = args.output_dir.resolve()
    if args.case is not None:
        check_case(root, args.case)
        return
    root.mkdir(parents=True, exist_ok=False)
    os.environ['XDG_CACHE_HOME'] = str(root / 'cache')

    def run(index):
        provider, media_type, _ = CASES[index]
        path = root / f'{provider}-{media_type}' / 'evidence.json'
        try:
            result = subprocess.run([sys.executable, __file__, '--output-dir', str(root),
                '--case', str(index)], capture_output=True, timeout=180)
            if result.returncode:
                raise RuntimeError(f'Child exited {result.returncode}; output withheld for credential safety')
        except (subprocess.TimeoutExpired, RuntimeError) as error:
            report = json.loads(path.read_text()) if path.exists() else dict(provider=provider, media_type=media_type)
            report.update(status='harness_failed', error_type=type(error).__name__)
            path.parent.mkdir(parents=True, exist_ok=True)
            save(path, report)
        report = json.loads(path.read_text())
        print(json.dumps(report, ensure_ascii=False), flush=True)
        return report

    with ThreadPoolExecutor(max_workers=2) as pool:
        reports = list(pool.map(run, range(len(CASES))))
    save(root / 'summary.json', reports)
    if any(item['status'] != 'passed' for item in reports):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
