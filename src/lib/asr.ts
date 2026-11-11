/** Reuse cached subtitles or run the local Bilibili audio downloader and Whisper worker. */

import { mkdirSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ConversationLog } from './conversation-log.ts'

const MAX_WORKER_OUTPUT_BYTES = 32 * 1024 * 1024
const WORKER_GRACE_MS = 2_000
let transcriptionLocked = false
const transcriptionWaiters: TranscriptionWaiter[] = []

interface TranscriptionWaiter {
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (reason: unknown) => void
  onAbort: () => void
}

/** Host settings needed to run the packaged ASR worker. */
export interface AsrOptions {
  readonly pythonExecutable: string
  readonly workerPath: string
  readonly cacheDir: string
  readonly timeoutMs: number
  /** Batch size for CUDA transcription; CPU fallback uses direct transcription. */
  readonly batchSize: number
}

/** Timestamped speech recognized from one Bilibili video page. */
export interface AsrTranscript {
  readonly source: 'cache' | 'transcription'
  readonly bvid: string
  readonly page: number
  readonly model: 'small'
  readonly device: 'cuda' | 'cpu' | null
  readonly fallbackReason: string | null
  readonly durationSeconds: number | null
  readonly language: string | null
  readonly audioPath: string | null
  readonly subtitlePath: string
  readonly cues: readonly AsrCue[]
}

/** One Whisper segment with video-relative millisecond timestamps. */
export interface AsrCue {
  readonly startMs: number
  readonly endMs: number
  readonly text: string
}

/** Reuse valid subtitles for a video page or download its audio and transcribe it.
 * @param bvid - Bilibili video identifier selected from the notification URL.
 * @param page - one-based video page selected from the notification URL.
 * @param options - Python worker path, cache directory, and time limit.
 * @param subprocess - Host-managed process service used to run the worker.
 * @param signal - notification poll lifetime and cancellation signal.
 * @param log - per-notification log that receives request and transcript metadata.
 * @returns the identified video, cache source, and timestamped transcript cues.
 * @throws when a cache file cannot be read or the worker cannot start, times out, exceeds output limits, or returns invalid data.
 */
export async function transcribeBilibiliVideo(
  bvid: string,
  page: number,
  options: AsrOptions,
  subprocess: SubprocessRuntime,
  signal: AbortSignal,
  log: ConversationLog,
): Promise<AsrTranscript> {
  const release = await acquireTranscriptionLock(signal)
  try {
    signal.throwIfAborted()
    return await transcribeBilibiliVideoUnlocked(bvid, page, options, subprocess, signal, log)
  } finally {
    release()
  }
}

async function transcribeBilibiliVideoUnlocked(
  bvid: string,
  page: number,
  options: AsrOptions,
  subprocess: SubprocessRuntime,
  signal: AbortSignal,
  log: ConversationLog,
): Promise<AsrTranscript> {
  signal.throwIfAborted()
  const cached = await readCachedTranscript(bvid, page, options.cacheDir)
  signal.throwIfAborted()
  if (cached !== undefined) {
    log.write('本地音频转写缓存命中', JSON.stringify({ bvid, page, subtitlePath: cached.subtitlePath }))
    log.write('本地音频转写结果', JSON.stringify({
      bvid: cached.bvid,
      page: cached.page,
      model: cached.model,
      source: cached.source,
      device: cached.device,
      fallbackReason: cached.fallbackReason,
      language: cached.language,
      durationSeconds: cached.durationSeconds,
      subtitlePath: cached.subtitlePath,
      cueCount: cached.cues.length,
    }, null, 2))
    return cached
  }

  mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 })
  log.write('本地音频转写请求', JSON.stringify({
    bvid,
    page,
    model: 'small',
    preferredDevice: 'cuda',
    cpuFallback: 'int8',
    batchSize: options.batchSize,
    timeoutMs: options.timeoutMs,
  }, null, 2))
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const childSignal = AbortSignal.any([signal, timeoutSignal])
  let executable: string
  try {
    executable = await subprocess.resolveExecutable(options.pythonExecutable, undefined, childSignal)
  } catch (error) {
    signal.throwIfAborted()
    if (timeoutSignal.aborted) throw new Error(`Bilibili ASR exceeded ${String(options.timeoutMs)}ms.`, { cause: error })
    throw new Error(`ASR Python executable could not be resolved at ${options.pythonExecutable}.`, { cause: error })
  }
  const child = subprocess.spawn({
    argv: [executable, options.workerPath],
    cwd: options.cacheDir,
    env: workerEnvironment(options.cacheDir),
    signal: childSignal,
    graceMs: WORKER_GRACE_MS,
    stdio: {
      stdin: {
        data: JSON.stringify({ bvid, page, cacheDir: options.cacheDir, batchSize: options.batchSize }),
      },
      stdout: { maxBytes: MAX_WORKER_OUTPUT_BYTES },
      stderr: { maxBytes: MAX_WORKER_OUTPUT_BYTES },
    },
  })
  let outcome: Awaited<typeof child.done> | undefined
  let processError: unknown
  try {
    outcome = await child.done
  } catch (error) {
    processError = error
  } finally {
    await child.waitForExit()
  }

  if (signal.aborted) throw signal.reason ?? new Error('Bilibili ASR was cancelled.')
  if (timeoutSignal.aborted) throw new Error(`Bilibili ASR exceeded ${String(options.timeoutMs)}ms.`)
  if (processError !== undefined) throw new Error('Could not run the ASR Python worker.', { cause: processError })
  const stdout = child.collected.stdout?.readFrom(0)
  const stderr = child.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) throw new Error('ASR worker output was not collected.')
  if (stdout.lossy || stderr.lossy) throw new Error('Bilibili ASR worker output exceeded its size limit.')
  const diagnostic = stderr.text.trim()
  const transcript = readTranscript(stdout.text, bvid, page, outcome?.exitCode ?? null, diagnostic)
  log.write('本地音频转写结果', JSON.stringify({
    bvid: transcript.bvid,
    page: transcript.page,
    model: transcript.model,
    source: transcript.source,
    device: transcript.device,
    fallbackReason: transcript.fallbackReason,
    language: transcript.language,
    durationSeconds: transcript.durationSeconds,
    audioPath: transcript.audioPath,
    subtitlePath: transcript.subtitlePath,
    cueCount: transcript.cues.length,
    lastSubtitleSeconds: transcript.cues.reduce((latest, cue) => Math.max(latest, cue.endMs), 0) / 1_000,
  }, null, 2))
  return transcript
}

function acquireTranscriptionLock(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted()
  if (!transcriptionLocked) {
    transcriptionLocked = true
    return Promise.resolve(createTranscriptionRelease())
  }
  return new Promise((resolve, reject) => {
    const waiter: TranscriptionWaiter = {
      signal,
      resolve,
      reject,
      onAbort: () => {
        const index = transcriptionWaiters.indexOf(waiter)
        if (index === -1) return
        transcriptionWaiters.splice(index, 1)
        signal.removeEventListener('abort', waiter.onAbort)
        reject(signal.reason ?? new Error('Bilibili ASR was cancelled while waiting for another transcription.'))
      },
    }
    transcriptionWaiters.push(waiter)
    signal.addEventListener('abort', waiter.onAbort, { once: true })
    if (signal.aborted) waiter.onAbort()
  })
}

function createTranscriptionRelease(): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const next = transcriptionWaiters.shift()
    if (next === undefined) {
      transcriptionLocked = false
      return
    }
    next.signal.removeEventListener('abort', next.onAbort)
    next.resolve(createTranscriptionRelease())
  }
}

/** Read the subtitle previously written for one video page.
 * @param bvid - validated Bilibili video identifier.
 * @param page - one-based video page.
 * @param cacheDir - configured root for audio and subtitle artifacts.
 * @returns cached subtitle cues, or undefined when the file is missing or invalid.
 * @throws when the cache file cannot be read for a reason other than it being absent.
 */
async function readCachedTranscript(
  bvid: string,
  page: number,
  cacheDir: string,
): Promise<AsrTranscript | undefined> {
  const subtitlePath = join(cacheDir, 'subtitles', bvid + '-p' + String(page) + '.srt')
  let contents: string
  try {
    const file = await lstat(subtitlePath)
    if (!file.isFile() || file.size > MAX_WORKER_OUTPUT_BYTES) return undefined
    contents = await readFile(subtitlePath, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
  const cues = parseSrt(contents)
  if (cues === undefined) return undefined
  return {
    source: 'cache',
    bvid,
    page,
    model: 'small',
    device: null,
    fallbackReason: null,
    durationSeconds: null,
    language: null,
    audioPath: null,
    subtitlePath,
    cues,
  }
}

/** Parse only the numbered timestamp blocks written by this worker. */
function parseSrt(contents: string): readonly AsrCue[] | undefined {
  const normalized = contents.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim()
  if (normalized.length === 0) return undefined
  const blocks = normalized.split(/\n[ \t]*\n+/u)
  const cues: AsrCue[] = []
  for (const [index, block] of blocks.entries()) {
    const [number, timing, ...textLines] = block.split('\n')
    if (number !== String(index + 1) || timing === undefined || textLines.length === 0) return undefined
    const timingMatch = /^(\d{2,}:\d{2}:\d{2},\d{3}) --> (\d{2,}:\d{2}:\d{2},\d{3})$/u.exec(timing)
    if (timingMatch === null) return undefined
    const startMs = parseSrtTimestamp(timingMatch[1] ?? '')
    const endMs = parseSrtTimestamp(timingMatch[2] ?? '')
    const text = textLines.join('\n').trim()
    if (startMs === undefined || endMs === undefined || endMs < startMs || text.length === 0) return undefined
    cues.push({ startMs, endMs, text })
  }
  return cues
}

/** Convert one SRT timestamp to an integer video-relative millisecond value. */
function parseSrtTimestamp(value: string): number | undefined {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/u.exec(value)
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const milliseconds = Number(match[4])
  const total = (((hours * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds
  return Number.isSafeInteger(total) ? total : undefined
}

/** Download the small model into the configured Hugging Face cache without loading it into memory.
 * @param options - Python worker path, cache directory, and time limit.
 * @param subprocess - Host-managed process service used to run the worker.
 * @param signal - setup lifetime signal used to stop the download when the plugin unloads.
 * @returns when the worker confirms that all required model files are cached.
 * @throws when the worker cannot start, times out, exits unsuccessfully, or returns invalid data.
 */
export async function downloadWhisperModel(
  options: AsrOptions,
  subprocess: SubprocessRuntime,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  mkdirSync(options.cacheDir, { recursive: true, mode: 0o700 })
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const childSignal = AbortSignal.any([signal, timeoutSignal])
  let executable: string
  try {
    executable = await subprocess.resolveExecutable(options.pythonExecutable, undefined, childSignal)
  } catch (error) {
    signal.throwIfAborted()
    if (timeoutSignal.aborted) throw new Error('Whisper model download exceeded ' + String(options.timeoutMs) + 'ms.', { cause: error })
    throw new Error('ASR Python executable could not be resolved at ' + options.pythonExecutable + '.', { cause: error })
  }
  const child = subprocess.spawn({
    argv: [executable, options.workerPath],
    cwd: options.cacheDir,
    env: workerEnvironment(options.cacheDir),
    signal: childSignal,
    graceMs: WORKER_GRACE_MS,
    stdio: {
      stdin: { data: JSON.stringify({ operation: 'download-model', cacheDir: options.cacheDir }) },
      stdout: { maxBytes: MAX_WORKER_OUTPUT_BYTES },
      stderr: { maxBytes: MAX_WORKER_OUTPUT_BYTES },
    },
  })
  let outcome: Awaited<typeof child.done> | undefined
  let processError: unknown
  try {
    outcome = await child.done
  } catch (error) {
    processError = error
  } finally {
    await child.waitForExit()
  }

  if (signal.aborted) throw signal.reason ?? new Error('Whisper model download was cancelled.')
  if (timeoutSignal.aborted) throw new Error('Whisper model download exceeded ' + String(options.timeoutMs) + 'ms.')
  if (processError !== undefined) throw new Error('Could not run the ASR Python worker.', { cause: processError })
  const stdout = child.collected.stdout?.readFrom(0)
  const stderr = child.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) throw new Error('ASR worker output was not collected.')
  if (stdout.lossy || stderr.lossy) throw new Error('Whisper model download output exceeded its size limit.')
  let value: unknown
  try {
    value = JSON.parse(stdout.text)
  } catch (error) {
    throw new Error('ASR worker returned invalid Whisper model download data.', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ASR worker returned a non-object Whisper model download response.')
  }
  const result = value as Record<string, unknown>
  if (outcome?.exitCode !== 0 || result.ok !== true || result.model !== 'small') {
    throw new Error('ASR worker could not download the Whisper small model.')
  }
}

function workerEnvironment(cacheDir: string): NodeJS.ProcessEnv {
  return {
    HF_HOME: join(cacheDir, 'hf-cache'),
    HF_HUB_CACHE: join(cacheDir, 'hf-cache', 'hub'),
    HF_HUB_DISABLE_XET: '1',
    PYTHONUTF8: '1',
  }
}

/** Identify a missing subtitle cache file without suppressing other filesystem errors. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function readTranscript(
  output: string,
  expectedBvid: string,
  expectedPage: number,
  exitCode: number | null,
  diagnostic: string,
): AsrTranscript {
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch (error) {
    throw new Error(`ASR worker returned invalid JSON${diagnostic.length > 0 ? `: ${diagnostic.slice(-1_000)}` : '.'}`, { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ASR worker returned a non-object response.')
  }
  const result = value as Record<string, unknown>
  if (exitCode !== 0 || result.ok !== true) {
    const message = typeof result.error === 'string' ? result.error : `ASR worker exited with code ${String(exitCode)}.`
    throw new Error(message)
  }
  if (
    result.bvid !== expectedBvid
    || result.page !== expectedPage
    || result.model !== 'small'
    || (result.device !== 'cuda' && result.device !== 'cpu')
    || typeof result.durationSeconds !== 'number'
    || !Number.isFinite(result.durationSeconds)
    || typeof result.language !== 'string'
    || typeof result.audioPath !== 'string'
    || typeof result.subtitlePath !== 'string'
    || !(result.fallbackReason === null || typeof result.fallbackReason === 'string')
    || !Array.isArray(result.cues)
  ) {
    throw new Error('ASR worker returned invalid transcription metadata.')
  }
  const rawCues = result.cues as unknown[]
  const cues = rawCues.flatMap((value: unknown): AsrCue[] => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const cue = value as Record<string, unknown>
    if (
      typeof cue.startMs !== 'number' || !Number.isSafeInteger(cue.startMs) || cue.startMs < 0
      || typeof cue.endMs !== 'number' || !Number.isSafeInteger(cue.endMs) || cue.endMs < cue.startMs
      || typeof cue.text !== 'string' || cue.text.trim().length === 0
    ) {
      throw new Error('ASR worker returned an invalid subtitle cue.')
    }
    return [{ startMs: cue.startMs, endMs: cue.endMs, text: cue.text.trim() }]
  })
  if (cues.length === 0) throw new Error('Whisper did not recognize speech in the video audio.')
  return {
    source: 'transcription',
    bvid: expectedBvid,
    page: expectedPage,
    model: 'small',
    device: result.device,
    fallbackReason: result.fallbackReason,
    durationSeconds: result.durationSeconds,
    language: result.language,
    audioPath: result.audioPath,
    subtitlePath: result.subtitlePath,
    cues,
  }
}
