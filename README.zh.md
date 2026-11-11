---
description: "配置 B 站二维码登录，并在 Host 组合中自动回复未读的 @ 通知和评论回复。"
kind: "package-reference"
---

# @deepseek-ai/dsh-kydon-bilibili

[English](README.md) | 中文

## Summary

通过设置页二维码登录 B 站后，Host 会为未读的 @ 通知和评论回复生成并发送回复。设置卡片会先征求用户同意，再安装锁定的本地转写依赖；安装成功前暂停轮询。视频回复使用下载的音频和本地 Whisper 转写；锁文件和环境未变化时，安装标记会跳过后续安装。

## 目录

- [使用这个插件](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用这个插件

将这个插件挂载到提供 B 站登录卡片的 Host 组合中。

### 适用场景

当已登录的 B 站账号需要自动发布模型生成的 @ 通知和评论回复时使用。插件不处理私信、点赞或系统通知。

### 最小挂载配置

profile 补丁使用以下默认值挂载插件；可以在插件配置中修改这些值。

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

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `qrPollIntervalMs` | `2000` | 浏览器查询二维码状态的间隔。 |
| `qrTimeoutMs` | `180000` | 单次二维码登录的最长等待时间。 |
| `notificationPollIntervalMs` | `60000` | 检查间隔范围为 `10000` 到 `3600000` 毫秒；依赖就绪后立即执行首次检查。 |
| `notificationRequestTimeoutMs` | `20000` | 单个请求超时范围为 `1000` 到 `120000` 毫秒。 |
| `replyGenerationTimeoutMs` | `120000` | 模型生成回复的最长时间，范围为 `1000` 到 `300000` 毫秒。 |
| `asrPythonExecutable` | 插件 `.venv` 中的平台对应 Python | `uv sync` 创建的 Python 环境；环境放在其他位置时可覆盖。 |
| `uvExecutable` | `uv` | 用户同意安装后运行的 uv 命令或可执行文件绝对路径。 |
| `asrInstallTimeoutMs` | `1800000` | 用户同意的依赖安装最长时间，范围为 `60000` 到 `7200000` 毫秒。 |
| `asrCacheDir` | 插件 `.cache/` 目录 | Whisper 模型、下载音频和 SRT 字幕文件目录；相对路径相对于 Host 工作目录解析。 |
| `asrTimeoutMs` | `1800000` | 单次下载和转写超时，范围为 `10000` 到 `14400000` 毫秒。 |
| `asrBatchSize` | `32` | GPU 转写的 batch 大小，范围为 `1` 到 `64`；CPU 回退使用直接转写。 |
| `logDir` | 插件的 `log/` 目录 | 通知日志目录；相对路径相对于 Host 工作目录解析。 |

### 启用本地视频转写

处理每条视频通知时，插件从通知链接读取 BV 号和分 P，并先检查匹配的 SRT 缓存。缓存缺失或字幕无效时，才用 `yt-dlp` 下载对应音频，并用 `faster-whisper` 的 `small` 模型转写。插件不调用 B 站字幕接口；`yt-dlp` 会按下载流程请求解析和获取音频所需的媒体信息，并核对返回的 BV 号是否与通知链接一致。下载音频保存在 `.cache/audio/`；生成的 SRT 文件保存在 `.cache/subtitles/`，文件名包含 BV 号和分 P。后续通知会在下载音频前复用匹配且有效的字幕。Whisper 模型缓存到 `.cache/`。首次运行可能需要下载模型。转写先检测 CUDA，并使用配置的 `asrBatchSize`（默认 `32`）通过 `BatchedInferencePipeline` 尝试 GPU `float16` 批量转写。没有可用 CUDA 设备，或 GPU 模型初始化、批量推理失败时，会回退到 CPU `int8` 直接转写。`asr-worker.py` 使用公开视频地址，不读取插件登录 Cookie；需要登录、不可访问或受限的视频无法通过本地转写处理。

启动插件前请先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)。在设置卡片中点击“安装”以同意在插件根目录运行 `uv sync --locked`。环境安装成功前，Host 会暂停通知轮询和回复；二维码登录仍可用。安装成功后，Host 会在 DSH 用户目录写入标记并立即开始轮询，无需重启。后续启动时，如果标记仍匹配 `uv.lock` 且插件 `.venv` 中的 Python 仍存在，就会跳过安装；锁文件改变或环境缺失时，卡片会显示安装操作。首次处理视频时会单独下载 Whisper 模型。`pyproject.toml` 声明依赖和 uv 项目设置，`uv.lock` 固定解析版本，`.python-version` 选择 Python 3.12。

从 Harness 仓库根目录编译并启动插件：

```powershell
pnpm --filter @deepseek-ai/dsh-kydon-bilibili bundle
pnpm dsh web --patch .\dsh-kydon-bilibili\cordis.yml
```

打开插件设置卡片并同意安装依赖。登录后，卡片会显示 Bilibili 头像、昵称、签名、性别、生日、等级和 MID，默认脱敏；点击眼睛按钮可查看完整资料。Host 会保留登录 Cookie，只向浏览器返回这些公开账号资料。依赖面板会显示 Python 环境和 Whisper 模型的当前状态。环境缺失或安装失败时显示“安装”；环境就绪时不提供重装或卸载操作。Python 环境就绪后，可在模型所在行下载或重装模型，操作期间会显示进度。已下载的 Whisper 模型可单独卸载；卸载模型会保留 `.venv` 和标记，下次转写视频时会重新下载模型。

GPU 是否可用由 CTranslate2 的 CUDA 设备检测和模型加载结果决定；已安装 NVIDIA 驱动并不保证当前 Python 环境中的 CUDA 运行库可用。转写结果会记录所用设备、CPU 回退原因以及音频和 SRT 文件路径。重复处理同一视频分 P 时会覆盖对应音频和字幕文件；不再需要时可手动删除 `.cache/audio/` 和 `.cache/subtitles/` 中的文件。

### 修改源码后重新编译

在仓库根目录编辑 `src/` 下的文件后，运行：

```powershell
pnpm --filter @deepseek-ai/dsh-kydon-bilibili bundle
```

该脚本会编译 Host 和 Client 的 TypeScript 项目，然后重新生成 `lib/index.js` 和 `lib/client.js`。停止并重新启动正在运行的 `dsh web` 进程以加载新产物；`pnpm install` 不会重新编译这个插件。

### 测试音频转写

使用 Python 标准库运行确定性单元测试；测试会用替身替换 `yt-dlp` 和 Whisper，不会请求 B 站、加载模型或使用 GPU：

```powershell
python -m unittest discover -s test -v
```

要比较直接转写、逐步增大的 `BatchedInferencePipeline` batch size，以及按 VAD 片段分给 2 个或 3 个 worker 的方案，可使用 `.cache/audio/` 中已有的音频运行手动基准：

```powershell
.\.venv\Scripts\python.exe test\benchmark_asr_gpu.py --audio .cache\audio\your-audio.m4a --repeats 2
```

基准会从 8 开始逐步加倍 batch size，直到达到音频的 VAD 片段数或命令行上限；发生 CUDA 显存不足时，会在最后一个安全值与失败值之间二分查找。基准只输出汇总耗时、字幕条数和转写文本是否一致，不会打印或保存识别文本。它需要可实际执行推理的 CTranslate2 CUDA 运行库；如果只能检测到 GPU、却无法推理，会报告原因，并且不会安装或修改 Python 依赖。

### 查看通知日志

每次处理未去重的通知时，插件默认在 `dsh-kydon-bilibili/log/` 下创建一个 UTF-8 `.log` 文件。文件名包含开始时间的毫秒时间戳、通知类型、评论 ID 和唯一标识。重试会创建新文件。日志记录通知、上下文获取过程、模型输入输出、提供方返回的思考内容（如果有）以及回复发送结果。上下文获取失败时也会创建文件。插件不会把登录凭证写入这些文件。发送前写入日志失败时，该条回复会被跳过。

每个插件实例还会创建一个 `*-requests-*.log` 文件，记录前端调用的插件登录路由和插件发往 B 站的请求，包括方法、域名、路径、查询或表单参数、部分请求头以及外部请求的 HTTP 状态码。每份对话日志也会记录该条通知自身的外部请求，并指向完整接口日志，供查看此前的未读数和通知列表请求。Cookie、CSRF、二维码密钥和已识别的 URL 签名会被遮盖。模型提供方的 HTTP 请求由 DSH 模型适配器管理，不包含在这份接口日志中。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节 — 点击展开</summary>

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

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

阅读源文件可了解完整的请求和生命周期细节。

- [`src/index.ts`](src/index.ts) — Host 插件配置和 effect。
- [`src/lib/login.ts`](src/lib/login.ts) — 二维码登录和本地凭证。
- [`src/lib/notifications.ts`](src/lib/notifications.ts) — 通知轮询和评论回复。

-----

<a id="model-experience"></a>
## 模型体验

### 请求上下文和条件

#### 模型看到的内容

每条上下文可用且尚未处理的通知都会创建一个独立的 Agent Session。模型会看到专栏评论的文章正文、由视频音频转写得到的带时间轴文本，以及相关的带时间戳楼中楼对话或当前 @ 评论。Session 系统提示要求模型用简体中文生成简洁回复，正文不超过 1000 个字符。消息记录通知上下文和模型输出。该 Agent 的工具调用会被拒绝。

#### Token 影响

文章正文或视频转写文本以及相关评论会进入每次模型请求。原文过长时可能超出当前模型的上下文限制，生成失败后插件会跳过该通知。

#### KV Cache 影响

每条通知使用新的 Session，因此后续回复不会带入之前通知的内容。稳定回复规则前缀能否由 Provider 复用由适配器决定。

## 已知限制和后续工作

轮询器只处理评论区的 @ 和回复通知。

- 用户未在插件设置卡片同意安装 ASR 依赖前，通知轮询保持暂停；暂缓或安装失败时，专栏回复也会暂停。
- B 站 API 或本地状态报错会终止当前轮询；下一次定时轮询会重试已保存的待办通知并重新扫描两个通知列表。
- 1000 字符限制目前只是提示词要求，发送前不会强制校验；超长回复可能被 B 站拒绝，并在下一轮轮询时重试。
- 首次保存列表位置前已读掉的通知无法恢复；之后能否补抓轮询前已读的通知，取决于 B 站是否仍在列表中返回这些条目。
- 多个 Host 进程共享同一个插件数据目录时可能并发处理并重复回复。
- 本地去重文件会随已处理的评论数量增大。
- 如果进程在 B 站接收回复后、本地状态保存前退出，可能会重复回复。
- 配置了 Session 持久化后，每条回复的独立 Session 会在其运行中的 Agent 释放后继续保留。
- 视频回复需要可下载的公开音频；本地 `small` 模型转写可能出现识别错误、遗漏，或在启用 GPU 批量转写时改变字幕分段。视频字幕接口不参与该流程。
- 本地转写依赖 uv 管理的 Python 3.12 环境、`yt-dlp`、`faster-whisper` 和可下载的模型文件。GPU 运行需要当前 CTranslate2 环境能使用 CUDA；否则使用 CPU `int8`，速度可能较慢。下载或转写超时会跳过当前通知。
- 下载的音频和 SRT 文件会保留在缓存目录中，占用空间并可供检查；不需要时可删除。对话日志会保留在磁盘上，可能包含评论、文章正文、转写文本和模型思考内容。无需保留时可自行删除。
- 接口日志会持续增长直到插件停止；重启后创建新文件。重放请求时，需要自行补充被遮盖的参数。

<a id="dev-note"></a>
### 开发备注

无。
