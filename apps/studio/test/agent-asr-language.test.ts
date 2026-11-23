import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("NEW-04 静音段不锁定语种，首段中文和下一段沿用简体提示", () => {
  const program = fileURLToPath(new URL("../../../scripts/frame-transcribe.py", import.meta.url));
  // 只隔离推理库接口。本地模型、VAD 和音频时钟另用实际音轨验证。
  execFileSync("python3", ["-I", "-B", "-c", `
from types import SimpleNamespace, ModuleType
import runpy
import sys

sys.modules["numpy"] = ModuleType("numpy")
sys.modules["faster_whisper"] = SimpleNamespace(WhisperModel=object)
transcribe = runpy.run_path(sys.argv[1])["transcribe_window"]

class Model:
    def __init__(self):
        self.calls = []
        self.decoded = []
    def transcribe(self, samples, **options):
        self.calls.append((samples, options))
        def segments():
            self.decoded.append(samples)
            yield samples
        return segments(), SimpleNamespace(language="zh" if samples == "first" else "ja",
                                           duration_after_vad=0 if samples == "quiet" else 9)

m = Model()
language = None
for window, expected in [("quiet", []), ("first", ["first"]), ("second", ["second"]), ("quiet", [])]:
    segments, language = transcribe(m, window, language)
    assert list(segments) == expected
    if window == "first":
        assert language == "zh"
assert m.decoded == ["first", "second"]
assert [o["language"] for _, o in m.calls] == [None, None, "zh", "zh", "zh"]
assert all(o["vad_filter"] and o["word_timestamps"] for _, o in m.calls)
assert all("简体" in o["initial_prompt"] for _, o in m.calls[2:])
assert transcribe(m, "second", "en")[1] == "en"
assert m.calls[-1][1]["initial_prompt"] is None
`, program]);
});

test("BUG-05 识音线程数默认 2 以匹配 2 核容器，可由 FRAME_ASR_THREADS 指定", () => {
  const program = fileURLToPath(new URL("../../../scripts/frame-transcribe.py", import.meta.url));
  // 只隔离推理库与解码器：模型在拉起解码器之前加载，走到解码器即可停，不需要音轨。
  execFileSync("python3", ["-I", "-B", "-c", `
import os
import runpy
import subprocess
import sys
from types import ModuleType, SimpleNamespace

sys.modules["numpy"] = ModuleType("numpy")
loaded = []

class Stop(Exception):
    pass

class Decoder:
    def __init__(self, *args, **options):
        raise Stop

sys.modules["faster_whisper"] = SimpleNamespace(WhisperModel=lambda *a, **k: loaded.append(k) or object())
recognize = runpy.run_path(sys.argv[1])["recognize"]
subprocess.Popen = Decoder
for value, expected in [(None, 2), ("", 2), ("4", 4)]:
    if value is None:
        os.environ.pop("FRAME_ASR_THREADS", None)
    else:
        os.environ["FRAME_ASR_THREADS"] = value
    try:
        recognize("model", "source.wav")
        raise AssertionError("应当停在解码器处")
    except Stop:
        pass
    assert loaded[-1] == dict(device="cpu", compute_type="int8", cpu_threads=expected, local_files_only=True), loaded[-1]
`, program]);
});
