"""Run one cached small-model CUDA batch transcription and print its result."""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path


def _timestamp(seconds: float) -> str:
    milliseconds = round(seconds * 1_000)
    hours, milliseconds = divmod(milliseconds, 3_600_000)
    minutes, milliseconds = divmod(milliseconds, 60_000)
    whole_seconds, milliseconds = divmod(milliseconds, 1_000)
    return f"{hours:02}:{minutes:02}:{whole_seconds:02}.{milliseconds:03}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True, type=Path, help="Local audio file to transcribe.")
    args = parser.parse_args()
    if not args.audio.is_file():
        parser.error(f"Audio file does not exist: {args.audio}")

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    cache_dir = Path(__file__).resolve().parents[1] / ".cache"
    hf_cache = cache_dir / "hf-cache"
    os.environ.setdefault("HF_HOME", str(hf_cache))
    os.environ.setdefault("HF_HUB_CACHE", str(hf_cache / "hub"))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

    started = time.perf_counter()
    from faster_whisper import BatchedInferencePipeline, WhisperModel

    print("Loading Whisper small on CUDA (float16)...", flush=True)
    load_started = time.perf_counter()
    model = WhisperModel("small", device="cuda", compute_type="float16")
    load_seconds = time.perf_counter() - load_started

    print("Transcribing with batch_size=32...", flush=True)
    inference_started = time.perf_counter()
    pipeline = BatchedInferencePipeline(model)
    segments, _ = pipeline.transcribe(
        str(args.audio.resolve()),
        language="zh",
        batch_size=32,
        vad_filter=True,
    )
    cues = [
        (segment.start, segment.end, segment.text.strip())
        for segment in segments
        if segment.text.strip()
    ]
    inference_seconds = time.perf_counter() - inference_started
    total_seconds = time.perf_counter() - started

    print("\n字幕结果：")
    for cue_index, (start, end, text) in enumerate(cues, start=1):
        print(f"{cue_index:03} [{_timestamp(start)} --> {_timestamp(end)}] {text}")
    print("\n耗时：")
    print(f"模型加载：{load_seconds:.2f} 秒")
    print(f"音频转写：{inference_seconds:.2f} 秒")
    print(f"脚本总耗时（不含打印字幕）：{total_seconds:.2f} 秒")
    print(f"字幕片段数：{len(cues)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
