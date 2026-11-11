---
description: "配置 B 站二维码登录、未读评论通知自动回复和定时视频总结评论；模型会先读取本地转写字幕，再为已登录账号生成带时间轴的评论。"
kind: "package-reference"
---

<h1 align="center">dsh-kydon-bilibili</h1>

<p align="center"><em>面向 DSH 的 B 站二维码登录、通知自动回复和本地视频总结插件。</em></p>

<p align="center">
  <img src="assets/bilibili-plugin-icon.png" alt="B 站 DSH 插件图标" width="144" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@kydon/dsh-kydon-bilibili"><img src="https://img.shields.io/npm/v/%40kydon%2Fdsh-kydon-bilibili?label=npm" alt="npm 版本" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="许可证：MIT" /></a>
  <img src="https://img.shields.io/badge/DSH-Web-4c8bf5" alt="DSH Web" />
  <img src="https://img.shields.io/badge/ASR-faster--whisper%20small-00a9b7" alt="本地 faster-whisper small 转写" />
  <img src="https://img.shields.io/badge/Codex-assisted-6f42c1" alt="Codex 协助编写" />
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

<a id="summary"></a>
## 1. 简介

通过设置页二维码登录 B 站后，Host 会为未读的 @ 通知和评论回复生成并发送回复。启用视频评论后，它还会发现公开视频，先在本地转写，再发布带时间轴的总结评论。ASR 设置成功后才会启动这两个轮询器。

<a id="features"></a>
## 2. 功能概览

- **二维码登录：** 在 DSH 设置卡片中扫码登录 B 站账号。
- **通知自动回复：** 轮询未读 @ 和评论回复；失败的待处理通知会保留以便重试，并对已处理通知去重。生成的回复在发送前会检查 B 站 1000 字符限制。
- **本地视频转写：** 下载可访问的公开视频音频，使用 `faster-whisper` `small` 模型转写。CUDA 可用时优先 GPU 批量推理，失败时回退到 CPU。字幕按 BV 号和分 P 缓存以便复用。
- **定时视频总结：** 轮换热门、推荐和搜索视频，调用随包提供的 `cc-summary` skill 生成带时间轴的总结，并发布为顶层评论。视频评论默认开启，可通过 `videoCommentEnabled: false` 关闭。
- **用户确认本地环境：** 在设置卡片中同意后才安装 `uv` 转写环境；Whisper 模型在首次转写时另行下载。

<a id="install"></a>
## 3. 安装

将插件添加到 DSH profile：

```powershell
dsh plugin --profile web add @kydon/dsh-kydon-bilibili
```

## 目录

- [1. 简介](#summary)
- [2. 功能概览](#features)
- [3. 安装](#install)
- [4. 使用这个插件](#use-this-package)
- [5. 了解实现](#understand-the-implementation)
- [6. 进一步阅读](#further-exploration)
- [7. 模型体验](#model-experience)
- [8. 已知限制和后续工作](#known-limitations-and-deferred-work)
- [8.1 开发备注](#dev-note)
- [9. 致谢](#acknowledgements)

-----

<a id="use-this-package"></a>
## 4. 使用这个插件

将这个插件挂载到提供 B 站登录卡片的 Host 组合中。

### 4.1 适用场景

当已登录的 B 站账号需要自动回复未读 @ 和评论回复，并按默认设置每十分钟发布一条模型生成的视频总结评论时使用。设置 `videoCommentEnabled: false` 可停止视频评论，同时保留通知回复。

### 4.2 最小挂载配置

profile 补丁使用以下默认值挂载插件；可以在插件配置中修改这些值。

```yaml
- id: dsh-kydon-bilibili
  name: '@kydon/dsh-kydon-bilibili'
  config:
    qrPollIntervalMs: 2000
    qrTimeoutMs: 180000
    notificationPollIntervalMs: 60000
    notificationRequestTimeoutMs: 20000
    replyGenerationTimeoutMs: 120000
    videoCommentEnabled: true
    videoCommentIntervalMs: 600000
    videoCommentMaxPerRun: 1
```

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `qrPollIntervalMs` | `2000` | 浏览器查询二维码状态的间隔。 |
| `qrTimeoutMs` | `180000` | 单次二维码登录的最长等待时间。 |
| `notificationPollIntervalMs` | `60000` | 检查间隔范围为 `10000` 到 `3600000` 毫秒；依赖就绪后立即执行首次检查。 |
| `notificationRequestTimeoutMs` | `20000` | 单个请求超时范围为 `1000` 到 `120000` 毫秒。 |
| `replyGenerationTimeoutMs` | `120000` | 模型生成回复的最长时间，范围为 `1000` 到 `300000` 毫秒。 |
| `replyLengthRewriteAttempts` | `2` | 回复超长后的额外模型重写次数，范围为 `0` 到 `5`。 |
| `videoCommentEnabled` | `true` | ASR 设置就绪后发布视频总结评论；设为 `false` 可仅保留通知回复。 |
| `videoCommentIntervalMs` | `600000` | 视频扫描间隔，范围为 `60000` 到 `3600000` 毫秒；ASR 设置就绪后立即执行首次扫描。 |
| `videoCommentMaxPerRun` | `1` | 每轮尝试处理的视频数，范围为 `1` 到 `3`。 |
| `videoCommentMaxDurationSeconds` | `1800` | 跳过已知时长超过该值的视频，范围为 `60` 到 `14400` 秒。 |
| `videoCommentMaxTranscriptCharacters` | `40000` | 发送给模型的字幕字符上限，范围为 `5000` 到 `100000`；更长的字幕会按字幕顺序均匀抽样。 |
| `videoCommentSearchTerms` | 五条默认中文搜索词 | 搜索 API 按顺序轮换使用；可配置 `1` 到 `20` 条非空搜索词。 |
| `asrPythonExecutable` | 插件 `.venv` 中的平台对应 Python | `uv sync` 创建的 Python 环境；环境放在其他位置时可覆盖。 |
| `uvExecutable` | `uv` | 用户同意安装后运行的 uv 命令或可执行文件绝对路径。 |
| `asrInstallTimeoutMs` | `1800000` | 用户同意的依赖安装最长时间，范围为 `60000` 到 `7200000` 毫秒。 |
| `asrCacheDir` | 插件 `.cache/` 目录 | Whisper 模型、下载音频和 SRT 字幕文件目录；相对路径相对于 Host 工作目录解析。 |
| `asrTimeoutMs` | `1800000` | 单次下载和转写超时，范围为 `10000` 到 `14400000` 毫秒。 |
| `asrBatchSize` | `32` | GPU 转写的 batch 大小，范围为 `1` 到 `64`；CPU 回退使用直接转写。 |
| `logDir` | 插件的 `log/` 目录 | 通知日志目录；相对路径相对于 Host 工作目录解析。 |

### 4.3 启用本地视频转写

处理每条视频通知时，插件从通知链接读取 BV 号和分 P，并先检查匹配的 SRT 缓存。缓存缺失或字幕无效时，才用 `yt-dlp` 下载对应音频，并用 `faster-whisper` 的 `small` 模型转写。插件不调用 B 站字幕接口；`yt-dlp` 会按下载流程请求解析和获取音频所需的媒体信息，并核对返回的 BV 号是否与通知链接一致。下载音频保存在 `.cache/audio/`；生成的 SRT 文件保存在 `.cache/subtitles/`，文件名包含 BV 号和分 P。后续通知会在下载音频前复用匹配且有效的字幕。Whisper 模型缓存到 `.cache/`。首次运行可能需要下载模型。转写先检测 CUDA，并使用配置的 `asrBatchSize`（默认 `32`）通过 `BatchedInferencePipeline` 尝试 GPU `float16` 批量转写。没有可用 CUDA 设备，或 GPU 模型初始化、批量推理失败时，会回退到 CPU `int8` 直接转写。`asr-worker.py` 使用公开视频地址，不读取插件登录 Cookie；需要登录、不可访问或受限的视频无法通过本地转写处理。

启动插件前请先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)。在设置卡片中点击“安装”以同意在插件根目录运行 `uv sync --locked`。环境安装成功前，Host 会暂停通知轮询和回复；二维码登录仍可用。安装成功后，Host 会在 DSH 用户目录写入标记并立即开始轮询，无需重启。后续启动时，如果标记仍匹配 `uv.lock` 且插件 `.venv` 中的 Python 仍存在，就会跳过安装；锁文件改变或环境缺失时，卡片会显示安装操作。首次处理视频时会单独下载 Whisper 模型。`pyproject.toml` 声明依赖和 uv 项目设置，`uv.lock` 固定解析版本，`.python-version` 选择 Python 3.12。

### 4.4 定时发布视频总结评论

ASR 设置成功后，Host 会立即运行一次视频扫描，之后按 `videoCommentIntervalMs` 毫秒间隔继续扫描。若尚未保存 B 站登录凭据，本轮会等待下一次定时扫描。将 `videoCommentEnabled` 设为 `false` 可关闭该轮询器，同时保留通知回复。

每轮会获取全站热门列表、当前账号的推荐列表，并使用下一条配置搜索词查询视频。来源游标会在热门、推荐和搜索之间轮换。默认每轮尝试处理一条视频；已知时长超过 `videoCommentMaxDurationSeconds` 的视频会跳过。模型会看到标题、简介以及缓存或新转写的字幕。字幕超过 `videoCommentMaxTranscriptCharacters` 时，插件会按字幕顺序均匀抽样。

默认搜索词依次轮换：“把复杂原理讲明白”“冷门但实用的生活技巧”“普通人做出的有趣实验”“最近值得关注的科技变化”和“一个问题的反直觉答案”。

模型按“开场、主要内容介绍、结尾”结构总结视频，时间轴事件各占一行，并在末尾给出基于字幕的简短评价。插件会将结果作为顶层评论发布，并使用与通知回复相同的 1000 字符长度检查。搜索词和来源游标保存在 DSH home 中。状态文件还会记录最近 2000 个已成功评论的视频 BV 号。

没有识别到可用语音的视频会被跳过，ASR 日志会明确记录原因。

生成视频评论前，Agent 会加入当前默认的 Agent 预设，以获得其中的 `skill` 工具和技能来源，然后加载可调用的 `cc-summary` 技能，并按它的字幕整理和评价规则生成评论。视频总结 Agent 只允许执行该技能加载工具；技能或工具缺失时会跳过本视频，不会用旧提示词继续发布。

从 Harness 仓库根目录编译并启动插件：

```powershell
pnpm --filter @kydon/dsh-kydon-bilibili bundle
pnpm dsh web --patch .\dsh-kydon-bilibili\cordis.yml
```

打开插件设置卡片并同意安装依赖。登录后，卡片会显示 Bilibili 头像、昵称、签名、性别、生日、等级和 MID，默认脱敏；点击眼睛按钮可查看完整资料。Host 会保留登录 Cookie，只向浏览器返回这些公开账号资料。依赖面板会显示 Python 环境和 Whisper 模型的当前状态。环境缺失或安装失败时显示“安装”；环境就绪时不提供重装或卸载操作。Python 环境就绪后，可在模型所在行下载或重装模型，操作期间会显示进度。已下载的 Whisper 模型可单独卸载；卸载模型会保留 `.venv` 和标记，下次转写视频时会重新下载模型。

GPU 是否可用由 CTranslate2 的 CUDA 设备检测和模型加载结果决定；已安装 NVIDIA 驱动并不保证当前 Python 环境中的 CUDA 运行库可用。转写结果会记录所用设备、CPU 回退原因以及音频和 SRT 文件路径。重复处理同一视频分 P 时会覆盖对应音频和字幕文件；不再需要时可手动删除 `.cache/audio/` 和 `.cache/subtitles/` 中的文件。

### 4.5 修改源码后重新编译

在仓库根目录编辑 `src/` 下的文件后，运行：

```powershell
pnpm --filter @kydon/dsh-kydon-bilibili bundle
```

该脚本会编译 Host 和 Client 的 TypeScript 项目，然后重新生成 `lib/index.js` 和 `lib/client.js`。停止并重新启动正在运行的 `dsh web` 进程以加载新产物；`pnpm install` 不会重新编译这个插件。

### 4.6 测试音频转写

使用 Python 标准库运行确定性单元测试；测试会用替身替换 `yt-dlp` 和 Whisper，不会请求 B 站、加载模型或使用 GPU：

```powershell
python -m unittest discover -s test -v
```

要比较直接转写、逐步增大的 `BatchedInferencePipeline` batch size，以及按 VAD 片段分给 2 个或 3 个 worker 的方案，可使用 `.cache/audio/` 中已有的音频运行手动基准：

```powershell
.\.venv\Scripts\python.exe test\benchmark_asr_gpu.py --audio .cache\audio\your-audio.m4a --repeats 2
```

基准会从 8 开始逐步加倍 batch size，直到达到音频的 VAD 片段数或命令行上限；发生 CUDA 显存不足时，会在最后一个安全值与失败值之间二分查找。基准只输出汇总耗时、字幕条数和转写文本是否一致，不会打印或保存识别文本。它需要可实际执行推理的 CTranslate2 CUDA 运行库；如果只能检测到 GPU、却无法推理，会报告原因，并且不会安装或修改 Python 依赖。

### 4.7 查看通知日志

每次处理未去重的通知时，插件默认在 `dsh-kydon-bilibili/log/` 下创建一个 UTF-8 `.log` 文件。文件名包含开始时间的毫秒时间戳、通知类型、评论 ID 和唯一标识。重试会创建新文件。日志记录通知、上下文获取过程、模型输入输出、提供方返回的思考内容（如果有）以及回复发送结果。上下文获取失败时也会创建文件。插件不会把登录凭证写入这些文件。发送前写入日志失败时，该条回复会被跳过。

每个插件实例还会创建一个 `*-requests-*.log` 文件，记录前端调用的插件登录路由和插件发往 B 站的请求，包括方法、域名、路径、查询或表单参数、部分请求头以及外部请求的 HTTP 状态码。每份对话日志也会记录该条通知自身的外部请求，并指向完整接口日志，供查看此前的未读数和通知列表请求。Cookie、CSRF、二维码密钥和已识别的 URL 签名会被遮盖。模型提供方的 HTTP 请求由 DSH 模型适配器管理，不包含在这份接口日志中。

-----

<a id="understand-the-implementation"></a>
## 5. 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

Host 会在用户批准设置卡片安装并成功执行 `uv sync --locked` 后开始 `/x/msgfeed/unread` 轮询。DSH home 中的锁摘要标记可在锁文件和环境未变化时跳过后续安装。ASR 设置等待期间仍可扫码登录。设置就绪后，Host 先处理回复通知，再处理 @ 通知，并在终端打印未读数。专栏评论（`business_id=12`）带文章正文；视频评论（`business_id=1`）从通知 URL 读取 BV 号和分 P，下载音频并通过本地 `faster-whisper` 生成带时间戳 SRT。插件不调用 B 站字幕 API；`yt-dlp` 负责解析媒体并核对 BV 号。转写优先尝试 CUDA，遇到 GPU 不可用、模型加载或推理失败时回退到 CPU `int8`。音频和 SRT 保留在配置的缓存目录。回复通知包含根评论和此前的楼中楼；@ 通知只包含当前评论。评论时间使用 Unix 毫秒时间戳（楼中楼为 `ctime`，@ 为 `at_time`）。Host 将这些上下文交给独立 DSH Agent Session 和默认模型，禁止工具调用。插件打印上下文和回复时间戳，然后调用 `/x/v2/reply/add`。文章或转写不可用、视频标识不匹配、生成失败或返回空文本时会跳过该通知。日志记录视频、分 P、语言、字幕段数、时长、音频与 SRT 路径、设备及 CPU 回退原因。Cordis effect 管理安装、通知轮询和视频评论调度；卸载时取消并等待活动任务结束。

ASR 设置就绪后，视频评论轮询器会与通知轮询同时启动。它会立即获取热门、个性化推荐和搜索结果，再按持久化的轮换顺序选择候选视频。流程复用现有的 BV 字幕缓存和本地 ASR worker，默认每轮生成并发布一条总结评论，并将成功评论的 BV 号写入 `video-summary-state.json`。共享的 ASR 队列会串行执行两个轮询器的转写任务，避免同时加载 Whisper 或争用字幕缓存。

获取上下文失败时，插件只在警告日志中输出错误原因，不打印堆栈，并继续处理剩余通知。

通知状态文件（`notification-handled.json`）会在获取通知后、读取上下文或调用模型前，先将通知写入待办队列。插件重启或 B 站未读数变化不会清除待办；只有 B 站接受回复后，插件才会移除待办并原子地保存已处理键，以便后续列表去重。上下文或模型生成失败时，待办会保留并在后续轮询重试。Host 每次轮询都会读取 @ 和回复列表，即使未读数为 0 也会保存各自最新通知的位置；后续轮询会将位置更新之后的通知加入待办，因此只要通知仍保留在列表中，轮询间被手动读掉的消息仍可处理。首次运行或从旧状态文件迁移时，当前未读数用于初始化待办，当前列表头部作为起点；在这个起点之前已经读过的历史消息无法与新通知区分。如果 B 站已接受回复，但本地状态写入失败，后续轮询仍可能重复发送。已处理键会随着评论数量增长。

| 源文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置校验、登录路由和轮询生命周期。 |
| [`src/lib/login.ts`](src/lib/login.ts) | 二维码登录、账号资料请求和凭证存储。 |
| [`src/lib/notifications.ts`](src/lib/notifications.ts) | 未读通知、回复和去重状态。 |
| [`src/lib/conversation-log.ts`](src/lib/conversation-log.ts) | 每条通知日志文件的创建与追加。 |
| [`src/lib/http-log.ts`](src/lib/http-log.ts) | 遮盖敏感参数后记录请求和响应状态。 |
| [`src/lib/asr.ts`](src/lib/asr.ts) | 启动本地音频下载和字幕转写 worker。 |
| [`src/lib/asr-setup.ts`](src/lib/asr-setup.ts) | 需要用户同意的 uv 安装、就绪标记和设置生命周期。 |
| [`asr-worker.py`](asr-worker.py) | 下载分 P 音频，并用 GPU 优先、CPU 回退的 `faster-whisper` 生成字幕。 |
| [`src/lib/reply.ts`](src/lib/reply.ts) | 独立 Agent Session 和模型生成的回复正文。 |
| [`src/lib/bilibili-api.ts`](src/lib/bilibili-api.ts) | 已登录 B 站请求和顶层评论发布。 |
| [`src/lib/video-discovery.ts`](src/lib/video-discovery.ts) | WBI 签名、热门、推荐和搜索列表。 |
| [`src/lib/video-comments.ts`](src/lib/video-comments.ts) | 视频转写、总结生成、评论发布和去重。 |

</details>

-----

<a id="further-exploration"></a>
## 6. 进一步阅读

阅读源文件可了解完整的请求和生命周期细节。

- [`src/index.ts`](src/index.ts) — Host 插件配置和 effect。
- [`src/lib/login.ts`](src/lib/login.ts) — 二维码登录和本地凭证。
- [`src/lib/notifications.ts`](src/lib/notifications.ts) — 通知轮询和评论回复。
- [`src/lib/video-comments.ts`](src/lib/video-comments.ts) — 视频转写和总结评论生命周期。
- [`src/lib/video-discovery.ts`](src/lib/video-discovery.ts) — B 站热门、推荐和签名搜索。

-----

<a id="model-experience"></a>
## 7. 模型体验

### 7.1 请求上下文和条件

#### 7.1.1 模型看到的内容

每条上下文可用且尚未处理的通知都会创建一个独立的 Agent Session。模型会看到专栏评论的文章正文、由视频音频转写得到的带时间轴文本，以及相关的带时间戳楼中楼对话或当前 @ 评论。Session 系统提示要求模型用简体中文生成不超过 1000 个字符的简洁回复，重写目标为 900 个字符。初稿超过 1000 个 UTF-16 代码单元时，Agent 会按 `replyLengthRewriteAttempts` 配置额外重写。插件会在报告回复准备发送前和调用 `/x/v2/reply/add` 前检查长度；超长结果不会发送。通知上下文和模型输出会记录为消息。该 Agent 的工具调用会被拒绝。

视频总结评论使用独立的 Agent Session。模型会看到视频标题、简介和不超过 `videoCommentMaxTranscriptCharacters` 个字符的带时间戳字幕；必要时会按字幕顺序从全片均匀抽取字幕。系统提示要求输出三个部分，并让时间轴的每个事件单独占一行；工具调用会被拒绝。超长初稿会按同一重写次数设置重新生成，最终评论仍须通过 1000 字符检查。

#### 7.1.2 Token 影响

文章正文或视频转写文本以及相关评论会进入每次模型请求。原文过长时可能超出当前模型的上下文限制，生成失败后插件会跳过该通知。

#### 7.1.3 KV Cache 影响

每条通知或视频都会使用新的 Session，因此后续回复和总结评论不会带入之前来源的内容。稳定策略前缀能否由 Provider 复用由适配器决定。

## 8. 已知限制和后续工作

通知轮询器处理评论区的 @ 和回复通知。独立的视频评论器会直接发布公开评论，不会逐条征求确认。

- 用户未在插件设置卡片同意安装 ASR 依赖前，通知轮询保持暂停；暂缓或安装失败时，专栏回复也会暂停。
- B 站 API 或本地状态报错会终止当前轮询；下一次定时轮询会重试已保存的待办通知并重新扫描两个通知列表。
- 配置次数的重写后，模型回复仍超过 1000 个 UTF-16 代码单元时，当前处理会跳过发送，通知留在待办队列供后续轮询重试。
- 首次保存列表位置前已读掉的通知无法恢复；之后能否补抓轮询前已读的通知，取决于 B 站是否仍在列表中返回这些条目。
- 多个 Host 进程共享同一个插件数据目录时可能并发处理并重复回复。
- 本地去重文件会随已处理的评论数量增大。
- 如果进程在 B 站接收回复后、本地状态保存前退出，可能会重复回复。
- 视频评论默认启用并会直接发布，不经过人工审核；设置 `videoCommentEnabled: false` 可关闭。
- 视频发现依赖 B 站的热门、推荐和搜索 API。接口变化或限流会跳过本轮；下一次定时扫描会重试。
- 评论器使用可公开下载的音频，并跳过已知时长超过 `videoCommentMaxDurationSeconds` 的视频。较长字幕会被抽样，因此模型可能漏掉抽样片段之间的细节。
- 视频状态只保留最近 2000 个成功评论的 BV 号。多个 Host 进程可能并发重复处理；若 B 站已接受评论但进程未保存状态就退出，也可能重复发布。
- 配置了 Session 持久化后，每条回复的独立 Session 会在其运行中的 Agent 释放后继续保留。
- 视频回复需要可下载的公开音频；本地 `small` 模型转写可能出现识别错误、遗漏，或在启用 GPU 批量转写时改变字幕分段。视频字幕接口不参与该流程。
- 本地转写依赖 uv 管理的 Python 3.12 环境、`yt-dlp`、`faster-whisper` 和可下载的模型文件。GPU 运行需要当前 CTranslate2 环境能使用 CUDA；否则使用 CPU `int8`，速度可能较慢。下载或转写超时会跳过当前通知。
- 下载的音频和 SRT 文件会保留在缓存目录中，占用空间并可供检查；不需要时可删除。对话日志会保留在磁盘上，可能包含评论、文章正文、转写文本和模型思考内容。无需保留时可自行删除。
- 接口日志会持续增长直到插件停止；重启后创建新文件。重放请求时，需要自行补充被遮盖的参数。

<a id="dev-note"></a>
### 8.1 开发备注

无。

<a id="acknowledgements"></a>
## 9. 致谢

本插件开发参考了以下 B 站相关项目和接口资料：

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：本插件运行和集成所依赖的 DSH 插件框架。
- [dsh-plugin-starter](https://github.com/lansi-ai/dsh-plugin-starter)：DSH 插件开发模板，以及 Host / Client 双端开发参考。
- [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)：同属 DSH 生态的 B 站插件，是本项目功能和插件集成的参考之一。
- [dsh-bilibili-reply](https://github.com/bronyacccxz/dsh-bilibili-reply)：面向 B 站 @ 通知的 DSH / AI Agent 回复项目，支持发布带时间戳的评论。
- [bilibili-api-collect](https://github.com/bilibili-plugins/bilibili-api-collect)：二维码登录、WBI 列表及请求响应结构的接口文档资料。
- [bilibili-video-transcriber](https://github.com/adolescen-he/bilibili-video-transcriber)：字幕错配问题的社区复现资料。
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) 和 [yt-dlp](https://github.com/yt-dlp/yt-dlp)：本地语音转写与公开视频音频下载所用的上游项目。
