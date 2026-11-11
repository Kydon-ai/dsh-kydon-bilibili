/** Transcribe discovered videos and publish one bounded summary comment per selected video. */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { postBilibiliComment } from './bilibili-api.ts'
import { createConversationLog, type ConversationLog } from './conversation-log.ts'
import { readCredential } from './login.ts'
import { transcribeBilibiliVideo, type AsrOptions } from './asr.ts'
import { generateVideoSummaryComment } from './reply.ts'
import { assertReplyLength } from './reply-length.ts'
import { discoverBilibiliVideos, type VideoCandidate, type VideoDiscoverySource } from './video-discovery.ts'

const VIDEO_STATE_FILE = 'video-summary-state.json'
const MAX_REMEMBERED_VIDEOS = 2_000
const SOURCES: readonly VideoDiscoverySource[] = ['popular', 'recommendation', 'search']

/** Configuration for one video discovery and comment cycle. */
export interface VideoCommentOptions {
  readonly context: Context
  readonly stateDir: string
  readonly logDir: string
  readonly requestLog: ConversationLog
  readonly signal: AbortSignal
  readonly requestTimeoutMs: number
  readonly generationTimeoutMs: number
  readonly maxLengthRewrites: number
  readonly asrOptions: AsrOptions
  readonly subprocess: SubprocessRuntime
  readonly searchTerms: readonly string[]
  readonly maxVideosPerRun: number
  readonly maxVideoDurationSeconds: number
  readonly maxTranscriptCharacters: number
  readonly onComment?: (candidate: VideoCandidate, content: string) => void
  readonly onFailure?: (candidate: VideoCandidate | undefined, error: unknown) => void
}

/** Outcome counts for one video comment cycle. */
export interface VideoCommentRunResult {
  readonly state: 'no-credentials' | 'complete'
  readonly commentsPosted: number
  readonly videosSkipped: number
}

interface VideoCommentState {
  processedBvids: string[]
  sourceCursor: number
  searchTermIndex: number
}

/** Fetch all three discovery feeds, read eligible videos, and publish comments.
 * @param options - state, API, ASR, model, and per-cycle settings.
 * @returns the number of comments posted and video attempts skipped.
 * @throws when discovery fails, state cannot be read or saved, or the cycle is cancelled.
 */
export async function runVideoCommentCycle(options: VideoCommentOptions): Promise<VideoCommentRunResult> {
  const { signal } = options
  signal.throwIfAborted()
  const credential = readCredential(options.stateDir)
  if (credential === undefined) return { state: 'no-credentials', commentsPosted: 0, videosSkipped: 0 }

  const state = readVideoCommentState(options.stateDir)
  const searchTermIndex = state.searchTermIndex % options.searchTerms.length
  const searchKeyword = options.searchTerms[searchTermIndex]
  if (searchKeyword === undefined) throw new Error('Video search terms are empty.')
  state.searchTermIndex = (searchTermIndex + 1) % options.searchTerms.length
  writeVideoCommentState(options.stateDir, state)

  const results = await discoverBilibiliVideos(
    credential,
    signal,
    options.requestTimeoutMs,
    options.requestLog,
    searchKeyword,
  )
  const groups: Readonly<Record<VideoDiscoverySource, readonly VideoCandidate[]>> = {
    popular: results.popular,
    recommendation: results.recommendations,
    search: results.search,
  }
  const handled = new Set(state.processedBvids)
  const selectedThisRun = new Set<string>()
  let commentsPosted = 0
  let videosSkipped = 0

  while (commentsPosted + videosSkipped < options.maxVideosPerRun) {
    signal.throwIfAborted()
    const selection = selectCandidate(groups, state.sourceCursor, handled, selectedThisRun, options.maxVideoDurationSeconds)
    if (selection === undefined) break
    const { candidate, sourceIndex } = selection
    selectedThisRun.add(candidate.bvid)
    state.sourceCursor = (sourceIndex + 1) % SOURCES.length
    writeVideoCommentState(options.stateDir, state)

    const log = createConversationLog(options.logDir, 'video', candidate.aid)
    log.write('视频候选', JSON.stringify({ ...candidate, searchKeyword: candidate.searchKeyword ?? results.searchKeyword }, null, 2))
    try {
      signal.throwIfAborted()
      const transcript = await transcribeBilibiliVideo(
        candidate.bvid,
        1,
        options.asrOptions,
        options.subprocess,
        signal,
        log,
      )
      if (transcript.cues.length === 0) throw new Error('Video transcription returned no subtitle cues.')
      const prompt = videoCommentPrompt(candidate, transcript.cues, options.maxTranscriptCharacters)
      log.write('模型实际输入：视频信息和转写字幕', prompt)
      const generated = await generateVideoSummaryComment(
        options.context,
        prompt,
        signal,
        options.generationTimeoutMs,
        log,
        options.maxLengthRewrites,
      )
      assertReplyLength(generated)
      log.write('模型生成的视频评论', generated)
      signal.throwIfAborted()
      await postBilibiliComment(
        candidate.aid,
        1,
        '0',
        '0',
        generated,
        credential,
        signal,
        options.requestTimeoutMs,
        options.requestLog,
        log,
      )
      state.processedBvids = [...state.processedBvids.filter(bvid => bvid !== candidate.bvid), candidate.bvid]
        .slice(-MAX_REMEMBERED_VIDEOS)
      handled.add(candidate.bvid)
      writeVideoCommentState(options.stateDir, state)
      commentsPosted += 1
      options.onComment?.(candidate, generated)
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error
      videosSkipped += 1
      log.write('视频评论处理失败', error instanceof Error ? error.stack ?? error.message : String(error))
      options.onFailure?.(candidate, error)
    }
  }

  return { state: 'complete', commentsPosted, videosSkipped }
}

function selectCandidate(
  groups: Readonly<Record<VideoDiscoverySource, readonly VideoCandidate[]>>,
  sourceCursor: number,
  handled: ReadonlySet<string>,
  selectedThisRun: ReadonlySet<string>,
  maxDurationSeconds: number,
): { candidate: VideoCandidate; sourceIndex: number } | undefined {
  for (let offset = 0; offset < SOURCES.length; offset += 1) {
    const sourceIndex = (sourceCursor + offset) % SOURCES.length
    const source = SOURCES[sourceIndex]
    if (source === undefined) continue
    const candidate = groups[source].find((entry) => !handled.has(entry.bvid)
      && !selectedThisRun.has(entry.bvid)
      && (entry.durationSeconds === null || entry.durationSeconds <= maxDurationSeconds))
    if (candidate !== undefined) return { candidate, sourceIndex }
  }
  return undefined
}

function videoCommentPrompt(
  candidate: VideoCandidate,
  cues: readonly { readonly startMs: number; readonly text: string }[],
  maxCharacters: number,
): string {
  const sourceLines = cues.map(cue => `[${videoTimestamp(cue.startMs)}] ${cue.text}`)
  const fullTranscript = sourceLines.join('\n')
  const transcript = fitTranscript(sourceLines, fullTranscript.length, maxCharacters)
  const description = candidate.description.trim()
  return [
    '视频资料（仅用于事实核对）：',
    `标题：${candidate.title}`,
    `简介：${description || '（无简介）'}`,
    `来源：${candidate.source}${candidate.searchKeyword === null ? '' : `；搜索词：${candidate.searchKeyword}`}`,
    '带视频相对时间的转写字幕：',
    transcript,
  ].join('\n')
}

function fitTranscript(lines: readonly string[], fullLength: number, maxCharacters: number): string {
  if (fullLength <= maxCharacters) return lines.join('\n')
  const label = `[字幕较长，以下字幕按字幕顺序均匀抽样；全文 ${String(fullLength)} 字符。]\n`
  const contentBudget = maxCharacters - label.length
  let stride = Math.max(2, Math.ceil(fullLength / contentBudget))
  let selected: string[]
  let result: string
  do {
    selected = lines.filter((_line, index) => index % stride === 0)
    result = selected.join('\n')
    stride += 1
  } while (result.length > contentBudget && stride <= lines.length + 1)
  return label + result.slice(0, contentBudget)
}

function videoTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const seconds = Math.floor(milliseconds / 1_000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function readVideoCommentState(stateDir: string): VideoCommentState {
  const file = join(stateDir, VIDEO_STATE_FILE)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { processedBvids: [], sourceCursor: 0, searchTermIndex: 0 }
    throw new Error('Could not read video comment state.', { cause: error })
  }
  const record = asRecord(value)
  if (record?.version !== 1 || !Array.isArray(record.processedBvids)) {
    throw new Error('Video comment state has an unsupported format.')
  }
  const processedBvids = record.processedBvids.filter((entry): entry is string => (
    typeof entry === 'string' && /^BV[0-9A-Za-z]{10}$/u.test(entry)
  ))
  if (processedBvids.length !== record.processedBvids.length) {
    throw new Error('Video comment state has an unsupported format.')
  }
  const sourceCursor = integerField(record.sourceCursor)
  const searchTermIndex = integerField(record.searchTermIndex)
  if (sourceCursor === undefined || sourceCursor >= SOURCES.length || searchTermIndex === undefined) {
    throw new Error('Video comment state has an unsupported format.')
  }
  return { processedBvids: [...processedBvids], sourceCursor, searchTermIndex }
}

function writeVideoCommentState(stateDir: string, state: VideoCommentState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, VIDEO_STATE_FILE)
  const temporaryFile = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryFile, JSON.stringify({ version: 1, ...state }), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporaryFile, file)
  } catch (error) {
    try {
      unlinkSync(temporaryFile)
    } catch (cleanupError) {
      if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
        throw new Error('Could not remove the temporary video comment state file.', { cause: cleanupError })
      }
    }
    throw new Error('Could not save video comment state.', { cause: error })
  }
}

function integerField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
