"""Unit tests for the local audio download and transcription worker."""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


WORKER_PATH = Path(__file__).resolve().parents[1] / "asr-worker.py"
SPEC = importlib.util.spec_from_file_location("asr_worker", WORKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Could not load asr-worker.py for unit tests.")
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)
BENCHMARK_SPEC = importlib.util.spec_from_file_location(
    "asr_gpu_benchmark",
    Path(__file__).with_name("benchmark_asr_gpu.py"),
)
if BENCHMARK_SPEC is None or BENCHMARK_SPEC.loader is None:
    raise RuntimeError("Could not load benchmark_asr_gpu.py for unit tests.")
BENCHMARK = importlib.util.module_from_spec(BENCHMARK_SPEC)
BENCHMARK_SPEC.loader.exec_module(BENCHMARK)


class FakeYoutubeDL:
    """Write a local audio fixture using the worker's yt-dlp options."""

    requested_url: str | None = None
    requested_options: dict[str, object] | None = None

    def __init__(self, options: dict[str, object]) -> None:
        self.options = options
        self.audio_path: Path | None = None
        type(self).requested_options = options

    def __enter__(self) -> FakeYoutubeDL:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def extract_info(self, url: str, download: bool) -> dict[str, object]:
        type(self).requested_url = url
        if not download:
            raise AssertionError("The worker did not request an audio download.")
        template = str(self.options["outtmpl"])
        self.audio_path = Path(template.replace("%(ext)s", "m4a"))
        self.audio_path.write_bytes(b"mock downloaded audio")
        return {"id": "BV1234567890", "duration": 3.5}

    def prepare_filename(self, _info: dict[str, object]) -> str:
        if self.audio_path is None:
            raise AssertionError("yt-dlp did not create the audio fixture.")
        return str(self.audio_path)


class FakeWhisperModel:
    """Return fixed timestamped speech without loading a model or CUDA."""

    initialization: tuple[str, str, str] | None = None

    def __init__(self, model_ref: str, *, device: str, compute_type: str) -> None:
        type(self).initialization = (model_ref, device, compute_type)

    def transcribe(self, audio_path: str, **options: object) -> tuple[list[SimpleNamespace], SimpleNamespace]:
        if not Path(audio_path).is_file():
            raise AssertionError("The worker did not move downloaded audio into its cache.")
        if options != {"language": "zh", "vad_filter": True}:
            raise AssertionError("The worker changed the transcription options.")
        return [
            SimpleNamespace(start=1.234, end=2.345, text=" 识别出的文本 "),
            SimpleNamespace(start=2.5, end=2.8, text="   "),
        ], SimpleNamespace(language="zh", duration=3.5)


class AsrWorkerTests(unittest.TestCase):
    def test_main_downloads_audio_transcribes_and_writes_srt(self) -> None:
        with tempfile.TemporaryDirectory(prefix="asr-worker-test-") as cache_dir:
            fake_yt_dlp = types.ModuleType("yt_dlp")
            fake_yt_dlp.YoutubeDL = FakeYoutubeDL
            fake_ctranslate2 = types.ModuleType("ctranslate2")
            fake_ctranslate2.get_cuda_device_count = lambda: 0
            fake_faster_whisper = types.ModuleType("faster_whisper")
            fake_faster_whisper.WhisperModel = FakeWhisperModel
            request = json.dumps({
                "bvid": "BV1234567890",
                "page": 2,
                "cacheDir": cache_dir,
                "batchSize": 32,
            })
            output = io.StringIO()
            with (
                mock.patch.dict(sys.modules, {
                    "yt_dlp": fake_yt_dlp,
                    "ctranslate2": fake_ctranslate2,
                    "faster_whisper": fake_faster_whisper,
                }),
                mock.patch.dict(os.environ, {}),
                mock.patch.object(sys, "stdin", io.StringIO(request)),
                redirect_stdout(output),
            ):
                exit_code = WORKER.main()

            self.assertEqual(exit_code, 0)
            result = json.loads(output.getvalue())
            self.assertTrue(result["ok"])
            self.assertEqual(result["bvid"], "BV1234567890")
            self.assertEqual(result["page"], 2)
            self.assertEqual(result["device"], "cpu")
            self.assertEqual(FakeYoutubeDL.requested_url, "https://www.bilibili.com/video/BV1234567890/?p=2")
            self.assertEqual(FakeWhisperModel.initialization, ("small", "cpu", "int8"))

            audio_path = Path(cache_dir) / "audio" / "BV1234567890-p2.m4a"
            subtitle_path = Path(cache_dir) / "subtitles" / "BV1234567890-p2.srt"
            self.assertEqual(audio_path.read_bytes(), b"mock downloaded audio")
            self.assertEqual(subtitle_path.read_text(encoding="utf-8"), (
                "1\n00:00:01,234 --> 00:00:02,345\n识别出的文本\n\n"
            ))
            self.assertEqual(result["cues"], [{
                "startMs": 1234,
                "endMs": 2345,
                "text": "识别出的文本",
            }])


class AsrBenchmarkTests(unittest.TestCase):
    def test_batch_search_doubles_until_the_input_clip_limit(self) -> None:
        self.assertEqual(BENCHMARK._batch_candidates(20, 8, 64), [8, 16, 20])

    def test_batch_search_refines_the_last_oom_interval(self) -> None:
        probed: list[int] = []

        def probe(batch_size: int) -> bool:
            probed.append(batch_size)
            return batch_size <= 5

        largest, completed = BENCHMARK._refine_batch_size(0, 8, probe)
        self.assertEqual((largest, completed), (5, True))
        self.assertEqual(probed, [4, 6, 5])

    def test_clip_partition_keeps_every_clip_in_time_order(self) -> None:
        clips = [
            {"start": index * 100, "end": (index + 1) * 100}
            for index in range(5)
        ]
        groups = BENCHMARK._partition_clips(clips, 2)
        self.assertEqual([clip for group in groups for clip in group], clips)
        self.assertTrue(all(groups[index][-1]["end"] <= groups[index + 1][0]["start"] for index in range(len(groups) - 1)))

    def test_chunk_merge_sorts_cues_and_removes_exact_overlap_duplicates(self) -> None:
        first = [{"startMs": 1_000, "endMs": 1_500, "text": "first"}]
        second = [
            {"startMs": 2_000, "endMs": 2_500, "text": "last"},
            {"startMs": 1_000, "endMs": 1_500, "text": "first"},
        ]
        self.assertEqual(BENCHMARK._merge_cues([first, second]), [
            {"startMs": 1_000, "endMs": 1_500, "text": "first"},
            {"startMs": 2_000, "endMs": 2_500, "text": "last"},
        ])


if __name__ == "__main__":
    unittest.main()
