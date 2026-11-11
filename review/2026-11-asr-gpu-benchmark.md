# ASR 单测与 GPU 策略基准记录

记录日期：2026-11-11。

## 测试内容

新增 `test/test_asr_worker.py`，通过替身验证 worker 会下载指定分 P 的音频、把音频文件保存到缓存目录、调用 ASR、过滤空文本并生成带毫秒时间戳的 SRT。测试不请求 B 站、不加载 Whisper 模型，也不使用 GPU。

新增 `test/benchmark_asr_gpu.py` 作为手动基准：先跑现有 direct 转写，再从 batch size 8 开始按倍数增加，候选上限取 VAD 片段数与命令行上限的较小值；遇到 CUDA 显存不足时，在最后一个安全值与失败值之间二分查找最大可运行值。随后用测得最快且文本与 direct 相同的安全 batch size，将完整 VAD 片段连续分配给 2 个或 3 个独立模型进程，按原始时间戳排序并合并字幕。faster-whisper 的片段 offset 保留在原音频时间轴上，因此合并不需要再次添加分片起点。

基准分别记录进程总耗时、模型加载耗时、转写耗时、字幕条数和识别文本一致性；终端不会输出或保存识别文本。下载音频与模型加载不计入单测，GPU 基准只读用户指定的现有音频文件，不计网络下载耗时。单模型路径在计时内执行自己的音频解码和 VAD；并行路径把一次 VAD 准备耗时加回并行总耗时，并单独保留 worker 耗时。

## 单测结果

在插件 `.venv` 中运行 `python -m unittest discover -s test -v`，5 项测试通过。README 中英文配对检查也通过。

## GPU 基准结果

当前设备为 NVIDIA GeForce RTX 4060，显存总量 8188 MiB；最后一次基准开始时空闲 5908 MiB。测试音频时长 515.1 秒，VAD 产生 20 个片段，因此本次输入的 batch 探测候选为 8、16、20；2/3 模型并行候选尚未启动。

插件 `.venv` 中 faster-whisper 为 1.2.1、CTranslate2 为 4.8.5；`ctranslate2.get_cuda_device_count()` 返回 1，但实际执行首次 GPU 推理失败：`Library cublas64_12.dll is not found or cannot be loaded`。机器当前 `CUDA_PATH` 指向 CUDA 11.3；当前 PATH、插件虚拟环境和 CUDA Toolkit 目录中未找到 `cublas64_12.dll` 或 `cudnn64_8.dll`。CTranslate2 的 Windows GPU wheel 需要 CUDA 12.x；faster-whisper 当前 GPU 安装说明要求 CUDA 12 的 cuBLAS 和 cuDNN 9。CTranslate2 从 4.6.3 起也提供纯 CUDA Conv1d，使 cuDNN 成为可选依赖；本次已确认的失败原因是缺少 cuBLAS 12。[faster-whisper GPU 安装说明](https://github.com/SYSTRAN/faster-whisper/blob/master/README.md#gpu)；[CTranslate2 变更记录](https://github.com/OpenNMT/CTranslate2/blob/master/CHANGELOG.md)

因此这次没有得到 batch size 或多实例方案的 GPU 耗时、吞吐和显存峰值；不能据此选出更快的方案。设备枚举成功只说明驱动看到了 GPU，不能说明推理运行库可用。ASR worker 遇到此类 GPU 推理错误时会按现有逻辑回退 CPU。

## 重跑方式

并行安装 CUDA Toolkit 12.x；保留原有 CUDA 11.3 和 Python 环境。按 faster-whisper 的 GPU 安装说明补齐 CUDA 12 的 cuBLAS 与 cuDNN 9 后，从插件目录运行：

```powershell
.\.venv\Scripts\python.exe test\benchmark_asr_gpu.py --audio .cache\audio\your-audio.m4a --repeats 2 --start-batch-size 8 --max-batch-size 64 --parallelisms 2 3
```

将音频路径替换为 `.cache/audio/` 中已有文件。脚本不安装或重装 Python 环境，也不会改写音频或保存转写文本。
