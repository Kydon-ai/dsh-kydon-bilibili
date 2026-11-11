#!/usr/bin/env python3
"""Download one Bilibili audio track, transcribe it, and save audio and SRT artifacts."""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any


MODEL_NAME = "small"
MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
MAX_BATCH_SIZE = 64


def read_request() -> dict[str, Any]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("Request must be a JSON object.")
    operation = value.get("operation", "transcribe")
    if operation not in ("download-model", "transcribe"):
        raise ValueError("Request has an invalid ASR operation.")
    cache_dir = value.get("cacheDir")
    if not isinstance(cache_dir, str) or not cache_dir:
        raise ValueError("Request has no ASR cache directory.")
    if operation == "download-model":
        return {"operation": operation, "cacheDir": cache_dir}
    bvid = value.get("bvid")
    page = value.get("page")
    if not isinstance(bvid, str) or re.fullmatch(r"BV[0-9A-Za-z]{10}", bvid) is None:
        raise ValueError("Request has an invalid Bilibili BV id.")
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise ValueError("Request has an invalid video page.")
    batch_size = value.get("batchSize")
    if (
        not isinstance(batch_size, int)
        or isinstance(batch_size, bool)
        or not 1 <= batch_size <= MAX_BATCH_SIZE
    ):
        raise ValueError(f"Request batchSize must be an integer from 1 to {MAX_BATCH_SIZE}.")
    return {
        "operation": operation,
        "bvid": bvid,
        "page": page,
        "cacheDir": cache_dir,
        "batchSize": batch_size,
    }


def download_audio(bvid: str, page: int, temp_dir: Path) -> tuple[Path, dict[str, Any]]:
    from yt_dlp import YoutubeDL

    video_url = f"https://www.bilibili.com/video/{bvid}/"
    if page > 1:
        video_url += f"?p={page}"

    options = {
        "format": "bestaudio/best",
        "outtmpl": str(temp_dir / "audio.%(ext)s"),
        "paths": {"home": str(temp_dir), "temp": str(temp_dir)},
        "cachedir": False,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "http_headers": {
            "Referer": "https://www.bilibili.com/",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        },
    }
    with YoutubeDL(options) as downloader:
        info = downloader.extract_info(video_url, download=True)
        if not isinstance(info, dict) or info.get("id") != bvid:
            raise ValueError("Downloaded video id does not match the requested BV id.")
        audio_path = Path(downloader.prepare_filename(info))
    if not audio_path.is_file():
        raise FileNotFoundError("yt-dlp did not produce an audio file.")
    return audio_path, info


def load_model(model_ref: str) -> tuple[Any, str, str | None]:
    import ctranslate2
    from faster_whisper import WhisperModel

    fallback_reason: str | None = None
    try:
        cuda_devices = ctranslate2.get_cuda_device_count()
    except Exception as error:
        cuda_devices = 0
        fallback_reason = f"CUDA detection failed ({type(error).__name__})."

    if cuda_devices > 0:
        try:
            return WhisperModel(model_ref, device="cuda", compute_type="float16"), "cuda", None
        except Exception as error:
            fallback_reason = f"CUDA model initialization failed ({type(error).__name__})."

    return WhisperModel(model_ref, device="cpu", compute_type="int8"), "cpu", fallback_reason or "No CUDA device is available."


def transcribe(
    model: Any,
    audio_path: Path,
    device: str,
    batch_size: int,
) -> tuple[list[dict[str, Any]], str, float]:
    if device == "cuda":
        from faster_whisper import BatchedInferencePipeline

        pipeline = BatchedInferencePipeline(model)
        segments, info = pipeline.transcribe(
            str(audio_path), language="zh", vad_filter=True, batch_size=batch_size
        )
    else:
        segments, info = model.transcribe(str(audio_path), language="zh", vad_filter=True)
    cues: list[dict[str, Any]] = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        start_ms = max(0, round(segment.start * 1000))
        end_ms = max(start_ms, round(segment.end * 1000))
        cues.append({"startMs": start_ms, "endMs": end_ms, "text": text})
    return cues, str(info.language), float(info.duration)


def srt_timestamp(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def write_srt(cues: list[dict[str, Any]], output_path: Path) -> None:
    with output_path.open("w", encoding="utf-8", newline="\n") as subtitle_file:
        for index, cue in enumerate(cues, start=1):
            subtitle_file.write(f"{index}\n")
            subtitle_file.write(
                f"{srt_timestamp(cue['startMs'])} --> {srt_timestamp(cue['endMs'])}\n"
            )
            subtitle_file.write(f"{cue['text']}\n\n")


def download_model() -> None:
    from huggingface_hub import snapshot_download

    model_dir = Path(snapshot_download(
        repo_id="Systran/faster-whisper-small",
        allow_patterns=list(MODEL_FILES),
    ))
    if not all((model_dir / name).is_file() for name in MODEL_FILES):
        raise FileNotFoundError("The downloaded Whisper model is incomplete.")


def emit_failure(error: str) -> int:
    print(json.dumps({"ok": False, "error": error}, ensure_ascii=False))
    return 1


def main() -> int:
    try:
        request = read_request()
        cache_dir = Path(request["cacheDir"]).resolve()
        cache_dir.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(cache_dir / "hf-cache"))
        os.environ.setdefault("HF_HUB_CACHE", str(cache_dir / "hf-cache" / "hub"))
        os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

        if request["operation"] == "download-model":
            download_model()
            print(json.dumps({"ok": True, "model": MODEL_NAME}))
            return 0

        with tempfile.TemporaryDirectory(prefix="kydon-bili-asr-", dir=cache_dir) as temp_name:
            temp_dir = Path(temp_name)
            audio_path, info = download_audio(request["bvid"], request["page"], temp_dir)
            suffix = audio_path.suffix.lower()
            if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) is None:
                raise ValueError("yt-dlp returned an unsupported audio filename.")
            audio_dir = cache_dir / "audio"
            audio_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            artifact_name = f"{request['bvid']}-p{request['page']}"
            audio_output = audio_dir / f"{artifact_name}{suffix}"
            os.replace(audio_path, audio_output)

            model_dir = cache_dir / "whisper-small"
            model_ref = str(model_dir) if all((model_dir / name).is_file() for name in MODEL_FILES) else MODEL_NAME
            model, device, fallback_reason = load_model(model_ref)
            try:
                cues, language, duration = transcribe(
                    model, audio_output, device, request["batchSize"]
                )
            except Exception as error:
                if device != "cuda":
                    raise
                fallback_reason = f"CUDA transcription failed ({type(error).__name__})."
                model, device = load_model_on_cpu(model_ref)
                cues, language, duration = transcribe(
                    model, audio_output, device, request["batchSize"]
                )
            if not cues:
                return emit_failure("Whisper did not recognize speech in the video audio.")

            subtitle_dir = cache_dir / "subtitles"
            subtitle_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            subtitle_output = subtitle_dir / f"{artifact_name}.srt"
            subtitle_temp = temp_dir / "transcript.srt"
            write_srt(cues, subtitle_temp)
            os.replace(subtitle_temp, subtitle_output)

            print(json.dumps({
                "ok": True,
                "bvid": request["bvid"],
                "page": request["page"],
                "model": MODEL_NAME,
                "device": device,
                "fallbackReason": fallback_reason,
                "durationSeconds": duration,
                "language": language,
                "downloadedDurationSeconds": info.get("duration"),
                "audioPath": str(audio_output),
                "subtitlePath": str(subtitle_output),
                "cues": cues,
            }, ensure_ascii=False))
        return 0
    except ModuleNotFoundError as error:
        return emit_failure(f"Missing ASR dependency: {error.name}.")
    except Exception as error:
        return emit_failure(f"ASR worker failed: {type(error).__name__}.")


def load_model_on_cpu(model_ref: str) -> tuple[Any, str]:
    from faster_whisper import WhisperModel

    return WhisperModel(model_ref, device="cpu", compute_type="int8"), "cpu"


if __name__ == "__main__":
    raise SystemExit(main())
