"""从本机音轨识别词时间及可校对的停顿。运行时不访问网络。"""
from pathlib import Path
import json
import os
import subprocess
import sys
import numpy as np
from faster_whisper import WhisperModel

RATE = 16000
WINDOW = 30 * RATE
MARGIN = RATE
CHINESE_PROMPT = "以下是普通话简体中文字幕。今天，我们来聊聊镜头、画面、旁白和音乐。"

def speech_edges(pcm):
    frames = pcm[:len(pcm) // 160 * 160].reshape(-1, 160)
    if len(frames) == 0:
        return [], []
    rms = np.sqrt(np.mean(frames ** 2, axis=1))
    threshold = max(0.003, min(0.016, float(np.percentile(rms, 85)) * 0.09))
    voice = np.flatnonzero(rms >= threshold)
    if len(voice) == 0:
        return [], []
    splits = np.flatnonzero(np.diff(voice) > 12)
    return [int(v) * 10 for v in np.r_[voice[0],voice[splits+1]]], [int(v + 1) * 10 for v in np.r_[voice[splits],voice[-1]]]

def transcribe_window(model, samples, language):
    # 保留词边缘所需的短上下文。默认较长的补边在安静片尾可能重复上一次起词。
    decode_options = dict(beam_size=3, word_timestamps=True, condition_on_previous_text=False,
                          vad_filter=True, vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 160})
    segments, info = model.transcribe(samples, language=language,
                                      initial_prompt=CHINESE_PROMPT if language == "zh" else None,
                                      **decode_options)
    if info.duration_after_vad == 0:
        return (), language
    if language is None:
        language = info.language
        if language == "zh":
            # 解码是惰性的，首次检测到中文时也从简体提示词开始解码。
            segments, _ = model.transcribe(samples, language=language,
                                           initial_prompt=CHINESE_PROMPT, **decode_options)
    return segments, language

def recognize(model_dir, source, language=None):
    model = WhisperModel(model_dir, device="cpu", compute_type="int8", cpu_threads=3, local_files_only=True)
    command = ["ffmpeg","-nostdin","-v","error","-xerror","-protocol_whitelist","file,pipe","-i",source,"-map","0:a:0","-ac","1","-ar",str(RATE),"-f","s16le","-"]
    words, starts, ends = [], [], []
    offset = 0
    with subprocess.Popen(command, stdout=subprocess.PIPE) as decoder:
        try:
            carry = b""
            while True:
                chunk = decoder.stdout.read((WINDOW + MARGIN) * 2 - len(carry))
                raw = carry + chunk
                if not raw:
                    break
                samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
                last = len(samples) < WINDOW + MARGIN
                segments, language = transcribe_window(model, samples, language)
                for seg in segments:
                    for word in seg.words:
                        middle = (word.start + word.end) * RATE / 2
                        if (offset and middle < MARGIN / 2) or (not last and middle >= WINDOW + MARGIN/2):
                            continue
                        start = offset + round(word.start * 1000)
                        end = offset + round(word.end * 1000)
                        if word.word.strip() and end > start:
                            words.append({"text":word.word,"offsetMs":start,"durationMs":end-start})
                local_starts, local_ends = speech_edges(samples)
                starts.extend(offset+t for t in local_starts)
                ends.extend(offset+t for t in local_ends)
                if last:
                    break
                carry = raw[WINDOW*2:]
                offset += 30000
            status = decoder.wait()
            if status:
                raise subprocess.CalledProcessError(status, command)
        finally:
            if decoder.poll() is None:
                decoder.kill()
    return {"words":words,"starts":sorted(set(starts)),"ends":sorted(set(ends))}

if __name__ == "__main__":
    print(json.dumps(recognize(str(Path(sys.argv[1])), sys.argv[2], os.environ.get("FRAME_ASR_LANGUAGE") or None),
                     ensure_ascii=False))
