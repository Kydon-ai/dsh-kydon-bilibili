/** Consent-gated installation of the locked local audio-transcription environment. */

import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { downloadWhisperModel as runWhisperModelDownload, type AsrOptions } from './asr.ts'

const MARKER_VERSION = 1
const INSTALL_GRACE_MS = 5_000
const INSTALL_LOG_MAX_LINES = 160
const INSTALL_LOG_MAX_CHARS = 24 * 1024
const INSTALL_LOG_MAX_LINE_CHARS = 2_000
const WHISPER_HUB_CACHE_REPO = 'models--Systran--faster-whisper-small'
const WHISPER_MODEL_FILES = ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.txt'] as const

type InstallOutputStream = 'stdout' | 'stderr'

/** Setup state and cache information returned by the Host setup manager. */
export interface AsrSetupSnapshot {
  /** Current state; `removing` means the Python environment is being removed. */
  readonly state: 'consent-required' | 'installing' | 'ready' | 'removing' | 'failed'
  /** Bounded, redacted output from the latest install or removal attempt. */
  readonly logs: readonly string[]
  /** Whether the complete Whisper small model is present in either configured cache location. */
  readonly whisperModelDownloaded: boolean
  /** Whether the Whisper small model download is in progress. */
  readonly whisperModelDownloading: boolean
  /** Whether the latest Whisper small model download failed. */
  readonly whisperModelDownloadFailed: boolean
  /** Whether removal of Whisper weights is in progress. */
  readonly whisperModelRemoving: boolean
  /** Whether the latest Whisper model removal failed. */
  readonly whisperModelRemovalFailed: boolean
}

/** Files and Host services used by the ASR dependency setup manager. */
export interface AsrSetupOptions {
  /** Plugin directory containing `pyproject.toml` and `uv.lock`. */
  readonly pluginDir: string
  /** Locked dependency file included with the plugin. */
  readonly lockPath: string
  /** Default Python executable created by `uv sync`. */
  readonly pythonExecutable: string
  /** Worker paths, cache directory, and timeout for model downloads. */
  readonly asrOptions: AsrOptions
  /** Cache directory containing Whisper weights, downloaded audio, and SRT files; model removal preserves media artifacts. */
  readonly cacheDir: string
  /** uv-managed environment directory removed by reinstall or explicit uninstall. */
  readonly environmentPath: string
  /** Persistent marker written only after a successful install. */
  readonly markerPath: string
  /** uv executable name or absolute path. */
  readonly uvExecutable: string
  /** Maximum installation duration in milliseconds. */
  readonly timeoutMs: number
  /** Host-managed subprocess capability. */
  readonly subprocess: SubprocessRuntime
  /** Starts notification polling after setup becomes ready. */
  readonly onReady: () => void
  /** Stops and awaits notification polling before environment changes or model operations. */
  readonly onPause: () => Promise<void>
  /** Reports setup diagnostics to the Host log. */
  readonly warn: (message: string) => void
}

/** Owns consent-gated dependency installation and its persisted lock marker. */
export class AsrSetupManager {
  private readonly lifetime = new AbortController()
  private state: AsrSetupSnapshot['state'] = 'consent-required'
  private whisperModelDownloading = false
  private whisperModelDownloadFailed = false
  private whisperModelRemoving = false
  private whisperModelRemovalFailed = false
  private readonly installLogs: string[] = []
  private installLogChars = 0
  private readonly pendingOutput: Record<InstallOutputStream, string> = { stdout: '', stderr: '' }
  private initialization: Promise<void> | undefined
  private installation: Promise<void> | undefined
  private modelDownload: Promise<void> | undefined
  private modelRemoval: Promise<void> | undefined
  private disposed = false

  /**
   * @param options - plugin paths, process capability, and lifecycle callbacks.
   */
  constructor(private readonly options: AsrSetupOptions) {
    if (resolve(options.environmentPath) !== resolve(options.pluginDir, '.venv')) {
      throw new Error('The removable ASR environment must be the plugin .venv directory.')
    }
  }

  /**
   * Read the install marker and return the current setup state.
   * @returns the current Python environment and model cache state.
   */
  async status(): Promise<AsrSetupSnapshot> {
    await this.initialize()
    return this.snapshot()
  }

  /**
   * Start the install after an explicit browser approval.
   * @returns the immediate state; installation continues independently of the request.
   */
  async requestInstall(reinstall = false): Promise<AsrSetupSnapshot> {
    await this.initialize()
    if (this.disposed || this.state === 'installing' || this.state === 'removing'
      || this.whisperModelDownloading || this.whisperModelRemoving || (!reinstall && this.state === 'ready')) {
      return this.snapshot()
    }

    this.state = 'installing'
    this.installation = (async () => {
      this.installLogs.length = 0
      this.installLogChars = 0
      if (reinstall) {
        this.appendInstallLog('stdout', 'Removing the existing uv environment before reinstall.')
      } else {
        this.appendInstallLog('stdout', 'Preparing the uv environment for installation.')
      }
      await this.options.onPause()
      await removePathIfPresent(this.options.markerPath)
      await removePathIfPresent(this.options.environmentPath)
      await this.installApproved()
    })().catch((error: unknown) => {
      if (this.disposed || this.lifetime.signal.aborted) return
      this.state = 'failed'
      const message = errorMessage(error)
      this.appendInstallLog('stderr', `Installation failed: ${message}`)
      this.options.warn(`ASR dependency installation failed: ${message}`)
    })
    return this.snapshot()
  }

  /**
   * Remove the Python environment and its readiness marker after pausing notification polling.
   * A cleanup failure leaves setup in `failed`; a later install request removes any remaining files before running uv.
   * @returns the immediate setup state; filesystem cleanup finishes in the background.
   */
  async removeEnvironment(): Promise<AsrSetupSnapshot> {
    await this.initialize()
    if (this.disposed || this.state !== 'ready' || this.whisperModelDownloading || this.whisperModelRemoving) return this.snapshot()

    this.state = 'removing'
    this.installation = (async () => {
      this.installLogs.length = 0
      this.installLogChars = 0
      this.appendInstallLog('stdout', 'Removing the Python transcription environment.')
      try {
        await this.options.onPause()
        await removePathIfPresent(this.options.markerPath)
        await removePathIfPresent(this.options.environmentPath)
        if (!this.disposed && !this.lifetime.signal.aborted) this.state = 'consent-required'
      } catch (error) {
        if (this.disposed || this.lifetime.signal.aborted) return
        this.state = 'failed'
        const message = errorMessage(error)
        this.appendInstallLog('stderr', `Environment removal failed: ${message}`)
        this.options.warn(`ASR environment removal failed: ${message}`)
      }
    })()
    return this.snapshot()
  }

  /** Download or replace Whisper weights while the Python environment stays ready.
   * The method pauses notification polling during the cache update.
   * @param reinstall - whether to remove cached weights before downloading them again.
   * @returns the immediate model-operation state; downloading finishes in the background.
   */
  async downloadWhisperModel(reinstall = false): Promise<AsrSetupSnapshot> {
    await this.initialize()
    if (this.disposed || this.state !== 'ready' || this.whisperModelDownloading || this.whisperModelRemoving) return this.snapshot()
    if (!reinstall && await whisperModelDownloaded(this.options.cacheDir)) return this.snapshot()
    this.whisperModelDownloading = true
    this.whisperModelDownloadFailed = false
    this.whisperModelRemovalFailed = false
    this.modelDownload = (async () => {
      try {
        await this.options.onPause()
        if (reinstall) {
          await removePathIfPresent(join(this.options.cacheDir, 'whisper-small'))
          await removePathIfPresent(join(
            this.options.cacheDir,
            'hf-cache',
            'hub',
            WHISPER_HUB_CACHE_REPO,
          ))
        }
        await runWhisperModelDownload(this.options.asrOptions, this.options.subprocess, this.lifetime.signal)
        if (!await whisperModelDownloaded(this.options.cacheDir)) {
          throw new Error('Whisper model download completed without all required files.')
        }
      } catch (error) {
        if (this.disposed || this.lifetime.signal.aborted) return
        this.whisperModelDownloadFailed = true
        this.options.warn('Whisper model download failed: ' + errorMessage(error))
      } finally {
        this.whisperModelDownloading = false
        if (!this.disposed && this.state === 'ready') this.options.onReady()
      }
    })()
    return this.snapshot()
  }

  /**
   * Remove cached Whisper weights while preserving the Python environment, install marker, and media artifacts.
   * The method pauses notification polling during cleanup and resumes it when setup remains ready. A removal
   * failure is reported in the returned snapshot instead of changing the Python setup state to failed.
   * @returns the immediate model-removal state; filesystem cleanup finishes in the background.
   */
  async removeWhisperModel(): Promise<AsrSetupSnapshot> {
    await this.initialize()
    if (this.disposed || this.state === 'installing' || this.state === 'removing'
      || this.whisperModelDownloading || this.whisperModelRemoving) return this.snapshot()
    if (!await whisperModelDownloaded(this.options.cacheDir)) return this.snapshot()
    this.whisperModelDownloadFailed = false
    this.whisperModelRemoving = true
    this.whisperModelRemovalFailed = false
    this.modelRemoval = (async () => {
      try {
        await this.options.onPause()
        await removePathIfPresent(join(this.options.cacheDir, 'whisper-small'))
        await removePathIfPresent(join(
          this.options.cacheDir,
          'hf-cache',
          'hub',
          WHISPER_HUB_CACHE_REPO,
        ))
      } catch (error) {
        this.whisperModelRemovalFailed = true
        this.options.warn(`Whisper model removal failed: ${errorMessage(error)}`)
      } finally {
        this.whisperModelRemoving = false
        if (!this.disposed && this.state === 'ready') this.options.onReady()
      }
    })()
    return this.snapshot()
  }

  /**
   * Cancel installation and wait until its managed process has exited.
   * @returns when initialization and installation have settled.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(new Error('Bilibili ASR setup disposed.'))
    await Promise.allSettled([
      this.initialization ?? Promise.resolve(),
      this.installation ?? Promise.resolve(),
      this.modelDownload ?? Promise.resolve(),
      this.modelRemoval ?? Promise.resolve(),
    ])
  }

  private initialize(): Promise<void> {
    this.initialization ??= this.readInstallationState()
    return this.initialization
  }

  /** 根据安装标记、当前锁文件摘要和 Python 可执行文件恢复依赖状态；全部有效时设为 ready 并触发启动轮询，否则设为 consent-required。 */
  private async readInstallationState(): Promise<void> {
    const lock = await readFile(this.options.lockPath)
    const lockDigest = digest(lock)
    let marker: unknown
    try {
      marker = JSON.parse(await readFile(this.options.markerPath, 'utf8')) as unknown
    } catch (error) {
      if (!isMissingFile(error)) this.options.warn(`ASR install marker could not be read; approval is required: ${errorMessage(error)}`)
      this.state = 'consent-required'
      return
    }

    if (!isRecord(marker) || marker.version !== MARKER_VERSION || marker.lockDigest !== lockDigest) {
      this.state = 'consent-required'
      return
    }
    try {
      const python = await stat(this.options.pythonExecutable)
      if (!python.isFile()) {
        this.state = 'consent-required'
        return
      }
    } catch (error) {
      if (!isMissingFile(error)) this.options.warn(`ASR Python environment could not be checked; approval is required: ${errorMessage(error)}`)
      this.state = 'consent-required'
      return
    }
    this.setReady()
  }

  private async installApproved(): Promise<void> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, timeout])
    const initialLockDigest = digest(await readFile(this.options.lockPath))
    signal.throwIfAborted()
    const executable = await this.options.subprocess.resolveExecutable(this.options.uvExecutable, undefined, signal)
    signal.throwIfAborted()
    const handle = this.options.subprocess.spawn({
      argv: [executable, 'sync', '--locked'],
      cwd: this.options.pluginDir,
      stdio: {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      },
      graceMs: INSTALL_GRACE_MS,
      signal,
    })
    this.captureStream('stdout', handle.stdout)
    this.captureStream('stderr', handle.stderr)
    let outcome: Awaited<typeof handle.done>
    try {
      outcome = await handle.done
    } finally {
      await handle.waitForExit()
    }
    if (this.lifetime.signal.aborted) return
    if (timeout.aborted) throw new Error(`uv sync exceeded ${String(this.options.timeoutMs)}ms`)
    if (outcome.exitCode !== 0) throw new Error(`uv sync exited with code ${String(outcome.exitCode)}`)
    const python = await stat(this.options.pythonExecutable)
    if (!python.isFile()) throw new Error('uv sync completed without creating the plugin Python executable')
    const lockDigest = digest(await readFile(this.options.lockPath))
    if (lockDigest !== initialLockDigest) throw new Error('uv.lock changed while the dependencies were being installed')
    signal.throwIfAborted()
    await writeMarker(this.options.markerPath, { version: MARKER_VERSION, lockDigest })
    this.setReady()
  }

  private setReady(): void {
    this.state = 'ready'
    if (!this.disposed) this.options.onReady()
  }

  /** 生成当前安装状态快照，并复制日志数组，避免调用方修改管理器内部的日志列表。 */
  private async snapshot(): Promise<AsrSetupSnapshot> {
    const modelDownloaded = await whisperModelDownloaded(this.options.cacheDir)
    if (modelDownloaded) this.whisperModelDownloadFailed = false
    return {
      state: this.state,
      logs: [...this.installLogs],
      whisperModelDownloaded: modelDownloaded,
      whisperModelDownloading: this.whisperModelDownloading,
      whisperModelDownloadFailed: this.whisperModelDownloadFailed,
      whisperModelRemoving: this.whisperModelRemoving,
      whisperModelRemovalFailed: this.whisperModelRemovalFailed,
    }
  }

  private captureStream(streamName: InstallOutputStream, stream: Readable | undefined): void {
    if (stream === undefined) return
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string | Buffer) => this.captureOutput(streamName, chunk.toString()))
    stream.on('end', () => this.flushOutput(streamName))
    stream.on('error', error => this.appendInstallLog(streamName, `Output stream error: ${error.message}`))
  }

  private captureOutput(streamName: InstallOutputStream, chunk: string): void {
    const lines = `${this.pendingOutput[streamName]}${chunk}`.split(/[\r\n]/u)
    this.pendingOutput[streamName] = lines.pop() ?? ''
    for (const line of lines) this.appendInstallLog(streamName, line)
  }

  private flushOutput(streamName: InstallOutputStream): void {
    const pending = this.pendingOutput[streamName]
    this.pendingOutput[streamName] = ''
    this.appendInstallLog(streamName, pending)
  }

  private appendInstallLog(streamName: InstallOutputStream, rawLine: string): void {
    const line = sanitizeInstallLog(rawLine)
    if (line.length === 0) return
    const entry = `${streamName}: ${line.slice(0, INSTALL_LOG_MAX_LINE_CHARS)}`
    this.installLogs.push(entry)
    this.installLogChars += entry.length
    while (this.installLogs.length > INSTALL_LOG_MAX_LINES || this.installLogChars > INSTALL_LOG_MAX_CHARS) {
      const removed = this.installLogs.shift()
      if (removed !== undefined) this.installLogChars -= removed.length
    }
  }
}

/** Write the successful lock digest using a private, exclusive temporary file. */
async function writeMarker(path: string, marker: { readonly version: number; readonly lockDigest: string }): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(path), `.asr-install-${randomUUID()}.tmp`)
  let created = false
  try {
    const file = await open(temporary, 'wx', 0o600)
    created = true
    try {
      await file.writeFile(`${JSON.stringify(marker)}\n`, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
    created = false
  } finally {
    if (created) {
      try {
        await unlink(temporary)
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    }
  }
}

/** Check the same local and Hugging Face cache locations used by the ASR worker. */
async function whisperModelDownloaded(cacheDir: string): Promise<boolean> {
  if (await hasWhisperModelFiles(join(cacheDir, 'whisper-small'))) return true
  const snapshots = join(cacheDir, 'hf-cache', 'hub', WHISPER_HUB_CACHE_REPO, 'snapshots')
  let entries: Dirent[]
  try {
    entries = await readdir(snapshots, { withFileTypes: true })
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
  for (const entry of entries) {
    if (entry.isDirectory() && await hasWhisperModelFiles(join(snapshots, entry.name))) return true
  }
  return false
}

/** Require every model file so an interrupted download does not appear complete. */
async function hasWhisperModelFiles(directory: string): Promise<boolean> {
  try {
    for (const name of WHISPER_MODEL_FILES) {
      if (!(await stat(join(directory, name))).isFile()) return false
    }
    return true
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

/** Narrow parsed marker values without trusting their file contents. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recognize a missing marker or Python environment without hiding other I/O failures. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Hash the exact lockfile bytes recorded by the setup marker. */
function digest(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

/** Remove only the named uv environment or marker, unlinking links without following them. */
async function removePathIfPresent(path: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(path)
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  if (info.isSymbolicLink()) {
    await unlink(path)
    return
  }
  if (info.isDirectory()) {
    await rm(path, { recursive: true })
    return
  }
  await unlink(path)
}

/** Remove terminal controls and common credential-bearing URL or assignment values. */
function sanitizeInstallLog(value: string): string {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/giu, '$1?[redacted]')
    .replace(/(https?:\/\/)[^/@\s]+@/giu, '$1[redacted]@')
    .replace(/\b(SESSDATA|bili_jct|csrf|cookie|token|password|secret|api[_-]?key|authorization)(\s*[:=]\s*)\S+/giu, '$1$2[redacted]')
    .replace(/\b(Bearer\s+)\S+/giu, '$1[redacted]')
    .trim()
}

/** Render one setup error for a server diagnostic. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
