import argparse
import os
from pathlib import Path


MODEL_REPOSITORY = "hexgrad/Kokoro-82M-v1.1-zh"
SAMPLE_RATE = 24000


def synthesize_kokoro_audio(text: str, output_path: Path, voice: str, rate: int) -> Path:
    runtime_root = voice_runtime_root()
    python = runtime_root / ".venv" / "bin" / "python"
    marker = runtime_root / "kokoro.ready.json"
    if not python.exists() or not marker.exists():
        raise RuntimeError(
            "Kokoro local voice runtime is not provisioned in this deployment; "
            "the Web studio no longer installs or advertises local voice models."
        )
    script = Path(__file__).resolve()
    speed = max(0.65, min(1.45, rate / 180.0))
    import subprocess

    subprocess.run(
        [
            str(python),
            str(script),
            "--text",
            text,
            "--voice",
            voice,
            "--speed",
            f"{speed:.3f}",
            "--output",
            str(output_path),
            "--runtime-root",
            str(runtime_root),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return output_path


def voice_runtime_root() -> Path:
    configured = os.environ.get("VIDEO_FACTORY_VOICE_RUNTIME")
    if configured:
        return Path(configured).expanduser().resolve()
    return Path(__file__).resolve().parents[2] / ".local" / "voice"


def run_model(text: str, output_path: Path, voice: str, speed: float, runtime_root: Path) -> None:
    os.environ.setdefault("HF_HOME", str(runtime_root / "cache" / "huggingface"))
    from kokoro import KPipeline
    import numpy as np
    import soundfile as sf

    pipeline = KPipeline(lang_code="z", repo_id=MODEL_REPOSITORY)
    chunks = []
    for result in pipeline(text, voice=voice, speed=speed):
        audio = result.audio if hasattr(result, "audio") else result[2]
        if hasattr(audio, "detach"):
            audio = audio.detach().cpu().numpy()
        chunks.append(np.asarray(audio, dtype=np.float32))
    if not chunks:
        raise RuntimeError("Kokoro returned no audio chunks.")
    silence = np.zeros(round(SAMPLE_RATE * 0.08), dtype=np.float32)
    joined = chunks[0] if len(chunks) == 1 else np.concatenate(
        [part for index, chunk in enumerate(chunks) for part in ((silence, chunk) if index else (chunk,))]
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(output_path, joined, SAMPLE_RATE, subtype="PCM_16")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate offline Mandarin speech with the isolated Kokoro runtime.")
    parser.add_argument("--text", required=True)
    parser.add_argument("--voice", default="zf_001")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--runtime-root", type=Path, required=True)
    args = parser.parse_args()
    run_model(args.text, args.output, args.voice, args.speed, args.runtime_root.resolve())


if __name__ == "__main__":
    main()
