/** Poll Bilibili comment notifications and post contextual model replies. */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { transcribeBilibiliVideo, type AsrOptions } from './asr.ts'
import { createConversationLog, type ConversationLog } from './conversation-log.ts'
import { loggedFetch } from './http-log.ts'
import { readCredential, type BilibiliCredential } from './login.ts'

const API_ORIGIN = 'https://api.bilibili.com'
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const NOTIFICATION_STATE_FILE = 'notification-handled.json'

type NotificationKind = 'at' | 'reply'

interface FeedPosition {
  readonly id: string
  readonly time: string
}

interface FeedCursor extends FeedPosition {
  readonly isEnd: boolean
}

interface NotificationTarget {
  readonly key: string
  readonly oid: string
  readonly businessId: number
  readonly root: string
  readonly parent: string
  readonly sourceId: string
  readonly timestampMs?: number
  readonly sourceContent: string
  readonly title: string
  readonly uri: string
  readonly author: string
}

interface PendingNotification {
  readonly kind: NotificationKind
  readonly target: NotificationTarget
}

interface NotificationState {
  pending: PendingNotification[]
  handled: Set<string>
  feedHeads: Partial<Record<NotificationKind, FeedPosition>>
}

interface ContextMessage {
  readonly rpid: string
  readonly timestampMs: number
  readonly author: string
  readonly content: string
}

interface ArticleContext {
  readonly title: string
  readonly content: string
}

interface SubjectContext {
  readonly label: string
  readonly title: string
  readonly content: string
}

/** Result of one notification poll, including the no-login state. */
export interface NotificationPollResult {
  readonly state: 'no-credentials' | 'complete'
  readonly atReplies: number
  readonly replyReplies: number
}

/**
 * Check unread @ and reply notifications, processing replies before @ notifications.
 * @param stateDir - directory containing the saved Bilibili credential and notification state.
 * @param logDir - directory for individual notification attempt logs.
 * @param requestLog - plugin-wide log for upstream HTTP requests.
 * @param signal - plugin-lifetime signal used to cancel requests during unload.
 * @param requestTimeoutMs - maximum duration of each Bilibili HTTP request.
 * @param onUnreadCounts - called with the `/x/msgfeed/unread` data before feed processing starts.
 * @param onContext - called with the subject and timestamped comment context before generation.
 * @param generateReply - creates the public reply and records model diagnostics in the notification log.
 * @param onReply - called with the generated text and millisecond timestamp before posting.
 * @param onContextFailure - called when required context retrieval fails and posting is skipped.
 * @param onGenerationFailure - called when reply generation fails and posting is skipped.
 * @param asrOptions - local Whisper worker settings used to transcribe video notifications.
 * @param subprocess - Host-managed child-process service used by the ASR worker.
 * @returns the poll state and counts of successful replies.
 * @throws when Bilibili rejects a request or returns a malformed notification.
 */
export async function pollNotifications(
  stateDir: string,
  logDir: string,
  requestLog: ConversationLog,
  signal: AbortSignal,
  requestTimeoutMs: number,
  onUnreadCounts: (data: Readonly<Record<string, unknown>>) => void,
  onContext: (context: string) => void,
  generateReply: (context: string, signal: AbortSignal, log: ConversationLog) => Promise<string>,
  onReply: (kind: NotificationKind, timestampMs: number, content: string) => void,
  onContextFailure: (kind: NotificationKind, error: unknown) => void,
  onGenerationFailure: (kind: NotificationKind, error: unknown) => void,
  asrOptions?: AsrOptions,
  subprocess?: SubprocessRuntime,
): Promise<NotificationPollResult> {
  signal.throwIfAborted()
  const credential = readCredential(stateDir)
  if (credential === undefined) {
    return { state: 'no-credentials', atReplies: 0, replyReplies: 0 }
  }

  const unread = await readUnreadCounts(credential, signal, requestTimeoutMs, requestLog)
  onUnreadCounts(unread.data)
  const notificationState = readNotificationState(stateDir)
  const articleCache = new Map<string, Promise<ArticleContext>>()
  await enqueueFeedNotifications('reply', unread.reply, credential, stateDir, notificationState, signal, requestTimeoutMs, requestLog)
  await enqueueFeedNotifications('at', unread.at, credential, stateDir, notificationState, signal, requestTimeoutMs, requestLog)
  const replies = await processPendingNotifications(
    notificationState, credential, stateDir, logDir, requestLog, signal, requestTimeoutMs, articleCache,
    onContext, generateReply, onReply, onContextFailure, onGenerationFailure, asrOptions, subprocess,
  )

  return {
    state: 'complete',
    atReplies: replies.at,
    replyReplies: replies.reply,
  }
}

async function readUnreadCounts(
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
): Promise<{ at: number; reply: number; data: Readonly<Record<string, unknown>> }> {
  const payload = await requestJson(
    `${API_ORIGIN}/x/msgfeed/unread?platform=web&build=0&mobi_app=web`,
    credential,
    signal,
    requestTimeoutMs,
    requestLog,
  )
  const root = requireRecord(payload, 'unread response')
  requireSuccess(root, 'unread response')
  const data = requireRecord(root.data, 'unread data')
  return {
    at: unreadCount(data.at, 'at'),
    reply: unreadCount(data.reply, 'reply'),
    data,
  }
}

/** Scan feeds independently of unread counts and persist each new target before processing it. */
async function enqueueFeedNotifications(
  kind: NotificationKind,
  unreadCount: number,
  credential: BilibiliCredential,
  stateDir: string,
  state: NotificationState,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
): Promise<void> {
  let remaining = unreadCount
  let cursor: FeedCursor | undefined
  const seenCursors = new Set<string>()
  const previousHead = state.feedHeads[kind]
  let latestPosition: FeedPosition | undefined
  let reachedPreviousHead = false

  while (true) {
    signal.throwIfAborted()
    const page = await readFeedPage(kind, cursor, credential, signal, requestTimeoutMs, requestLog)
    if (page.items.length === 0) {
      if (remaining > 0) {
        throw new Error(`Bilibili ${kind} feed returned no items while ${String(remaining)} unread notifications remain.`)
      }
      break
    }
    const cursorKey = page.cursor === undefined ? undefined : `${page.cursor.id}:${page.cursor.time}`
    if (cursorKey !== undefined && seenCursors.has(cursorKey)) {
      throw new Error(`Bilibili ${kind} feed repeated its pagination cursor.`)
    }
    if (cursorKey !== undefined) seenCursors.add(cursorKey)

    for (const raw of page.items) {
      const position = notificationPosition(raw, kind)
      latestPosition ??= position
      const isUnreadByCount = remaining > 0
      const isNewSinceLastPoll = previousHead !== undefined && compareFeedPositions(position, previousHead) > 0
      if (previousHead === undefined) {
        if (isUnreadByCount) {
          const target = notificationTarget(raw, credential.dedeuserid, kind)
          enqueueNotification(stateDir, state, { kind, target })
          remaining -= 1
        }
        if (remaining === 0) break
      } else {
        if (isNewSinceLastPoll || isUnreadByCount) {
          const target = notificationTarget(raw, credential.dedeuserid, kind)
          enqueueNotification(stateDir, state, { kind, target })
        }
        if (isUnreadByCount) remaining -= 1
        if (compareFeedPositions(position, previousHead) <= 0 && remaining === 0) {
          reachedPreviousHead = true
          break
        }
      }
    }

    if (remaining === 0 && (previousHead === undefined || reachedPreviousHead)) break
    if (page.cursor === undefined || page.cursor.isEnd) {
      if (remaining > 0) throw new Error(`Bilibili ${kind} feed ended before all unread notifications were returned.`)
      break
    }
    cursor = page.cursor
  }

  if (latestPosition !== undefined && (
    previousHead === undefined || compareFeedPositions(latestPosition, previousHead) > 0
  )) {
    updateFeedHead(stateDir, state, kind, latestPosition)
  }
}

/** Process saved notifications and remove each queue item only after Bilibili accepts its reply. */
async function processPendingNotifications(
  state: NotificationState,
  credential: BilibiliCredential,
  stateDir: string,
  logDir: string,
  requestLog: ConversationLog,
  signal: AbortSignal,
  requestTimeoutMs: number,
  articleCache: Map<string, Promise<ArticleContext>>,
  onContext: (context: string) => void,
  generateReply: (context: string, signal: AbortSignal, log: ConversationLog) => Promise<string>,
  onReply: (kind: NotificationKind, timestampMs: number, content: string) => void,
  onContextFailure: (kind: NotificationKind, error: unknown) => void,
  onGenerationFailure: (kind: NotificationKind, error: unknown) => void,
  asrOptions: AsrOptions | undefined,
  subprocess: SubprocessRuntime | undefined,
): Promise<Record<NotificationKind, number>> {
  const replies: Record<NotificationKind, number> = { at: 0, reply: 0 }
  const queued = [
    ...state.pending.filter(notification => notification.kind === 'reply'),
    ...state.pending.filter(notification => notification.kind === 'at'),
  ]

  for (const notification of queued) {
    signal.throwIfAborted()
    const { kind, target } = notification
    if (state.handled.has(target.key)) {
      removePendingNotification(stateDir, state, target.key)
      continue
    }

    const log = createConversationLog(logDir, kind, target.sourceId)
    log.write('完整接口日志', requestLog.path)
    log.write('通知', JSON.stringify({ kind, ...target, key: undefined }, null, 2))
    let context: string
    try {
      log.write('获取上下文', '开始获取文章或视频内容和评论对话。')
      context = await buildNotificationContext(
        kind, target, credential, signal, requestTimeoutMs, articleCache, requestLog, log, asrOptions, subprocess,
      )
      log.write('模型输入：通知上下文', context)
      onContext(context)
    } catch (error) {
      log.write('获取上下文失败', errorMessage(error))
      if (signal.aborted) throw error
      onContextFailure(kind, error)
      continue
    }

    let content: string
    try {
      content = await generateReply(context, signal, log)
      signal.throwIfAborted()
      if (content.trim().length === 0) throw new Error('Reply generator returned empty text.')
    } catch (error) {
      log.write('模型生成失败', errorMessage(error))
      if (signal.aborted) throw error
      onGenerationFailure(kind, error)
      continue
    }

    onReply(kind, Date.now(), content)
    log.write('发送回复', content)
    try {
      await replyToTarget(target, content, credential, signal, requestTimeoutMs, requestLog, log)
    } catch (error) {
      log.write('发送失败', errorMessage(error))
      throw error
    }

    try {
      completeNotification(stateDir, state, target.key)
    } catch (error) {
      log.write('发送成功，但保存通知状态失败', errorMessage(error))
      throw error
    }
    replies[kind] += 1
    log.write('发送成功', 'B 站已接受回复，待办已移除并保存去重状态。')
  }

  return replies
}

/** Fetch one notification page, accepting both current and legacy @ response nesting. */
async function readFeedPage(
  kind: NotificationKind,
  cursor: FeedCursor | undefined,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
): Promise<{ items: unknown[]; cursor?: FeedCursor }> {
  const url = new URL(`${API_ORIGIN}/x/msgfeed/${kind}`)
  url.searchParams.set('platform', 'web')
  url.searchParams.set('build', '0')
  url.searchParams.set('mobi_app', 'web')
  if (cursor !== undefined) {
    url.searchParams.set('id', cursor.id)
    url.searchParams.set(kind === 'at' ? 'at_time' : 'reply_time', cursor.time)
  }

  const payload = await requestJson(url.toString(), credential, signal, requestTimeoutMs, requestLog)
  const root = requireRecord(payload, `${kind} response`)
  requireSuccess(root, `${kind} response`)
  const data = requireRecord(root.data, `${kind} data`)
  const total = asRecord(data.total)
  const rawItems = Array.isArray(data.items) ? data.items : total?.items
  if (!Array.isArray(rawItems)) throw new Error(`Bilibili ${kind} response has no items array.`)
  const rawCursor = asRecord(data.cursor) ?? asRecord(total?.cursor)
  const nextCursor = rawCursor === undefined ? undefined : feedCursor(rawCursor)
  return { items: rawItems, ...(nextCursor === undefined ? {} : { cursor: nextCursor }) }
}

/** Resolve the reply IDs, using a top-level source comment as its own root. */
function notificationTarget(value: unknown, accountMid: string, kind: NotificationKind): NotificationTarget {
  const notification = requireRecord(value, 'notification item')
  const item = requireRecord(notification.item, 'notification details')
  const user = asRecord(notification.user)
  const oid = readIdentifier(item.subject_id)
  const sourceId = readIdentifier(item.source_id)
  const rootId = readIdentifier(item.root_id)
  const targetId = readIdentifier(item.target_id) ?? '0'
  const businessId = item.business_id
  if (
    oid === undefined || sourceId === undefined
    || rootId === undefined
    || typeof businessId !== 'number' || !Number.isSafeInteger(businessId) || businessId <= 0
  ) {
    throw new Error('Bilibili notification is missing a usable comment ID or business type.')
  }

  const root = rootId !== '0' ? rootId : (sourceId !== '0' ? sourceId : targetId)
  const parent = sourceId === '0' ? (targetId === '0' ? root : targetId) : sourceId
  const timestampMs = unixMilliseconds(
    kind === 'at'
      ? notification.at_time ?? item.at_time ?? notification.reply_time ?? item.reply_time
      : notification.reply_time ?? item.reply_time,
  )
  return {
    key: `${accountMid}:${businessId}:${oid}:${root}:${parent}`,
    oid,
    businessId,
    root,
    parent,
    sourceId,
    ...(timestampMs === undefined ? {} : { timestampMs }),
    sourceContent: stringField(item.source_content),
    title: stringField(item.title),
    uri: stringField(item.uri),
    author: stringField(user?.nickname),
  }
}

/** Build subject material and timestamped comment context for the model. */
async function buildNotificationContext(
  kind: NotificationKind,
  target: NotificationTarget,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  articleCache: Map<string, Promise<ArticleContext>>,
  requestLog: ConversationLog,
  log: ConversationLog,
  asrOptions: AsrOptions | undefined,
  subprocess: SubprocessRuntime | undefined,
): Promise<string> {
  const subject = await readSubjectContext(
    target, credential, signal, requestTimeoutMs, articleCache, requestLog, log, asrOptions, subprocess,
  )
  const messages = kind === 'reply'
    ? await readReplyContext(target, credential, signal, requestTimeoutMs, requestLog, log)
    : [readMentionContext(target)]
  const lines = [
    `Notification context (${kind})`,
    `Subject type: ${subject.label}`,
    `Subject: ${subject.title || target.title || target.uri}`,
    subject.content,
    'Comment context:',
    ...messages
      .filter(message => message.content.length > 0)
      .sort((left, right) => left.timestampMs - right.timestampMs)
      .map(message => `[${String(message.timestampMs)}] ${message.author}: ${message.content}`),
  ]
  return lines.filter(line => line.length > 0).join('\n')
}

async function readSubjectContext(
  target: NotificationTarget,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  articleCache: Map<string, Promise<ArticleContext>>,
  requestLog: ConversationLog,
  log: ConversationLog,
  asrOptions: AsrOptions | undefined,
  subprocess: SubprocessRuntime | undefined,
): Promise<SubjectContext> {
  if (target.businessId === 12) {
    log.write('专栏内容', `开始获取专栏 ${target.oid}。`)
    const article = await readArticleContext(target, credential, signal, requestTimeoutMs, articleCache, requestLog, log)
    if (article.content.length === 0) throw new Error('Bilibili article response has no readable article body.')
    return { label: 'article', title: article.title, content: `Article content:\n${article.content}` }
  }
  if (target.businessId === 1) {
    try {
      log.write('视频转写', `开始下载视频 ${target.oid} 的音频并进行本地转写。`)
      const video = await transcribeVideoContext(target, signal, log, asrOptions, subprocess)
      log.write('视频转写', '本地转写完成。')
      return {
        label: 'video',
        title: video.title,
        content: `Video transcript (timestamps are relative to the video):\n${video.content}`,
      }
    } catch (error) {
      log.write('视频转写失败', errorMessage(error))
      throw error
    }
  }
  return {
    label: `Bilibili subject type ${String(target.businessId)}`,
    title: target.title,
    content: '',
  }
}

async function readArticleContext(
  target: NotificationTarget,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  cache: Map<string, Promise<ArticleContext>>,
  requestLog: ConversationLog,
  log: ConversationLog,
): Promise<ArticleContext> {
  if (target.businessId !== 12) return { title: target.title, content: '' }
  const key = `${target.businessId}:${target.oid}`
  let article = cache.get(key)
  if (article === undefined) {
    article = fetchArticleContext(target.oid, credential, signal, requestTimeoutMs, requestLog, log)
    cache.set(key, article)
  }
  return article
}

async function fetchArticleContext(
  articleId: string,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  log: ConversationLog,
): Promise<ArticleContext> {
  const url = new URL(`${API_ORIGIN}/x/article/view`)
  url.searchParams.set('id', articleId)
  const payload = await requestJson(url.toString(), credential, signal, requestTimeoutMs, requestLog, log)
  const root = requireRecord(payload, 'article response')
  requireSuccess(root, 'article response')
  const data = requireRecord(root.data, 'article data')
  return {
    title: stringField(data.title),
    content: articleContent(data.content) || articleContent(data.opus),
  }
}

async function transcribeVideoContext(
  target: NotificationTarget,
  signal: AbortSignal,
  log: ConversationLog,
  asrOptions: AsrOptions | undefined,
  subprocess: SubprocessRuntime | undefined,
): Promise<SubjectContext> {
  if (asrOptions === undefined) throw new Error('Local video transcription is not configured.')
  if (subprocess === undefined) throw new Error('The Host subprocess service is not available for local video transcription.')
  const { bvid, page } = videoReference(target.uri)
  log.write('视频输入标识', JSON.stringify({ aid: target.oid, bvid, page }))
  const transcript = await transcribeBilibiliVideo(bvid, page, asrOptions, subprocess, signal, log)
  log.write('本地转写字幕', transcript.source === 'cache'
    ? '字幕缓存命中：' + transcript.subtitlePath
    : '音频：' + transcript.audioPath + '\n字幕：' + transcript.subtitlePath)
  return {
    label: 'video',
    title: target.title,
    content: transcript.cues
      .map(cue => `[${videoTimestamp(cue.startMs)}] ${cue.text}`)
      .join('\n'),
  }
}

function videoReference(uri: string): { bvid: string; page: number } {
  let url: URL
  try {
    url = new URL(uri)
  } catch (error) {
    throw new Error('Bilibili notification has an invalid video URL.', { cause: error })
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || !(host === 'bilibili.com' || host.endsWith('.bilibili.com'))) {
    throw new Error('Bilibili notification video URL has an unexpected origin.')
  }
  const bvid = /^\/video\/(BV[0-9A-Za-z]{10})(?:\/|$)/.exec(url.pathname)?.[1]
  if (bvid === undefined) throw new Error('Bilibili notification URL has no valid BV id.')
  const rawPage = url.searchParams.get('p')
  if (rawPage === null) return { bvid, page: 1 }
  const page = Number(rawPage)
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Bilibili notification URL has an invalid page number.')
  return { bvid, page }
}

function videoTimestamp(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor(milliseconds / 60_000) % 60
  const seconds = Math.floor(milliseconds / 1_000) % 60
  const remainder = milliseconds % 1_000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

async function readReplyContext(
  target: NotificationTarget,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  log: ConversationLog,
): Promise<ContextMessage[]> {
  const messages: ContextMessage[] = []
  const seen = new Set<string>()
  let rootMessage: ContextMessage | undefined
  let expectedCount: number | undefined
  let pageNumber = 1

  while (expectedCount === undefined || messages.length < expectedCount) {
    const url = new URL(`${API_ORIGIN}/x/v2/reply/reply`)
    url.searchParams.set('type', String(target.businessId))
    url.searchParams.set('oid', target.oid)
    url.searchParams.set('root', target.root)
    url.searchParams.set('pn', String(pageNumber))
    url.searchParams.set('ps', '20')
    const payload = await requestJson(url.toString(), credential, signal, requestTimeoutMs, requestLog, log)
    const response = requireRecord(payload, 'reply thread response')
    requireSuccess(response, 'reply thread response')
    const data = requireRecord(response.data, 'reply thread data')
    const page = asRecord(data.page)
    if (typeof page?.count === 'number' && Number.isSafeInteger(page.count) && page.count >= 0) {
      expectedCount = page.count
    }
    const rawRoot = asRecord(data.root)
    if (rootMessage === undefined && rawRoot !== undefined) rootMessage = contextMessage(rawRoot)
    if (!Array.isArray(data.replies)) throw new Error('Bilibili reply thread response has no replies array.')
    const pageMessages = data.replies.flatMap((value) => {
      const record = asRecord(value)
      const message = record === undefined ? undefined : contextMessage(record)
      return message === undefined ? [] : [message]
    })
    const fresh = pageMessages.filter(message => !seen.has(message.rpid))
    for (const message of fresh) seen.add(message.rpid)
    messages.push(...fresh)

    if (expectedCount === undefined) {
      if (data.replies.length < 20) break
    } else if (messages.length >= expectedCount) {
      break
    }
    if (data.replies.length === 0 || fresh.length === 0) {
      throw new Error('Bilibili reply thread pagination stopped before all replies were read.')
    }
    pageNumber += 1
  }

  if (rootMessage !== undefined) messages.push(rootMessage)
  const current = messages.find(message => message.rpid === target.sourceId)
  const cutoff = target.timestampMs ?? current?.timestampMs
  const priorMessages = cutoff === undefined
    ? messages
    : messages.filter(message => message.timestampMs <= cutoff || message.rpid === target.sourceId)
  if (!priorMessages.some(message => message.rpid === target.sourceId) && target.sourceContent.length > 0) {
    if (cutoff === undefined) throw new Error('Bilibili reply notification has no usable comment timestamp.')
    priorMessages.push({
      rpid: target.sourceId,
      timestampMs: cutoff,
      author: target.author,
      content: target.sourceContent,
    })
  }
  if (priorMessages.length === 0) throw new Error('Bilibili reply thread returned no timestamped context.')
  return priorMessages
}

function readMentionContext(target: NotificationTarget): ContextMessage {
  if (target.timestampMs === undefined) throw new Error('Bilibili @ notification has no usable timestamp.')
  const content = target.sourceContent
  if (content.length === 0) throw new Error('Bilibili @ notification has no comment text.')
  return {
    rpid: target.sourceId,
    timestampMs: target.timestampMs,
    author: target.author || 'unknown',
    content,
  }
}

function contextMessage(value: Record<string, unknown>): ContextMessage | undefined {
  const rpid = readIdentifier(value.rpid_str) ?? readIdentifier(value.rpid)
  const timestampMs = unixMilliseconds(value.ctime)
  const content = stringField(asRecord(value.content)?.message)
  if (rpid === undefined || timestampMs === undefined || content.length === 0) return undefined
  const member = asRecord(value.member)
  return {
    rpid,
    timestampMs,
    author: stringField(member?.uname) || stringField(member?.mid) || 'unknown',
    content,
  }
}

function articleContent(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return structuredText(JSON.parse(value))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return htmlText(value)
    }
  }
  return structuredText(value)
}

function structuredText(value: unknown): string {
  const parts: string[] = []
  collectStructuredText(value, '', parts)
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim()
}

function collectStructuredText(value: unknown, key: string, parts: string[]): void {
  if (typeof value === 'string') {
    if (['insert', 'text', 'content', 'plain_text'].includes(key) && value.length > 0) parts.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStructuredText(entry, '', parts)
    return
  }
  const record = asRecord(value)
  if (record === undefined) return
  for (const [childKey, child] of Object.entries(record)) collectStructuredText(child, childKey, parts)
}

function htmlText(value: string): string {
  return decodeHtmlEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim())
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([\da-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
}

function unixMilliseconds(value: unknown): number | undefined {
  const seconds = readIdentifier(value)
  if (seconds === undefined) return undefined
  const milliseconds = Number(seconds) * 1_000
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function replyToTarget(
  target: NotificationTarget,
  content: string,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  log: ConversationLog,
): Promise<void> {
  const body = new URLSearchParams({
    oid: target.oid,
    type: String(target.businessId),
    root: target.root,
    parent: target.parent,
    message: content,
    csrf: credential.bili_jct,
  })
  const payload = await requestJson(`${API_ORIGIN}/x/v2/reply/add`, credential, signal, requestTimeoutMs, requestLog, log, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body,
  })
  const root = requireRecord(payload, 'reply response')
  requireSuccess(root, 'reply response')
}

/** Make one authenticated API request without exposing cookie values in errors. */
async function requestJson(
  url: string,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  conversationLog?: ConversationLog,
  init: Omit<RequestInit, 'headers' | 'signal'> & { headers?: HeadersInit } = {},
): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('Cookie', cookieHeader(credential))
  headers.set('User-Agent', USER_AGENT)
  headers.set('Referer', 'https://message.bilibili.com/')
  const response = await loggedFetch(url, {
    ...init,
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    cache: 'no-store',
  }, requestLog, conversationLog)
  if (!response.ok) throw new Error(`Bilibili request failed with HTTP ${String(response.status)}.`)
  return parseExactJson(await response.text())
}

/** Keep large integer IDs exact when Node supplies the JSON source context. */
function parseExactJson(text: string): unknown {
  type JsonContext = { readonly source: string }
  type SourceAwareReviver = (this: unknown, key: string, value: unknown, context: JsonContext) => unknown
  const parse = JSON.parse as unknown as (source: string, reviver: SourceAwareReviver) => unknown
  return parse(text, (_key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context.source)) {
      return context.source
    }
    return value
  })
}

function readNotificationState(stateDir: string): NotificationState {
  const file = join(stateDir, NOTIFICATION_STATE_FILE)
  let data: unknown
  try {
    data = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { pending: [], handled: new Set(), feedHeads: {} }
    }
    throw new Error('Could not read notification state.', { cause: error })
  }
  const record = asRecord(data)
  if (
    (record?.version !== 1 && record?.version !== 2 && record?.version !== 3)
    || !Array.isArray(record.handled)
  ) {
    throw new Error('Notification state has an unsupported format.')
  }
  const keys: string[] = []
  for (const key of record.handled as unknown[]) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('Notification state has an unsupported format.')
    keys.push(key)
  }
  const pending: PendingNotification[] = []
  const pendingKeys = new Set<string>()
  if (record.version >= 2) {
    if (!Array.isArray(record.pending)) throw new Error('Notification state has an unsupported format.')
    for (const entry of record.pending) {
      if (!isPendingNotification(entry) || pendingKeys.has(entry.target.key)) {
        throw new Error('Notification state has an unsupported format.')
      }
      pending.push(entry)
      pendingKeys.add(entry.target.key)
    }
  }

  const feedHeads: NotificationState['feedHeads'] = {}
  if (record.version === 3) {
    const heads = asRecord(record.feedHeads)
    if (heads === undefined) throw new Error('Notification state has an unsupported format.')
    for (const kind of ['at', 'reply'] as const) {
      const position = heads[kind]
      if (position !== undefined) {
        if (!isFeedPosition(position)) throw new Error('Notification state has an unsupported format.')
        feedHeads[kind] = position
      }
    }
  }
  return { pending, handled: new Set(keys), feedHeads }
}

/** Add a newly discovered target durably before its context or reply is processed. */
function enqueueNotification(stateDir: string, state: NotificationState, notification: PendingNotification): void {
  const { key } = notification.target
  if (state.handled.has(key)) return
  const existingIndex = state.pending.findIndex(entry => entry.target.key === key)
  if (existingIndex >= 0) {
    const existing = state.pending[existingIndex]
    if (existing === undefined || existing.kind !== 'at' || notification.kind !== 'reply') return
    const pending = [...state.pending]
    pending[existingIndex] = notification
    writeNotificationState(stateDir, { pending, handled: state.handled, feedHeads: state.feedHeads })
    state.pending = pending
    return
  }
  const pending = [...state.pending, notification]
  writeNotificationState(stateDir, { pending, handled: state.handled, feedHeads: state.feedHeads })
  state.pending = pending
}

/** Remove a stale queue entry whose reply key is already recorded as handled. */
function removePendingNotification(stateDir: string, state: NotificationState, key: string): void {
  const pending = state.pending.filter(entry => entry.target.key !== key)
  if (pending.length === state.pending.length) return
  writeNotificationState(stateDir, { pending, handled: state.handled, feedHeads: state.feedHeads })
  state.pending = pending
}

/** Atomically remove a completed todo and record its key for later feed deduplication. */
function completeNotification(stateDir: string, state: NotificationState, key: string): void {
  const pending = state.pending.filter(entry => entry.target.key !== key)
  const handled = new Set(state.handled)
  handled.add(key)
  writeNotificationState(stateDir, { pending, handled, feedHeads: state.feedHeads })
  state.pending = pending
  state.handled = handled
}

/** Save a feed checkpoint only after every newly observed item has entered the durable queue. */
function updateFeedHead(
  stateDir: string,
  state: NotificationState,
  kind: NotificationKind,
  position: FeedPosition,
): void {
  const feedHeads = { ...state.feedHeads, [kind]: position }
  writeNotificationState(stateDir, { pending: state.pending, handled: state.handled, feedHeads })
  state.feedHeads = feedHeads
}

/** Persist pending notifications, feed checkpoints, and completed reply keys atomically. */
function writeNotificationState(stateDir: string, state: NotificationState): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, NOTIFICATION_STATE_FILE)
  const temporaryFile = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryFile, JSON.stringify({
      version: 3,
      pending: state.pending,
      handled: [...state.handled],
      feedHeads: state.feedHeads,
    }), {
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
        throw new Error('Could not remove the temporary notification state file.', { cause: cleanupError })
      }
    }
    throw new Error('Could not save notification state.', { cause: error })
  }
}

function isFeedPosition(value: unknown): value is FeedPosition {
  const record = asRecord(value)
  return typeof record?.id === 'string' && readIdentifier(record.id) !== undefined
    && typeof record.time === 'string' && readIdentifier(record.time) !== undefined
}

function notificationPosition(value: unknown, kind: NotificationKind): FeedPosition {
  const notification = requireRecord(value, 'notification item')
  const item = asRecord(notification.item)
  const id = readIdentifier(notification.id)
  const time = readIdentifier(
    kind === 'at'
      ? notification.at_time ?? item?.at_time ?? notification.reply_time ?? item?.reply_time
      : notification.reply_time ?? item?.reply_time,
  )
  if (id === undefined || time === undefined) {
    throw new Error(`Bilibili ${kind} notification is missing its feed ID or timestamp.`)
  }
  return { id, time }
}

function compareFeedPositions(left: FeedPosition, right: FeedPosition): number {
  const leftTime = BigInt(left.time)
  const rightTime = BigInt(right.time)
  if (leftTime !== rightTime) return leftTime > rightTime ? 1 : -1
  const leftId = BigInt(left.id)
  const rightId = BigInt(right.id)
  return leftId === rightId ? 0 : leftId > rightId ? 1 : -1
}

function isPendingNotification(value: unknown): value is PendingNotification {
  const record = asRecord(value)
  const target = asRecord(record?.target)
  if (target === undefined || (record?.kind !== 'at' && record?.kind !== 'reply')) return false
  const stringFields = ['key', 'oid', 'root', 'parent', 'sourceId', 'sourceContent', 'title', 'uri', 'author'] as const
  if (!stringFields.every(field => typeof target[field] === 'string')) return false
  if (String(target.key).length === 0) return false
  if (typeof target.businessId !== 'number' || !Number.isSafeInteger(target.businessId) || target.businessId <= 0) return false
  const timestampMs = target.timestampMs
  return timestampMs === undefined || (
    typeof timestampMs === 'number' && Number.isSafeInteger(timestampMs) && timestampMs >= 0
  )
}

function cookieHeader(credential: BilibiliCredential): string {
  return [
    `SESSDATA=${credential.sessdata}`,
    `bili_jct=${credential.bili_jct}`,
    ...(credential.buvid3.length > 0 ? [`buvid3=${credential.buvid3}`] : []),
    ...(credential.dedeuserid.length > 0 ? [`DedeUserID=${credential.dedeuserid}`] : []),
  ].join('; ')
}

function requireSuccess(root: Record<string, unknown>, subject: string): void {
  if (root.code !== 0) throw new Error(`Bilibili ${subject} returned code ${String(root.code)}.`)
}

function unreadCount(value: unknown, name: string): number {
  if (value === undefined) return 0
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw new Error(`Bilibili unread response has an invalid ${name} count.`)
}

function feedCursor(value: Record<string, unknown>): FeedCursor {
  const id = readIdentifier(value.id)
  const time = readIdentifier(value.time)
  if (id === undefined || time === undefined || typeof value.is_end !== 'boolean') {
    throw new Error('Bilibili notification cursor is incomplete.')
  }
  return { id, time, isEnd: value.is_end }
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
  return undefined
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  const result = asRecord(value)
  if (result === undefined) throw new Error(`Bilibili ${subject} is not an object.`)
  return result
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Recognize filesystem errors without treating unrelated failures as a missing file. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
