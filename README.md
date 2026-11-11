---
description: "Configures Bilibili QR login and automatic replies to unread @ and comment-reply notifications in a Host composition."
kind: "package-reference"
---

# @deepseek-ai/dsh-kydon-bilibili

English | [中文](README.zh.md)

## Summary

Sign in to Bilibili with the settings QR card, then let the Host generate and post replies to unread @ notifications and comment replies. The settings card asks before installing the locked local transcription dependencies; polling stays paused until setup succeeds. Video replies use downloaded audio and a local Whisper transcript, and the setup marker skips installation while the lock and environment remain unchanged.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the Host composition that owns the Bilibili login card.

### When to choose it

Use it when a signed-in Bilibili account should automatically post model-generated replies to unread @ and comment-reply notifications. The plugin does not process private messages, likes, or system notifications.

### Minimal mount configuration

The profile patch mounts the plugin with the defaults below; change these values in the plugin config.

```yaml
- id: dsh-kydon-bilibili
  name: '@deepseek-ai/dsh-kydon-bilibili'
  config:
    qrPollIntervalMs: 2000
    qrTimeoutMs: 180000
    notificationPollIntervalMs: 60000
    notificationRequestTimeoutMs: 20000
    replyGenerationTimeoutMs: 120000
```

| Field | Default | Meaning |
|---|---:|---|
| `qrPollIntervalMs` | `2000` | Delay between browser QR status requests. |
| `qrTimeoutMs` | `180000` | Maximum wait for one QR login. |
| `notificationPollIntervalMs` | `60000` | Delay between checks, from `10000` to `3600000` ms; the first check starts as soon as setup is ready. |
| `notificationRequestTimeoutMs` | `20000` | Request timeout, from `1000` to `120000` ms. |
| `replyGenerationTimeoutMs` | `120000` | Maximum model-generation duration, from `1000` to `300000` ms. |
| `asrPythonExecutable` | Platform-specific Python in the plugin's `.venv` | Python environment created by `uv sync`; override it when the environment is elsewhere. |
| `uvExecutable` | `uv` | uv command or absolute executable path used after the user approves setup. |
| `asrInstallTimeoutMs` | `1800000` | Maximum consented dependency-install duration, from `60000` to `7200000` ms. |
| `asrCacheDir` | Plugin's `.cache/` directory | Whisper model, downloaded audio, and SRT subtitle directory; relative paths resolve from the Host working directory. |
| `asrTimeoutMs` | `1800000` | Download and transcription timeout, from `10000` to `14400000` ms. |
| `asrBatchSize` | `32` | GPU transcription batch size, from `1` to `64`; CPU fallback uses direct transcription. |
| `logDir` | Plugin's `log/` directory | Directory for notification logs; relative paths resolve from the Host working directory. |

### Enable local video transcription

For each video notification, the plugin reads the BV id and page from the notification URL and checks the matching SRT cache first. On a cache miss or invalid subtitle, it downloads that page's audio with `yt-dlp` and transcribes it with the `faster-whisper` `small` model. The plugin does not call Bilibili subtitle APIs; `yt-dlp` makes the media-resolution requests needed to download audio and checks that the returned BV id matches the notification URL. Downloaded audio stays in `.cache/audio/`; generated SRT files stay in `.cache/subtitles/` with filenames containing the BV id and page. Later notifications reuse a valid matching subtitle before downloading audio. The Whisper model is cached in `.cache/`. The first run may download the model. Transcription checks for CUDA and tries GPU `float16` through `BatchedInferencePipeline` using the configured `asrBatchSize`, which defaults to `32`. If no CUDA device is available, or GPU model initialization or batched inference fails, it retries on CPU with `int8` using direct transcription. `asr-worker.py` uses the public video URL and does not read the plugin's login cookies; videos that require login, are inaccessible, or are otherwise restricted cannot use this local transcription path.

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) before starting the plugin. Select **Install** on the settings card to approve `uv sync --locked` in the plugin root. Notification polling and replies stay paused until setup succeeds; QR login remains available. After a successful install, the Host writes a marker under the DSH home directory and starts polling without a restart. Later starts skip installation when the marker matches `uv.lock` and the plugin `.venv` Python still exists; a changed lock or missing environment returns the card to the install state. The first video transcription downloads the Whisper model separately. `pyproject.toml` declares dependencies and uv project settings, `uv.lock` pins resolved versions, and `.python-version` selects Python 3.12.

Build and start the plugin from the Harness repository root:

```powershell
pnpm --filter @deepseek-ai/dsh-kydon-bilibili bundle
pnpm dsh web --patch .\dsh-kydon-bilibili\cordis.yml
```

Open the plugin's settings card and approve dependency installation. After sign-in, the card shows the Bilibili avatar, nickname, signature, sex, birthday, level, and MID. These profile fields are masked by default; select the eye button to reveal them. The Host keeps the login cookies and returns only these public profile fields to the browser. The dependency panel shows the Python environment and Whisper model with their current states. It offers Install while the environment is missing or setup failed and no management action when ready. When the Python environment is ready, the model can be downloaded or reinstalled from its row, which shows progress while the operation runs. A downloaded Whisper model has its own uninstall action; removing it keeps `.venv` and the marker, and makes the model download again on the next video transcription.

CUDA availability depends on CTranslate2's device detection and model loading; installing an NVIDIA driver alone does not guarantee that the Python environment can load the CUDA runtime. The transcription log records the selected device, CPU fallback reason, and audio/SRT paths. Reprocessing the same video page overwrites its audio and subtitle files; remove files in `.cache/audio/` and `.cache/subtitles/` when they are no longer needed.

### Rebuild after changing source

Run this command from the repository root after editing files under `src/`:

```powershell
pnpm --filter @deepseek-ai/dsh-kydon-bilibili bundle
```

The script compiles the Host and Client TypeScript projects, then rebuilds `lib/index.js` and `lib/client.js`. Stop and restart the running `dsh web` process to load the new bundles; `pnpm install` does not rebuild this plugin.

### Test audio transcription

Run the deterministic unit tests with Python's standard library; the tests replace `yt-dlp` and Whisper with fakes, so they do not contact Bilibili, load a model, or use the GPU:

```powershell
python -m unittest discover -s test -v
```

To compare direct transcription, increasing `BatchedInferencePipeline` batch sizes, and two- or three-worker VAD-clip partitioning, run the manual benchmark against an audio file already in `.cache/audio/`:

```powershell
.\.venv\Scripts\python.exe test\benchmark_asr_gpu.py --audio .cache\audio\your-audio.m4a --repeats 2
```

The benchmark doubles the batch size until the audio's VAD clip limit or configured maximum; after a CUDA out-of-memory result, it binary-searches the last safe interval. It prints aggregate timings, cue counts, and transcript-match flags without printing or saving recognized text. It requires a working CTranslate2 CUDA runtime; it reports when the GPU is visible but cannot run inference and does not install or change Python dependencies.

### View notification logs

Each unhandled notification attempt creates a UTF-8 `.log` file in `dsh-kydon-bilibili/log/` by default. The filename contains the millisecond start time, notification type, comment ID, and a unique ID. A retry creates a new file. The log records the notification, context retrieval, model input and output, provider-returned reasoning when available, and the result of posting the reply. Context failures also receive a file. The plugin does not write login credentials to these files. If a log write fails before posting, that reply is skipped.

Each plugin instance also creates a `*-requests-*.log` file. It records incoming plugin login routes and outgoing Bilibili requests, including method, host, path, query or form fields, selected headers, and outgoing HTTP status. Each conversation log records its own outgoing requests and points to the request log for the preceding unread-count and feed requests. Cookies, CSRF values, QR keys, and recognized URL signatures are redacted. Model-provider HTTP requests are owned by the DSH model adapter and are not included in this HTTP log.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The Host waits for the settings-card approval and a successful `uv sync --locked` before it starts `/x/msgfeed/unread` polling. A lock-digest marker in the DSH home directory skips later installs while the locked environment is present. QR login remains available while setup is pending. After setup, the Host processes reply notifications before @ notifications and prints unread counts to the server terminal. Article comments (`business_id=12`) include the article body. For video comments (`business_id=1`), it reads the BV id and page from the notification URL, downloads that page's audio, and generates timestamped SRT subtitles with local `faster-whisper`. The plugin does not call Bilibili subtitle APIs; `yt-dlp` makes the media-resolution requests needed to download audio and checks the BV id against the notification URL. Transcription tries CUDA GPU first and falls back to CPU `int8` when the GPU is unavailable or model loading or inference fails. Audio and SRT files remain in the configured cache directory. Reply notifications include the root and earlier thread replies, while @ notifications include only the current comment. Comment lines include Unix millisecond timestamps (`ctime` for thread comments and `at_time` for @ notifications). The Host sends this context to an isolated DSH Agent Session using the configured default model; tool execution is denied. It prints the collected context, then prints the generated reply with its Unix millisecond timestamp before posting through `/x/v2/reply/add`. If article text or local audio transcription is unavailable, video identifiers disagree, generation fails, or the model returns empty text, the notification is skipped. The conversation log records the video identifier, page, language, cue count, duration, audio and SRT paths, and local transcription device with any CPU fallback reason. Cordis effects own installation and polling; unload cancels and awaits the installer and poller.

Context retrieval failures are logged as warnings with the error message and no stack trace; the poller continues with the remaining notifications.

The notification state file (`notification-handled.json`) stores each newly fetched notification in a pending queue before context retrieval or model generation. Pending entries survive restarts and changes to Bilibili's unread count; the plugin removes one only after Bilibili accepts the reply and atomically records its handled key for feed deduplication. Context or generation failures leave the entry queued for a later poll. The Host reads both feeds on every poll, even when unread counts are zero, and saves a newest-item checkpoint for each feed. Later polls queue items newer than that checkpoint, so a notification read between polls can still be handled while it remains in the feed. On first run or migration from an older state file, unread counts seed the queue and the current feed head becomes the baseline; older items already read before that baseline cannot be distinguished from history. If Bilibili accepts a reply but the local state write fails, a later poll can send that reply again. The handled-key list grows as the plugin processes more comments.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation, login routes, and poller lifecycle. |
| [`src/lib/login.ts`](src/lib/login.ts) | QR login, account-profile requests, and credential storage. |
| [`src/lib/notifications.ts`](src/lib/notifications.ts) | Unread feeds, replies, and deduplication state. |
| [`src/lib/conversation-log.ts`](src/lib/conversation-log.ts) | Per-notification log file creation and appends. |
| [`src/lib/http-log.ts`](src/lib/http-log.ts) | Redacted request and response-status logging. |
| [`src/lib/asr.ts`](src/lib/asr.ts) | Starts the local audio-download and transcription worker. |
| [`src/lib/asr-setup.ts`](src/lib/asr-setup.ts) | Consent-gated uv installation, readiness marker, and setup lifecycle. |
| [`asr-worker.py`](asr-worker.py) | Downloads page audio and creates subtitles with GPU-first, CPU-fallback `faster-whisper`. |
| [`src/lib/reply.ts`](src/lib/reply.ts) | Isolated Agent sessions and model-generated reply text. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read the source files for the complete request and lifecycle details.

- [`src/index.ts`](src/index.ts) — Host plugin configuration and effects.
- [`src/lib/login.ts`](src/lib/login.ts) — QR login and local credentials.
- [`src/lib/notifications.ts`](src/lib/notifications.ts) — Notification polling and comment replies.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

Each unhandled notification with usable context creates one isolated Agent Session. The model sees the article body for article comments, timestamped text transcribed from video audio, and the relevant timestamped thread or current @ comment. The Session system prompt asks the model to write a concise Simplified Chinese reply of no more than 1,000 characters. The notification context and assistant output are recorded as messages. Tool calls are denied for this Agent.

#### Token effect

The article body or transcript and relevant comment messages enter each model request. Long source content can exceed the selected model's context limit; generation then fails and the plugin skips that notification.

#### KV Cache effect

Each notification uses a new Session, so earlier notification content does not enter later replies. Provider-side reuse of the stable reply-policy prefix is adapter-owned.

## Known Limitations and Deferred Work

The poller only handles comment @ and reply notifications.

- Notification polling stays paused until the user approves ASR dependency installation in the plugin settings card; deferring or failing setup also pauses article replies.
- Bilibili API or local-state errors stop the current poll; the next scheduled poll retries saved pending notifications and scans both feeds again.
- The 1,000-character reply limit is a prompt instruction, not a posting-time check; longer output can be rejected by Bilibili and retried on the next poll.
- The first saved feed checkpoint cannot recover notifications already read before that baseline; later read-before-poll recovery depends on Bilibili continuing to return those entries in the feed.
- Multiple Host processes sharing one plugin data directory can race and send duplicate replies.
- The local deduplication file grows with the number of handled comments.
- A process failure after Bilibili accepts a reply but before local state is saved can cause a duplicate reply.
- When session persistence is configured, each isolated reply Session remains stored after its live Agent is disposed.
- Video replies require downloadable public audio; the local `small` model can make recognition errors, omit speech, or group subtitle cues differently when GPU batching is enabled. Bilibili subtitle APIs are not part of this flow.
- Local transcription needs the uv-managed Python 3.12 environment, `yt-dlp`, `faster-whisper`, and downloadable model files. GPU use requires CUDA to be available to the installed CTranslate2 runtime; otherwise CPU `int8` runs and may be slower. Download or transcription timeouts skip the current notification.
- Downloaded audio and SRT files remain in the cache directory and can use substantial disk space; remove them when no longer needed. Conversation logs remain on disk and can contain comments, article text, transcripts, and model reasoning. Delete them when no longer needed.
- The HTTP log grows until the plugin stops; a restart creates a new file. Its redacted parameters must be supplied separately when replaying a request.

<a id="dev-note"></a>
### Dev Note

None.
