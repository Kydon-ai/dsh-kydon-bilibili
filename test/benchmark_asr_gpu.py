"""Manually compare single-model batching with multiple GPU workers.

This diagnostic prints aggregate timings and transcript-equivalence flags only.
It does not save recognized text or change the ASR environment.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing
import os
import statistics
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable


SAMPLE_RATE = 16_000
DEFAULT_BATCH_SIZE = 8
DEFAULT_MAX_BATCH_SIZE = 128
DEFAULT_PARALLELISM = (2, 3)


def _is_cuda_oom(error: BaseException) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in (
        "out of memory",
        "cuda_error_out_of_memory",
        "cublas_status_alloc_failed",
    ))


def _collect_cues(segments: Any) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        start_ms = max(0, round(segment.start * 1_000))
        end_ms = max(start_ms, round(segment.end * 1_000))
        cues.append({"startMs": start_ms, "endMs": end_ms, "text": text})
    return cues


def _text_fingerprint(cues: list[dict[str, Any]]) -> str:
    text = "\n".join(cue["text"] for cue in cues)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _transcribe(
    model: Any,
    audio_path: str,
    strategy: str,
    batch_size: int,
    clips: list[dict[str, float]] | None = None,
) -> list[dict[str, Any]]:
    from faster_whisper import BatchedInferencePipeline

    if strategy == "direct":
        segments, _ = model.transcribe(audio_path, language="zh", vad_filter=True)
    else:
        pipeline = BatchedInferencePipeline(model)
        options: dict[str, Any] = {"language": "zh", "batch_size": batch_size}
        if clips is None:
            options["vad_filter"] = True
        else:
            options["vad_filter"] = False
            options["clip_timestamps"] = clips
        segments, _ = pipeline.transcribe(audio_path, **options)
    return _collect_cues(segments)


def _single_worker(args: argparse.Namespace) -> int:
    try:
        from faster_whisper import WhisperModel

        load_started = time.perf_counter()
        model = WhisperModel(args.model, device="cuda", compute_type="float16")
        load_seconds = time.perf_counter() - load_started
        inference_started = time.perf_counter()
        cues = _transcribe(model, str(args.audio), args.worker_strategy, args.worker_batch_size)
        inference_seconds = time.perf_counter() - inference_started
        result = {
            "ok": True,
            "loadSeconds": load_seconds,
            "inferenceSeconds": inference_seconds,
            "cueCount": len(cues),
            "textFingerprint": _text_fingerprint(cues),
            "firstStartMs": cues[0]["startMs"] if cues else None,
            "lastEndMs": cues[-1]["endMs"] if cues else None,
        }
    except Exception as error:
        result = {
            "ok": False,
            "errorType": type(error).__name__,
            "errorMessage": str(error)[:500],
            "cudaOom": _is_cuda_oom(error),
        }
    print(json.dumps(result))
    return 0


def _parallel_worker(
    messages: Any,
    release: Any,
    audio_path: str,
    model_ref: str,
    batch_size: int,
    clips: list[dict[str, float]],
) -> None:
    try:
        from faster_whisper import WhisperModel

        load_started = time.perf_counter()
        model = WhisperModel(model_ref, device="cuda", compute_type="float16")
        load_seconds = time.perf_counter() - load_started
        messages.put({"status": "ready", "loadSeconds": load_seconds})
        if not release.wait(timeout=900):
            messages.put({"status": "error", "errorType": "StartBarrierTimeout", "cudaOom": False})
            return
        inference_started = time.perf_counter()
        cues = _transcribe(model, audio_path, "clips", batch_size, clips)
        messages.put({"status": "done", "inferenceSeconds": time.perf_counter() - inference_started, "cues": cues})
    except Exception as error:
        messages.put({"status": "error", "errorType": type(error).__name__, "cudaOom": _is_cuda_oom(error)})


def _gpu_snapshot() -> dict[str, Any] | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    fields = [field.strip() for field in result.stdout.splitlines()[0].split(",")]
    if len(fields) != 3:
        return None
    return {"name": fields[0], "totalMiB": int(fields[1]), "freeMiBBeforeRun": int(fields[2])}


def _vad_clips(audio_path: Path) -> tuple[float, list[dict[str, int]], float]:
    started = time.perf_counter()
    import av
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    duration_seconds = float(av.open(str(audio_path)).duration or 0) / 1_000_000
    audio = decode_audio(str(audio_path), sampling_rate=SAMPLE_RATE)
    clips = get_speech_timestamps(
        audio,
        VadOptions(max_speech_duration_s=30),
        sampling_rate=SAMPLE_RATE,
    )
    return duration_seconds, clips, time.perf_counter() - started


def _partition_clips(clips: list[dict[str, int]], count: int) -> list[list[dict[str, int]]]:
    if count < 1 or count > len(clips):
        raise ValueError("Parallel worker count must be between one and the VAD clip count.")
    weights = [clip["end"] - clip["start"] for clip in clips]
    total_weight = sum(weights)
    groups: list[list[dict[str, int]]] = []
    cursor = 0
    consumed = 0
    for group_index in range(count - 1):
        target = total_weight * (group_index + 1) / count
        end = cursor
        while end < len(clips) - (count - group_index - 1):
            next_consumed = consumed + weights[end]
            if end > cursor and next_consumed > target:
                break
            consumed = next_consumed
            end += 1
        groups.append(clips[cursor:end])
        cursor = end
    groups.append(clips[cursor:])
    return groups


def _merge_cues(groups: list[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    cues = sorted((cue for group in groups for cue in group), key=lambda cue: (cue["startMs"], cue["endMs"]))
    merged: list[dict[str, Any]] = []
    seen: set[tuple[int, int, str]] = set()
    for cue in cues:
        identity = (cue["startMs"], cue["endMs"], cue["text"])
        if identity not in seen:
            merged.append(cue)
            seen.add(identity)
    return merged


def _child_environment(cache_dir: Path) -> dict[str, str]:
    environment = os.environ.copy()
    environment["HF_HOME"] = str(cache_dir / "hf-cache")
    environment["HF_HUB_CACHE"] = str(cache_dir / "hf-cache" / "hub")
    environment["HF_HUB_DISABLE_XET"] = "1"
    environment["PYTHONIOENCODING"] = "utf-8"
    return environment


def _run_single(
    audio_path: Path,
    cache_dir: Path,
    model_ref: str,
    strategy: str,
    batch_size: int,
    timeout_seconds: int,
) -> dict[str, Any]:
    command = [
        sys.executable,
        str(Path(__file__).resolve()),
        "--audio",
        str(audio_path),
        "--cache-dir",
        str(cache_dir),
        "--model",
        model_ref,
        "--worker-strategy",
        strategy,
        "--worker-batch-size",
        str(batch_size),
    ]
    started = time.perf_counter()
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=_child_environment(cache_dir),
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "errorType": "TimeoutExpired", "cudaOom": False}
    wall_seconds = time.perf_counter() - started
    worker_result: dict[str, Any] | None = None
    for line in reversed(completed.stdout.splitlines()):
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "ok" in parsed:
            worker_result = parsed
            break
    if worker_result is None:
        return {"ok": False, "errorType": "WorkerOutputError", "cudaOom": False}
    return {**worker_result, "wallSeconds": wall_seconds}


def _run_parallel(
    audio_path: Path,
    cache_dir: Path,
    model_ref: str,
    batch_size: int,
    worker_count: int,
    vad_clips: list[dict[str, int]],
    timeout_seconds: int,
) -> dict[str, Any]:
    groups = _partition_clips(vad_clips, worker_count)
    context = multiprocessing.get_context("spawn")
    messages = context.Queue()
    release = context.Event()
    processes = [
        context.Process(
            target=_parallel_worker,
            args=(
                messages,
                release,
                str(audio_path),
                model_ref,
                batch_size,
                [
                    {"start": clip["start"] / SAMPLE_RATE, "end": clip["end"] / SAMPLE_RATE}
                    for clip in group
                ],
            ),
        )
        for group in groups
    ]
    started = time.perf_counter()
    results: list[dict[str, Any]] = []
    ready_count = 0
    started_processes: list[Any] = []
    try:
        cache_environment = {
            "HF_HOME": str(cache_dir / "hf-cache"),
            "HF_HUB_CACHE": str(cache_dir / "hf-cache" / "hub"),
            "HF_HUB_DISABLE_XET": "1",
            "PYTHONIOENCODING": "utf-8",
        }
        previous_environment = {key: os.environ.get(key) for key in cache_environment}
        try:
            os.environ.update(cache_environment)
            for process in processes:
                process.start()
                started_processes.append(process)
        finally:
            for key, previous_value in previous_environment.items():
                if previous_value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous_value
        deadline = time.monotonic() + timeout_seconds
        while ready_count < worker_count:
            message = messages.get(timeout=max(1, deadline - time.monotonic()))
            if message["status"] in ("ready", "error"):
                results.append(message)
                if message["status"] == "ready":
                    ready_count += 1
                elif message["status"] == "error":
                    ready_count += 1
        release.set()
        done_count = sum(1 for message in results if message["status"] == "error")
        while done_count < ready_count:
            message = messages.get(timeout=max(1, deadline - time.monotonic()))
            results.append(message)
            done_count += 1
    except Exception as error:
        results.append({"status": "error", "errorType": type(error).__name__, "cudaOom": False})
    finally:
        release.set()
        for process in started_processes:
            process.join(timeout=10)
            if process.is_alive():
                process.terminate()
                process.join()
        messages.close()
        messages.join_thread()
    successful = [message for message in results if message.get("status") == "done"]
    errors = [message for message in results if message.get("status") == "error"]
    if errors or len(successful) != worker_count:
        return {
            "ok": False,
            "cudaOom": any(error.get("cudaOom", False) for error in errors),
            "errorTypes": [error.get("errorType", "WorkerError") for error in errors],
            "wallSeconds": time.perf_counter() - started,
        }
    merged_cues = _merge_cues([message["cues"] for message in successful])
    return {
        "ok": True,
        "wallSeconds": time.perf_counter() - started,
        "loadSeconds": max(message["loadSeconds"] for message in results if message["status"] == "ready"),
        "inferenceSeconds": max(message["inferenceSeconds"] for message in successful),
        "cueCount": len(merged_cues),
        "textFingerprint": _text_fingerprint(merged_cues),
        "firstStartMs": merged_cues[0]["startMs"] if merged_cues else None,
        "lastEndMs": merged_cues[-1]["endMs"] if merged_cues else None,
    }


def _summarize(samples: list[dict[str, Any]], baseline_fingerprint: str) -> dict[str, Any]:
    successful = [sample for sample in samples if sample.get("ok")]
    return {
        "samples": [round(sample["wallSeconds"], 2) for sample in samples if sample.get("ok")],
        "medianWallSeconds": round(statistics.median(sample["wallSeconds"] for sample in successful), 2) if successful else None,
        "medianLoadSeconds": round(statistics.median(sample["loadSeconds"] for sample in successful), 2) if successful else None,
        "medianInferenceSeconds": round(statistics.median(sample["inferenceSeconds"] for sample in successful), 2) if successful else None,
        "cueCount": successful[0]["cueCount"] if successful else None,
        "sameTextAsDirect": all(sample["textFingerprint"] == baseline_fingerprint for sample in successful) if successful else False,
        "failures": [{
            "errorTypes": sample.get("errorTypes", [sample.get("errorType", "WorkerError")]),
            "errorMessage": sample.get("errorMessage"),
            "cudaOom": sample.get("cudaOom", False),
        } for sample in samples if not sample.get("ok")],
    }


def _batch_candidates(clip_count: int, start: int, maximum: int) -> list[int]:
    limit = min(clip_count, maximum)
    if limit < 1:
        return []
    value = min(start, limit)
    candidates = [value]
    while value < limit:
        value = min(value * 2, limit)
        if candidates[-1] != value:
            candidates.append(value)
    return candidates


def _refine_batch_size(
    safe_lower: int,
    failed_upper: int,
    probe: Callable[[int], bool | None],
) -> tuple[int, bool]:
    while failed_upper - safe_lower > 1:
        candidate = (safe_lower + failed_upper) // 2
        result = probe(candidate)
        if result is None:
            return safe_lower, False
        if result:
            safe_lower = candidate
        else:
            failed_upper = candidate
    return safe_lower, True


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True, help="Local audio file to measure; its transcript is not printed or saved.")
    parser.add_argument("--model", default="small", help="faster-whisper model name or local model directory.")
    parser.add_argument("--cache-dir", type=Path, default=Path(__file__).resolve().parents[1] / ".cache")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--start-batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--max-batch-size", type=int, default=DEFAULT_MAX_BATCH_SIZE)
    parser.add_argument("--parallelisms", type=int, nargs="+", default=list(DEFAULT_PARALLELISM))
    parser.add_argument("--timeout-seconds", type=int, default=1_800)
    parser.add_argument("--worker-strategy", choices=("direct", "batched"), help=argparse.SUPPRESS)
    parser.add_argument("--worker-batch-size", type=int, default=1, help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if not args.audio.is_file():
        raise FileNotFoundError("The benchmark audio file does not exist.")
    args.audio = args.audio.resolve()
    args.cache_dir = args.cache_dir.resolve()
    if args.worker_strategy is not None:
        return _single_worker(args)
    if args.repeats < 1 or args.start_batch_size < 1 or args.max_batch_size < args.start_batch_size:
        raise ValueError("Repeats and batch sizes must be positive, and the maximum must cover the start size.")

    duration_seconds, vad_clips, vad_preparation_seconds = _vad_clips(args.audio)
    if not vad_clips:
        raise ValueError("VAD found no speech clips in the benchmark audio.")
    baseline_samples = [
        _run_single(args.audio, args.cache_dir, args.model, "direct", 1, args.timeout_seconds)
        for _ in range(args.repeats)
    ]
    baseline_success = [sample for sample in baseline_samples if sample.get("ok")]
    if not baseline_success:
        print(json.dumps({
            "gpu": _gpu_snapshot(),
            "audioDurationSeconds": round(duration_seconds, 1),
            "vadClipCount": len(vad_clips),
            "gpuBenchmarkAvailable": False,
            "baselineFailures": [{
                "errorType": sample.get("errorType"),
                "errorMessage": sample.get("errorMessage"),
                "cudaOom": sample.get("cudaOom", False),
            } for sample in baseline_samples],
        }, ensure_ascii=False, indent=2))
        return 2
    baseline_fingerprint = baseline_success[0]["textFingerprint"]

    batch_results: dict[str, dict[str, Any]] = {}
    safe_batch_sizes: list[int] = []

    def measure_batch(batch_size: int) -> list[dict[str, Any]]:
        samples = [
            _run_single(args.audio, args.cache_dir, args.model, "batched", batch_size, args.timeout_seconds)
            for _ in range(args.repeats)
        ]
        batch_results[str(batch_size)] = _summarize(samples, baseline_fingerprint)
        return samples

    failed_upper: int | None = None
    search_failure: str | None = None
    for batch_size in _batch_candidates(len(vad_clips), args.start_batch_size, args.max_batch_size):
        samples = measure_batch(batch_size)
        failures = [sample for sample in samples if not sample.get("ok")]
        if failures:
            if all(sample.get("cudaOom", False) for sample in failures):
                failed_upper = batch_size
            else:
                search_failure = "; ".join(str(sample.get("errorMessage", sample.get("errorType"))) for sample in failures)
            break
        safe_batch_sizes.append(batch_size)
    if not safe_batch_sizes:
        lower = 0
    else:
        lower = max(safe_batch_sizes)
    if failed_upper is not None:
        def probe_batch(batch_size: int) -> bool | None:
            nonlocal search_failure
            samples = measure_batch(batch_size)
            failures = [sample for sample in samples if not sample.get("ok")]
            if not failures:
                safe_batch_sizes.append(batch_size)
                return True
            if all(sample.get("cudaOom", False) for sample in failures):
                return False
            else:
                search_failure = "; ".join(str(sample.get("errorMessage", sample.get("errorType"))) for sample in failures)
                return None

        lower, _ = _refine_batch_size(lower, failed_upper, probe_batch)
    if not safe_batch_sizes:
        print(json.dumps({
            "gpu": _gpu_snapshot(),
            "audioDurationSeconds": round(duration_seconds, 1),
            "vadClipCount": len(vad_clips),
            "gpuBenchmarkAvailable": True,
            "directSingleModel": _summarize(baseline_samples, baseline_fingerprint),
            "adaptiveBatchSearch": {
                "candidates": sorted(int(size) for size in batch_results),
                "largestSafeTestedBatchSize": None,
                "results": batch_results,
                "failure": search_failure or "No tested batch size fit in GPU memory.",
            },
        }, ensure_ascii=False, indent=2))
        return 3
    safe_batch_sizes.sort()
    fastest_measured_batch = min(
        safe_batch_sizes,
        key=lambda size: batch_results[str(size)]["medianWallSeconds"],
    )
    matching_batch_sizes = [
        size for size in safe_batch_sizes if batch_results[str(size)]["sameTextAsDirect"]
    ]
    selected_batch = min(
        matching_batch_sizes or safe_batch_sizes,
        key=lambda size: batch_results[str(size)]["medianWallSeconds"],
    )

    parallel_results: dict[str, dict[str, Any]] = {}
    for worker_count in args.parallelisms:
        if worker_count < 2 or worker_count > len(vad_clips):
            continue
        samples = [
            _run_parallel(
                args.audio,
                args.cache_dir,
                args.model,
                selected_batch,
                worker_count,
                vad_clips,
                args.timeout_seconds,
            )
            for _ in range(args.repeats)
        ]
        for sample in samples:
            if sample.get("ok"):
                sample["workerWallSeconds"] = sample["wallSeconds"]
                sample["wallSeconds"] += vad_preparation_seconds
        parallel_results[str(worker_count)] = {
            **_summarize(samples, baseline_fingerprint),
            "workerWallSamples": [round(sample["workerWallSeconds"], 2) for sample in samples if sample.get("ok")],
            "medianWorkerWallSeconds": round(statistics.median(
                sample["workerWallSeconds"] for sample in samples if sample.get("ok")
            ), 2) if any(sample.get("ok") for sample in samples) else None,
            "vadPreparationSecondsAddedToWall": round(vad_preparation_seconds, 2),
        }

    report = {
        "gpu": _gpu_snapshot(),
        "audioDurationSeconds": round(duration_seconds, 1),
        "vadClipCount": len(vad_clips),
        "vadPreparationSeconds": round(vad_preparation_seconds, 2),
        "repeatsPerCase": args.repeats,
        "directSingleModel": _summarize(baseline_samples, baseline_fingerprint),
        "adaptiveBatchSearch": {
            "candidates": sorted(int(size) for size in batch_results),
            "largestSafeTestedBatchSize": max(safe_batch_sizes),
            "searchUpperBound": min(len(vad_clips), args.max_batch_size),
            "searchStoppedAtAudioClipCount": len(vad_clips) <= args.max_batch_size,
            "fastestMeasuredBatchSize": fastest_measured_batch,
            "selectedBatchSize": selected_batch,
            "selectedBatchPreservesDirectText": bool(matching_batch_sizes),
            "searchFailure": search_failure,
            "results": batch_results,
        },
        "parallelVADClipWorkers": {
            "perWorkerBatchSize": selected_batch,
            "results": parallel_results,
            "timestamps": "faster-whisper clip offsets preserve positions in the original audio; merged cues are sorted by start time.",
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
