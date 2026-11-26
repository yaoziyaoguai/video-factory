#!/usr/bin/env python3
"""Remote Colab GPU worker & warm batch daemon for Lightricks/LTX-2.5 Distilled (~5s MP4).

Capabilities:
1. Strict `.safetensors` binary header + byte-length verification (`verify_safetensors_integrity`)
   plus `cache_manifest.json` model revision/commit pinning across all 5 LTX-2.5 weight files.
2. Eliminates duplicate downloads by writing directly into `cache_dir` and purging transient
   HuggingFace / Xet staging chunks immediately after each weight file.
3. Records granular per-stage timings (`envSetupMs`, `weightFetchMs`, `modelLoadMs`,
   `inferenceMs`, `encodeTransferMs`), `cacheSource` (`drive_cache`, `ephemeral_warm`,
   `ephemeral_download`, `warm_memory`), `gpu_name`, `vram_gb`, and `model_revision`.
4. Supports both single-shot execution (`LTX_JOB_CONFIG_FILE`) and persistent in-memory
   multi-shot batch daemon mode (`--batch-daemon /content/batch_daemons/<batch_id>`) so multiple
   approved shots in the same Frame `runId` reuse the loaded model in memory without reloading
   ~64 GiB of weights, while keeping per-shot `/content/jobs/<attempt_id>/status.json` + `output.mp4`
   individually recoverable.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import pathlib
import shutil
import struct
import subprocess
import sys
import threading
import time
import traceback
from typing import Any

LTX25_REPO_ID = "Lightricks/LTX-2.5"
DEFAULT_MODEL_REVISION = "main"
LTX2_CODE_REPO = "https://github.com/Lightricks/LTX-2.git"
MAX_SAFETENSORS_HEADER_BYTES = 64 * 1024 * 1024


class SafetensorsIntegrityError(ValueError):
    """Raised when a cached or downloaded `.safetensors` file is truncated or corrupt."""


def verify_safetensors_integrity(
    path: pathlib.Path,
    *,
    expected_size: int | None = None,
    expected_header_sha256: str | None = None,
) -> dict[str, Any]:
    """Validate `.safetensors` 8-byte header length, JSON tensor table, and exact byte length.

    Catches truncated downloads, partial Drive syncs, and corrupted headers in <5ms without
    having to read tens of gigabytes of payload bytes from FUSE/disk.
    """
    if not path.is_file():
        raise SafetensorsIntegrityError(f"Weight file missing: {path}")
    actual_size = path.stat().st_size
    if actual_size < 16:
        raise SafetensorsIntegrityError(f"Weight file too small ({actual_size} bytes): {path}")
    if expected_size is not None and actual_size != expected_size:
        raise SafetensorsIntegrityError(
            f"Weight file size mismatch for {path.name}: expected {expected_size}, got {actual_size}"
        )

    with path.open("rb") as handle:
        len_raw = handle.read(8)
        if len(len_raw) != 8:
            raise SafetensorsIntegrityError(f"Unable to read 8-byte safetensors header length: {path}")
        (header_len,) = struct.unpack("<Q", len_raw)
        if header_len < 2 or header_len > MAX_SAFETENSORS_HEADER_BYTES:
            raise SafetensorsIntegrityError(
                f"Invalid safetensors header length {header_len} in {path.name}"
            )
        if 8 + header_len > actual_size:
            raise SafetensorsIntegrityError(
                f"Truncated safetensors header in {path.name}: 8 + {header_len} > {actual_size}"
            )
        header_bytes = handle.read(header_len)
        if len(header_bytes) != header_len:
            raise SafetensorsIntegrityError(f"Short read on safetensors header in {path.name}")

    header_sha256 = hashlib.sha256(header_bytes).hexdigest()
    if expected_header_sha256 and header_sha256 != expected_header_sha256:
        raise SafetensorsIntegrityError(
            f"Safetensors header digest mismatch in {path.name}: "
            f"expected {expected_header_sha256}, got {header_sha256}"
        )

    try:
        header = json.loads(header_bytes.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise SafetensorsIntegrityError(f"Corrupt safetensors JSON header in {path.name}: {exc}") from exc
    if not isinstance(header, dict):
        raise SafetensorsIntegrityError(f"Safetensors header root must be an object in {path.name}")

    tensor_count = 0
    max_end = 0
    for key, entry in header.items():
        if key == "__metadata__":
            if not isinstance(entry, dict):
                raise SafetensorsIntegrityError(f"Invalid __metadata__ section in {path.name}")
            continue
        if not isinstance(entry, dict):
            raise SafetensorsIntegrityError(f"Invalid tensor descriptor for {key!r} in {path.name}")
        offsets = entry.get("data_offsets")
        shape = entry.get("shape")
        dtype = entry.get("dtype")
        if (
            not isinstance(dtype, str)
            or not dtype
            or not isinstance(shape, list)
            or not isinstance(offsets, list)
            or len(offsets) != 2
        ):
            raise SafetensorsIntegrityError(f"Malformed tensor fields for {key!r} in {path.name}")
        start, end = offsets
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end < start:
            raise SafetensorsIntegrityError(
                f"Invalid tensor data_offsets [{start}, {end}] for {key!r} in {path.name}"
            )
        if end > max_end:
            max_end = end
        tensor_count += 1

    if tensor_count == 0:
        raise SafetensorsIntegrityError(f"Safetensors file contains zero tensors: {path.name}")

    expected_file_bytes = 8 + header_len + max_end
    if actual_size != expected_file_bytes:
        raise SafetensorsIntegrityError(
            f"Truncated or padded safetensors payload in {path.name}: "
            f"actual={actual_size}, expected={expected_file_bytes} (8 + {header_len} + {max_end})"
        )

    return {
        "size_bytes": actual_size,
        "header_len": header_len,
        "header_sha256": header_sha256,
        "tensor_count": tensor_count,
        "metadata": header.get("__metadata__") or {},
    }


def required_ltx25_files(vae_variant: str = "conv") -> dict[str, str]:
    vae_file = (
        "vae/ltx-2.5-video-vae-bf16.safetensors"
        if vae_variant == "diff"
        else "vae/ltx-2.5-video-vae-conv-bf16.safetensors"
    )
    return {
        "transformer": "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
        "text_encoder": "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
        "video_vae": vae_file,
        "audio_vae": "vae/ltx-2.5-audio-vae-bf16.safetensors",
        "spatial_upsampler": "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
    }


def write_json_atomic(path: pathlib.Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp.{os.getpid()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def write_status(job_dir: pathlib.Path, state: str, **extra: object) -> None:
    write_json_atomic(job_dir / "status.json", {"state": state, "updated_at": time.time(), **extra})


def start_heartbeat(label: str, interval_s: float = 10.0) -> tuple[threading.Event, threading.Thread]:
    stop_event = threading.Event()
    started = time.monotonic()

    def _beat() -> None:
        while not stop_event.wait(interval_s):
            elapsed = int(time.monotonic() - started)
            print(f"[ltx25-worker] heartbeat ({label}) elapsed={elapsed}s", flush=True)

    thread = threading.Thread(target=_beat, daemon=True)
    thread.start()
    return stop_event, thread


def run_cmd(cmd: list[str], *, cwd: pathlib.Path | None = None, env: dict[str, str] | None = None) -> None:
    print(f"[ltx25-worker] $ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, check=True)


def snap_causal_frames(duration_sec: float, fps: float) -> int:
    raw = max(9, round(duration_sec * fps))
    k = max(1, round((raw - 1) / 8))
    return 8 * k + 1


def host_mem_available_gib() -> float:
    try:
        for line in pathlib.Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("MemAvailable:"):
                kb = int(line.split()[1])
                return round(kb / (1024 * 1024), 2)
    except Exception:
        pass
    return 0.0


def ensure_ltx_pipelines_installed(work_root: pathlib.Path, env: dict[str, str]) -> tuple[dict[str, str], str]:
    repo_dir = work_root / "LTX-2"
    if not (repo_dir / "packages" / "ltx-pipelines").is_dir():
        run_cmd(
            ["git", "clone", "--depth", "1", LTX2_CODE_REPO, str(repo_dir)],
            env=env,
        )
    code_commit = "unknown"
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short=12", "HEAD"], cwd=str(repo_dir), text=True
        ).strip()
        if out:
            code_commit = out
    except Exception:
        pass

    marker = repo_dir / ".installed_ltx25"
    if not marker.exists():
        run_cmd(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--no-cache-dir",
                "-q",
                "huggingface_hub>=0.26",
                "transformers>=5.8.0,<5.15",
                "safetensors",
                "accelerate",
                "einops",
                "colour-science",
                "scipy>=1.14",
                "av",
                "tqdm",
                "pillow",
                "openimageio",
                "cloudpickle>=3.1",
            ],
            env=env,
        )
        marker.write_text(f"ok:{code_commit}\n", encoding="utf-8")

    src_paths = [
        str(repo_dir / "packages" / "ltx-core" / "src"),
        str(repo_dir / "packages" / "ltx-pipelines" / "src"),
    ]
    for p in reversed(src_paths):
        if p not in sys.path:
            sys.path.insert(0, p)
    existing_py = env.get("PYTHONPATH", "")
    merged_py = ":".join(src_paths + ([existing_py] if existing_py else []))
    return {**env, "PYTHONPATH": merged_py}, code_commit


def _is_commit_sha(rev: str) -> bool:
    return len(rev) == 40 and all(c in "0123456789abcdef" for c in rev.lower())


def verify_or_download_ltx25_weights(
    cache_dir: pathlib.Path,
    *,
    vae_variant: str = "conv",
    model_revision: str = DEFAULT_MODEL_REVISION,
    hf_token: str | None = None,
    downloader: Any | None = None,
    revision_resolver: Any | None = None,
) -> tuple[dict[str, pathlib.Path], dict[str, Any]]:
    """Verify all 5 required `.safetensors` files against `cache_manifest.json` or download cleanly.

    Returns `(weights_map, cache_report)` where `cache_report` includes `cache_source`,
    `resolved_revision`, `downloaded_files`, and `verified_files`.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = cache_dir / "cache_manifest.json"
    manifest: dict[str, Any] = {}
    if manifest_path.is_file():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest = loaded
        except ValueError:
            manifest = {}

    requested_rev = (model_revision or DEFAULT_MODEL_REVISION).strip() or DEFAULT_MODEL_REVISION
    resolved_rev = requested_rev
    if revision_resolver is not None:
        resolved_rev = str(revision_resolver(LTX25_REPO_ID, requested_rev, hf_token) or requested_rev)
    elif not _is_commit_sha(requested_rev):
        try:
            from huggingface_hub import HfApi

            info = HfApi(token=hf_token or None).model_info(LTX25_REPO_ID, revision=requested_rev)
            if getattr(info, "sha", None):
                resolved_rev = str(info.sha)
        except Exception:
            if manifest.get("requested_revision") == requested_rev and manifest.get("resolved_revision"):
                resolved_rev = str(manifest["resolved_revision"])

    previous_rev = str(manifest.get("resolved_revision") or "")
    version_mismatch = bool(
        previous_rev
        and resolved_rev
        and _is_commit_sha(previous_rev)
        and _is_commit_sha(resolved_rev)
        and previous_rev != resolved_rev
    )
    manifest_files = manifest.get("files") if isinstance(manifest.get("files"), dict) else {}
    if version_mismatch:
        print(
            f"[ltx25-worker] Model revision changed ({previous_rev[:12]} -> {resolved_rev[:12]}); invalidating stale weights.",
            flush=True,
        )
        manifest_files = {}

    xet_tmp = cache_dir / ".xet_tmp"
    os.environ["HF_XET_CACHE"] = str(xet_tmp)

    required = required_ltx25_files(vae_variant)
    resolved_paths: dict[str, pathlib.Path] = {}
    updated_files: dict[str, Any] = dict(manifest_files)
    downloaded_keys: list[str] = []
    reused_keys: list[str] = []

    for key, rel_path in required.items():
        local_target = cache_dir / rel_path
        prev_entry = updated_files.get(rel_path) if isinstance(updated_files.get(rel_path), dict) else {}

        if local_target.is_file() and not version_mismatch:
            try:
                facts = verify_safetensors_integrity(
                    local_target,
                    expected_size=prev_entry.get("size_bytes"),
                    expected_header_sha256=prev_entry.get("header_sha256"),
                )
                print(
                    f"[ltx25-worker] Verified cached {rel_path} ({facts['size_bytes']} bytes, {facts['tensor_count']} tensors)",
                    flush=True,
                )
                updated_files[rel_path] = {
                    "size_bytes": facts["size_bytes"],
                    "header_sha256": facts["header_sha256"],
                    "tensor_count": facts["tensor_count"],
                    "verified_at": time.time(),
                }
                resolved_paths[key] = local_target
                reused_keys.append(rel_path)
                continue
            except SafetensorsIntegrityError as exc:
                print(
                    f"[ltx25-worker] Quarantining corrupt/truncated cached weight {rel_path}: {exc}",
                    flush=True,
                )
                local_target.unlink(missing_ok=True)

        if version_mismatch and local_target.is_file():
            local_target.unlink(missing_ok=True)

        print(
            f"[ltx25-worker] Downloading {LTX25_REPO_ID}@{resolved_rev[:12]} :: {rel_path} ...",
            flush=True,
        )
        if downloader is not None:
            fetched = pathlib.Path(
                downloader(
                    repo_id=LTX25_REPO_ID,
                    filename=rel_path,
                    revision=resolved_rev,
                    local_dir=cache_dir,
                    token=hf_token or None,
                )
            )
        else:
            from huggingface_hub import hf_hub_download

            fetched = pathlib.Path(
                hf_hub_download(
                    repo_id=LTX25_REPO_ID,
                    filename=rel_path,
                    revision=resolved_rev,
                    local_dir=str(cache_dir),
                    token=hf_token or None,
                )
            )
        # Immediately purge staging chunks to prevent duplicate disk consumption on 74 GiB Colab disks
        shutil.rmtree(xet_tmp, ignore_errors=True)
        shutil.rmtree(cache_dir / ".cache", ignore_errors=True)

        facts = verify_safetensors_integrity(fetched)
        updated_files[rel_path] = {
            "size_bytes": facts["size_bytes"],
            "header_sha256": facts["header_sha256"],
            "tensor_count": facts["tensor_count"],
            "verified_at": time.time(),
        }
        resolved_paths[key] = fetched
        downloaded_keys.append(rel_path)

    new_manifest = {
        "repo_id": LTX25_REPO_ID,
        "requested_revision": requested_rev,
        "resolved_revision": resolved_rev,
        "vae_variant": vae_variant,
        "updated_at": time.time(),
        "files": updated_files,
    }
    write_json_atomic(manifest_path, new_manifest)

    if downloaded_keys:
        cache_source = "ephemeral_download"
    elif str(cache_dir).startswith("/content/drive"):
        cache_source = "drive_cache"
    else:
        cache_source = "ephemeral_warm"

    return resolved_paths, {
        "cache_source": cache_source,
        "model_revision": f"{LTX25_REPO_ID}@{resolved_rev}",
        "resolved_revision": resolved_rev,
        "downloaded_count": len(downloaded_keys),
        "reused_count": len(reused_keys),
        "downloaded_files": downloaded_keys,
    }


def enable_pre_ampere_shim_if_needed() -> bool:
    import torch
    import torch.nn.functional as F

    if not (torch.cuda.is_available() and torch.cuda.get_device_capability(0) < (8, 0)):
        return False
    if getattr(F.linear, "_ltx25_pre_ampere_patched", False):
        return True

    print(
        "[ltx25-worker] Pre-Ampere GPU detected (SM < 8.0); enabling scaled-FP16 Tensor Core linear + Cutlass SDPA shim",
        flush=True,
    )
    _orig_linear = F.linear

    def _scaled_fp16_linear(inp: Any, weight: Any, bias: Any = None) -> Any:
        if inp.is_cuda and inp.dtype == torch.bfloat16 and weight.dtype == torch.bfloat16:
            x_s = (inp.detach().abs().amax() / 1024.0).clamp(min=1.0)
            w_s = (weight.detach().abs().amax() / 1024.0).clamp(min=1.0)
            out = _orig_linear((inp / x_s).to(torch.float16), (weight / w_s).to(torch.float16), None)
            res = out.to(torch.bfloat16) * (x_s * w_s).to(torch.bfloat16)
            return res + bias if bias is not None else res
        return _orig_linear(inp, weight, bias)

    _scaled_fp16_linear._ltx25_pre_ampere_patched = True  # type: ignore[attr-defined]
    F.linear = _scaled_fp16_linear

    from torch.nn.attention import SDPBackend, sdpa_kernel
    from ltx_core.model.transformer import attention as _ltx_attn

    _orig_attn_call = _ltx_attn.PytorchAttention.__call__

    def _fp16_cutlass_sdpa(self: Any, q: Any, k: Any, v: Any, heads: int, mask: Any = None) -> Any:
        if q.is_cuda and q.dtype == torch.bfloat16:
            b, _, dim_head = q.shape
            dim_head //= heads
            qh, kh, vh = (t.view(b, -1, heads, dim_head).transpose(1, 2) for t in (q, k, v))
            if mask is not None:
                if mask.ndim == 2:
                    mask = mask.unsqueeze(0)
                if mask.ndim == 3:
                    mask = mask.unsqueeze(1)
                if mask.is_floating_point():
                    mask = mask.clamp(-65504.0, 65504.0).to(torch.float16)
            v_s = (vh.detach().abs().amax(dim=(-2, -1), keepdim=True) / 1024.0).clamp(min=1.0)
            qh16 = qh.clamp(-65504.0, 65504.0).to(torch.float16)
            kh16 = kh.clamp(-65504.0, 65504.0).to(torch.float16)
            vh16 = (vh / v_s).to(torch.float16)
            with sdpa_kernel([SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH], set_priority=True):
                out16 = F.scaled_dot_product_attention(
                    qh16, kh16, vh16, attn_mask=mask, dropout_p=0.0, is_causal=False
                )
            return (out16.to(q.dtype) * v_s.to(q.dtype)).transpose(1, 2).reshape(b, -1, heads * dim_head)
        return _orig_attn_call(self, q, k, v, heads, mask=mask)

    _ltx_attn.PytorchAttention.__call__ = _fp16_cutlass_sdpa
    return True


def write_subprocess_launcher(work_root: pathlib.Path) -> pathlib.Path:
    launcher = work_root / "run_distilled_entry.py"
    launcher.write_text(
        """import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from ltx25_worker_shim import boot_and_run
boot_and_run()
""",
        encoding="utf-8",
    )
    shim = work_root / "ltx25_worker_shim.py"
    this_file = pathlib.Path(__file__).resolve()
    shim.write_text(
        f"""import importlib.util
spec = importlib.util.spec_from_file_location("ltx25_remote_worker", {str(this_file)!r})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

def boot_and_run():
    mod.enable_pre_ampere_shim_if_needed()
    from ltx_pipelines.distilled import main
    main()
""",
        encoding="utf-8",
    )
    return launcher


def finalize_dimensions(
    raw_mp4: pathlib.Path,
    final_mp4: pathlib.Path,
    target_w: int,
    target_h: int,
    *,
    duration_sec: float | None = None,
    fps: float = 24.0,
    mute_audio: bool = False,
) -> None:
    """Normalize LTX-2.5 output to exact target pixels, frame rate, and duration."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or (target_w <= 0 or target_h <= 0):
        shutil.copyfile(raw_mp4, final_mp4)
        return
    vf = (
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
        f"crop={target_w}:{target_h},setsar=1"
    )
    cmd = [
        ffmpeg,
        "-y",
        "-i",
        str(raw_mp4),
        "-vf",
        vf,
        "-r",
        f"{fps:g}",
    ]
    if duration_sec and duration_sec > 0:
        cmd.extend(["-t", f"{duration_sec:g}"])
    cmd.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"])
    if mute_audio:
        cmd.append("-an")
    else:
        cmd.extend(["-c:a", "aac", "-b:a", "192k"])
    cmd.extend(["-movflags", "+faststart", str(final_mp4)])
    run_cmd(cmd)


class LTX25Engine:
    """Manages LTX-2.5 environment, weight cache verification, and warm in-memory pipeline reuse."""

    def __init__(self, base_cfg: dict[str, Any], env: dict[str, str]) -> None:
        self.base_cfg = dict(base_cfg)
        self.env = {**env, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
        self.work_root = pathlib.Path(str(base_cfg.get("work_root") or "/content/ltx25-workspace"))
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.gpu_name = "CPU"
        self.vram_gb = 0.0
        self.code_commit = "unknown"
        self.weights: dict[str, pathlib.Path] = {}
        self.cache_report: dict[str, Any] = {}
        self.env_setup_ms = 0
        self.weight_fetch_ms = 0
        self.model_load_ms = 0
        self.in_memory_pipeline: Any = None
        self.offload_mode = "auto"
        self.quant_mode = "fp8-cast"
        self.shots_executed = 0

    def initialize(self) -> None:
        mock_mp4 = self.base_cfg.get("mock_inference_mp4")
        if mock_mp4:
            self.gpu_name = str(self.base_cfg.get("mock_gpu_name") or "Simulated-GPU")
            self.vram_gb = float(self.base_cfg.get("mock_vram_gb") or 24.0)
            cache_dir = pathlib.Path(str(self.base_cfg["cache_dir"]))
            t_fetch = time.monotonic()
            if (cache_dir / "cache_manifest.json").is_file():
                self.weights, self.cache_report = verify_or_download_ltx25_weights(
                    cache_dir,
                    vae_variant=str(self.base_cfg.get("vae_variant") or "conv"),
                    model_revision=str(self.base_cfg.get("model_revision") or DEFAULT_MODEL_REVISION),
                )
            else:
                self.cache_report = {
                    "cache_source": "ephemeral_warm",
                    "model_revision": f"{LTX25_REPO_ID}@{self.base_cfg.get('model_revision') or 'mock'}",
                }
            self.weight_fetch_ms = int(round((time.monotonic() - t_fetch) * 1000))
            self.model_load_ms = int(self.base_cfg.get("mock_model_load_ms") or 25)
            self.in_memory_pipeline = ("mock", pathlib.Path(str(mock_mp4)))
            return

        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU is not available in this Colab runtime.")
        self.gpu_name = torch.cuda.get_device_name(0)
        self.vram_gb = round(torch.cuda.get_device_properties(0).total_memory / (1024**3), 2)
        print(f"[ltx25-worker] GPU={self.gpu_name} VRAM={self.vram_gb}GiB", flush=True)

        t_env = time.monotonic()
        self.env, self.code_commit = ensure_ltx_pipelines_installed(self.work_root, self.env)
        self.env_setup_ms = int(round((time.monotonic() - t_env) * 1000))

        cache_dir = pathlib.Path(str(self.base_cfg["cache_dir"]))
        t_fetch = time.monotonic()
        self.weights, self.cache_report = verify_or_download_ltx25_weights(
            cache_dir,
            vae_variant=str(self.base_cfg.get("vae_variant") or "conv"),
            model_revision=str(self.base_cfg.get("model_revision") or DEFAULT_MODEL_REVISION),
            hf_token=self.env.get("HF_TOKEN"),
        )
        self.weight_fetch_ms = int(round((time.monotonic() - t_fetch) * 1000))

        avail_ram_gib = host_mem_available_gib()
        offload = str(self.base_cfg.get("offload") or "auto")
        if offload == "auto":
            if self.vram_gb >= 75.0:
                offload = "none"
            elif avail_ram_gib >= 32.0:
                offload = "cpu"
            else:
                offload = "disk"
        quant = str(self.base_cfg.get("quantization") or "fp8-cast")
        if offload == "disk" and quant == "fp8-cast":
            quant = "none"
        self.offload_mode = offload
        self.quant_mode = quant
        print(
            f"[ltx25-worker] memory strategy: offload={self.offload_mode}, quantization={self.quant_mode}",
            flush=True,
        )

        # Attempt in-process warm pipeline instantiation for multi-shot reuse
        t_load = time.monotonic()
        enable_pre_ampere_shim_if_needed()
        try:
            from ltx_pipelines import distilled as ltx_distilled

            cls = getattr(ltx_distilled, "DistilledPipeline", None)
            if cls is not None:
                sig = inspect.signature(cls.__init__)
                kwargs: dict[str, Any] = {}
                param_map = {
                    "transformer_path": str(self.weights["transformer"]),
                    "checkpoint_path": str(self.weights["transformer"]),
                    "text_encoder_path": str(self.weights["text_encoder"]),
                    "gemma_root": str(self.weights["text_encoder"]),
                    "video_vae_path": str(self.weights["video_vae"]),
                    "audio_vae_path": str(self.weights["audio_vae"]),
                    "spatial_upsampler_path": str(self.weights["spatial_upsampler"]),
                }
                for p_name in sig.parameters:
                    if p_name == "self":
                        continue
                    if p_name in param_map:
                        kwargs[p_name] = param_map[p_name]
                    elif p_name == "quantization" and self.quant_mode != "none":
                        kwargs[p_name] = self.quant_mode
                    elif p_name == "offload" and self.offload_mode != "none":
                        kwargs[p_name] = self.offload_mode
                if "transformer_path" in kwargs or "checkpoint_path" in kwargs:
                    self.in_memory_pipeline = ("distilled_cls", cls(**kwargs))
                    self.model_load_ms = int(round((time.monotonic() - t_load) * 1000))
                    print(
                        f"[ltx25-worker] Loaded DistilledPipeline in memory in {self.model_load_ms}ms",
                        flush=True,
                    )
        except Exception as exc:
            print(
                f"[ltx25-worker] In-process DistilledPipeline init unavailable ({exc}); will use CLI entrypoint.",
                flush=True,
            )
            self.in_memory_pipeline = None

    def run_shot(self, cfg: dict[str, Any]) -> dict[str, Any]:
        job_dir = pathlib.Path(str(cfg["remote_job_dir"]))
        final_mp4 = job_dir / "output.mp4"
        meta_file = job_dir / "meta.json"
        raw_mp4 = job_dir / "raw_ltx25.mp4"

        if final_mp4.is_file() and final_mp4.stat().st_size > 1024:
            if meta_file.is_file():
                meta = json.loads(meta_file.read_text(encoding="utf-8"))
            else:
                meta = {"task_id": cfg["task_id"], "output_bytes": final_mp4.stat().st_size}
            write_status(job_dir, "succeeded", output=str(final_mp4), meta=meta)
            return meta

        is_warm_shot = self.shots_executed > 0 and self.in_memory_pipeline is not None
        started = time.time()
        write_status(
            job_dir,
            "running",
            pid=os.getpid(),
            started_at=started,
            warm_reuse=is_warm_shot,
        )

        gen_width = int(cfg["gen_width"])
        gen_height = int(cfg["gen_height"])
        num_frames = int(cfg["num_frames"])
        fps = float(cfg["fps"])
        seed = int(cfg["seed"])

        t_infer = time.monotonic()
        shot_model_load_ms = 0 if is_warm_shot else self.model_load_ms

        if self.in_memory_pipeline and self.in_memory_pipeline[0] == "mock":
            src_mp4: pathlib.Path = self.in_memory_pipeline[1]
            time.sleep(float(cfg.get("mock_infer_sleep_sec") or 0.02))
            shutil.copyfile(src_mp4, raw_mp4)
        elif self.in_memory_pipeline and self.in_memory_pipeline[0] == "distilled_cls":
            pipe_obj = self.in_memory_pipeline[1]
            call_sig = inspect.signature(pipe_obj.__call__)
            call_kwargs: dict[str, Any] = {}
            first_frame = cfg.get("remote_first_frame")
            candidate_args = {
                "prompt": str(cfg["prompt"]),
                "width": gen_width,
                "height": gen_height,
                "num_frames": num_frames,
                "frame_rate": fps,
                "fps": fps,
                "seed": seed,
                "output_path": str(raw_mp4),
                "enhance_prompt": bool(cfg.get("enhance_prompt", False)),
                "images": [(str(first_frame), 0, float(cfg.get("image_strength", 1.0)))]
                if first_frame
                else [],
            }
            for k, v in candidate_args.items():
                if k in call_sig.parameters:
                    call_kwargs[k] = v
            result = pipe_obj(**call_kwargs)
            if not raw_mp4.is_file() and isinstance(result, (str, pathlib.Path)):
                shutil.copyfile(result, raw_mp4)
            if not raw_mp4.is_file():
                # Fallback to CLI entrypoint if __call__ returned raw tensors without saving
                self.in_memory_pipeline = None

        if self.in_memory_pipeline is None:
            launcher = write_subprocess_launcher(self.work_root)
            cmd = [
                sys.executable,
                str(launcher),
                "--transformer-path",
                str(self.weights["transformer"]),
                "--text-encoder-path",
                str(self.weights["text_encoder"]),
                "--video-vae-path",
                str(self.weights["video_vae"]),
                "--audio-vae-path",
                str(self.weights["audio_vae"]),
                "--spatial-upsampler-path",
                str(self.weights["spatial_upsampler"]),
                *(
                    ["--image", str(cfg["remote_first_frame"]), "0", str(cfg.get("image_strength", 1.0))]
                    if cfg.get("remote_first_frame")
                    else []
                ),
                "--prompt",
                str(cfg["prompt"]),
                "--width",
                str(gen_width),
                "--height",
                str(gen_height),
                "--num-frames",
                str(num_frames),
                "--frame-rate",
                str(fps),
                "--seed",
                str(seed),
                "--output-path",
                str(raw_mp4),
            ]
            if self.quant_mode and self.quant_mode != "none":
                cmd.extend(["--quantization", self.quant_mode])
            if self.offload_mode and self.offload_mode != "none":
                cmd.extend(["--offload", self.offload_mode])
            if cfg.get("enhance_prompt"):
                cmd.append("--enhance-prompt")
            run_cmd(cmd, env=self.env)

        inference_ms = int(round((time.monotonic() - t_infer) * 1000))

        t_enc = time.monotonic()
        if bool(cfg.get("exact_16_9_crop", True)) and not self.base_cfg.get("mock_inference_mp4"):
            finalize_dimensions(
                raw_mp4,
                final_mp4,
                int(cfg["target_width"]),
                int(cfg["target_height"]),
                duration_sec=float(cfg["duration_sec"]) if cfg.get("duration_sec") else None,
                fps=fps,
                mute_audio=bool(cfg.get("mute_audio", False)),
            )
        else:
            shutil.copyfile(raw_mp4, final_mp4)
        raw_mp4.unlink(missing_ok=True)
        encode_ms = int(round((time.monotonic() - t_enc) * 1000))

        cache_source = (
            "warm_memory"
            if is_warm_shot
            else str(self.cache_report.get("cache_source") or "ephemeral_download")
        )
        stage_timings_ms = {
            "envSetupMs": 0 if self.shots_executed > 0 else self.env_setup_ms,
            "weightFetchMs": 0 if self.shots_executed > 0 else self.weight_fetch_ms,
            "modelLoadMs": shot_model_load_ms,
            "inferenceMs": inference_ms,
            "encodeTransferMs": encode_ms,
        }
        self.shots_executed += 1
        elapsed_s = round(time.time() - started, 2)
        meta = {
            "task_id": cfg["task_id"],
            "model": "Lightricks/LTX-2.5 (distilled)",
            "model_revision": str(self.cache_report.get("model_revision") or f"{LTX25_REPO_ID}@main"),
            "code_commit": self.code_commit,
            "backend": str(cfg.get("backend") or "ltx-pipelines"),
            "gpu_name": self.gpu_name,
            "vram_gb": self.vram_gb,
            "cache_source": cache_source,
            "warm_reuse": is_warm_shot,
            "shot_index_in_daemon": self.shots_executed,
            "stage_timings_ms": stage_timings_ms,
            "num_frames": num_frames,
            "fps": fps,
            "gen_size": [gen_width, gen_height],
            "output_size": [cfg["target_width"], cfg["target_height"]]
            if cfg.get("exact_16_9_crop", True)
            else [gen_width, gen_height],
            "elapsed_seconds": elapsed_s,
            "output_bytes": final_mp4.stat().st_size,
        }
        write_json_atomic(meta_file, meta)
        write_status(job_dir, "succeeded", output=str(final_mp4), elapsed_seconds=elapsed_s, meta=meta)
        print(
            f"[ltx25-worker] DONE shot #{self.shots_executed} ({cache_source}) in {elapsed_s}s -> {final_mp4}",
            flush=True,
        )
        return meta


def run_single_job_from_config(cfg: dict[str, Any]) -> None:
    hf_from_cfg = str(cfg.pop("hf_token", "") or "").strip()
    job_dir = pathlib.Path(str(cfg["remote_job_dir"]))
    stop_hb, hb_thread = start_heartbeat("ltx25-single", interval_s=10.0)
    env = dict(os.environ)
    if hf_from_cfg and not env.get("HF_TOKEN"):
        env["HF_TOKEN"] = hf_from_cfg
    try:
        write_status(job_dir, "running", pid=os.getpid(), started_at=time.time())
        engine = LTX25Engine(cfg, env)
        engine.initialize()
        engine.run_shot(cfg)
    except BaseException as exc:
        tb = traceback.format_exc()
        write_status(job_dir, "failed", error=f"{type(exc).__name__}: {exc}", traceback=tb[-2400:])
        raise
    finally:
        stop_hb.set()
        hb_thread.join(timeout=1.0)


def run_batch_daemon(daemon_dir: pathlib.Path) -> None:
    """Persistent warm worker serving sequential shots in `daemon_dir/inbox/*.json`."""
    daemon_dir.mkdir(parents=True, exist_ok=True)
    inbox = daemon_dir / "inbox"
    done_dir = daemon_dir / "processed"
    inbox.mkdir(parents=True, exist_ok=True)
    done_dir.mkdir(parents=True, exist_ok=True)

    cfg_path = daemon_dir / "daemon_config.json"
    if not cfg_path.is_file():
        raise RuntimeError(f"Missing daemon_config.json in {daemon_dir}")
    base_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    hf_from_cfg = str(base_cfg.pop("hf_token", "") or "").strip()
    # Scrub token from disk immediately after reading into process memory
    write_json_atomic(cfg_path, base_cfg)

    env = dict(os.environ)
    if hf_from_cfg and not env.get("HF_TOKEN"):
        env["HF_TOKEN"] = hf_from_cfg

    idle_timeout_s = float(base_cfg.get("idle_timeout_sec") or 600.0)
    state_path = daemon_dir / "daemon_state.json"
    write_json_atomic(
        state_path,
        {"state": "starting", "pid": os.getpid(), "started_at": time.time(), "shots_completed": 0},
    )

    try:
        engine = LTX25Engine(base_cfg, env)
        engine.initialize()
        write_json_atomic(
            state_path,
            {
                "state": "ready",
                "pid": os.getpid(),
                "gpu_name": engine.gpu_name,
                "vram_gb": engine.vram_gb,
                "model_revision": engine.cache_report.get("model_revision"),
                "cache_source": engine.cache_report.get("cache_source"),
                "shots_completed": 0,
                "updated_at": time.time(),
            },
        )
    except BaseException as exc:
        tb = traceback.format_exc()
        err_msg = f"{type(exc).__name__}: {exc}"
        write_json_atomic(
            state_path,
            {"state": "failed", "pid": os.getpid(), "error": err_msg, "traceback": tb[-2400:]},
        )
        # Fail any queued jobs waiting on daemon startup
        for item in sorted(inbox.glob("*.json")):
            try:
                jcfg = json.loads(item.read_text(encoding="utf-8"))
                write_status(pathlib.Path(str(jcfg["remote_job_dir"])), "failed", error=err_msg)
            except Exception:
                pass
            item.unlink(missing_ok=True)
        raise

    last_active = time.monotonic()
    stop_flag = daemon_dir / "STOP"
    while not stop_flag.exists():
        queued = sorted(inbox.glob("*.json"))
        if not queued:
            if (time.monotonic() - last_active) >= idle_timeout_s:
                print(
                    f"[ltx25-daemon] Idle timeout ({idle_timeout_s}s) reached; exiting warm daemon.",
                    flush=True,
                )
                break
            time.sleep(0.25)
            continue

        job_file = queued[0]
        processing_file = done_dir / f"{job_file.name}.running"
        try:
            job_file.replace(processing_file)
        except FileNotFoundError:
            continue

        job_cfg = json.loads(processing_file.read_text(encoding="utf-8"))
        job_cfg.pop("hf_token", None)
        job_dir = pathlib.Path(str(job_cfg["remote_job_dir"]))
        write_json_atomic(
            state_path,
            {
                "state": "busy",
                "pid": os.getpid(),
                "current_task_id": job_cfg.get("task_id"),
                "gpu_name": engine.gpu_name,
                "vram_gb": engine.vram_gb,
                "shots_completed": engine.shots_executed,
                "updated_at": time.time(),
            },
        )
        try:
            engine.run_shot(job_cfg)
        except BaseException as exc:
            tb = traceback.format_exc()
            write_status(
                job_dir,
                "failed",
                error=f"{type(exc).__name__}: {exc}",
                traceback=tb[-2400:],
            )
        finally:
            processing_file.replace(done_dir / job_file.name)
            last_active = time.monotonic()
            write_json_atomic(
                state_path,
                {
                    "state": "ready",
                    "pid": os.getpid(),
                    "gpu_name": engine.gpu_name,
                    "vram_gb": engine.vram_gb,
                    "model_revision": engine.cache_report.get("model_revision"),
                    "shots_completed": engine.shots_executed,
                    "updated_at": time.time(),
                },
            )

    write_json_atomic(
        state_path,
        {
            "state": "stopped",
            "pid": os.getpid(),
            "shots_completed": engine.shots_executed,
            "updated_at": time.time(),
        },
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="LTX-2.5 remote worker & warm batch daemon")
    parser.add_argument("--batch-daemon", help="Run persistent warm batch daemon in this directory")
    parser.add_argument("--job-config", help="Path to single-shot job_config.json")
    args, _ = parser.parse_known_args(argv)

    if args.batch_daemon:
        run_batch_daemon(pathlib.Path(args.batch_daemon))
        return

    cfg_file = args.job_config or os.environ.get("LTX_JOB_CONFIG_FILE")
    cfg_json = os.environ.get("LTX_JOB_CONFIG_JSON")
    if cfg_file and pathlib.Path(cfg_file).is_file():
        cfg_path = pathlib.Path(cfg_file)
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        cfg_path.unlink(missing_ok=True)
    elif cfg_json:
        cfg = json.loads(cfg_json)
    else:
        raise RuntimeError("Missing --job-config, LTX_JOB_CONFIG_FILE, or LTX_JOB_CONFIG_JSON.")
    run_single_job_from_config(cfg)


if __name__ == "__main__":
    main()
