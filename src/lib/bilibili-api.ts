/** Authenticated Bilibili JSON requests and comment submission. */

import { loggedFetch } from './http-log.ts'
import type { BilibiliCredential } from './login.ts'
import type { ConversationLog } from './conversation-log.ts'
import { assertReplyLength } from './reply-length.ts'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

/** Send one comment to a Bilibili video or comment thread.
 * @param oid - video aid or article id accepted by the reply endpoint.
 * @param type - Bilibili reply subject type.
 * @param root - root reply id, or `0` for a top-level comment.
 * @param parent - parent reply id, or `0` for a top-level comment.
 * @param content - public comment body.
 * @param credential - saved Bilibili login cookies.
 * @param signal - caller lifetime signal.
 * @param requestTimeoutMs - maximum request duration.
 * @param requestLog - plugin-wide HTTP request log.
 * @param conversationLog - optional per-item diagnostic log.
 * @throws when the reply exceeds the site limit, the request fails, or Bilibili rejects it.
 */
export async function postBilibiliComment(
  oid: string,
  type: number,
  root: string,
  parent: string,
  content: string,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  conversationLog?: ConversationLog,
): Promise<void> {
  assertReplyLength(content)
  const body = new URLSearchParams({
    oid,
    type: String(type),
    root,
    parent,
    message: content,
    csrf: credential.bili_jct,
  })
  const payload = await requestBilibiliJson(
    'https://api.bilibili.com/x/v2/reply/add',
    credential,
    signal,
    requestTimeoutMs,
    requestLog,
    conversationLog,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    },
  )
  const response = record(payload)
  if (response?.code !== 0) throw new Error(`Bilibili reply response returned code ${String(response?.code)}.`)
}

/** Make one authenticated request and parse Bilibili's JSON number ids exactly.
 * @param url - complete API endpoint URL.
 * @param credential - saved Bilibili login cookies.
 * @param signal - caller lifetime signal.
 * @param requestTimeoutMs - maximum request duration.
 * @param requestLog - plugin-wide HTTP request log.
 * @param conversationLog - optional per-item diagnostic log.
 * @param init - HTTP method, headers, and request body.
 * @param referer - browser page used as the API request referrer.
 * @returns parsed JSON from the API response.
 * @throws when the request fails or the body is not valid JSON.
 */
export async function requestBilibiliJson(
  url: string,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  conversationLog?: ConversationLog,
  init: Omit<RequestInit, 'headers' | 'signal'> & { headers?: HeadersInit } = {},
  referer = 'https://message.bilibili.com/',
): Promise<unknown> {
  const headers = new Headers(init.headers)
  headers.set('Cookie', cookieHeader(credential))
  headers.set('User-Agent', USER_AGENT)
  headers.set('Referer', referer)
  const response = await loggedFetch(url, {
    ...init,
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    cache: 'no-store',
  }, requestLog, conversationLog)
  if (!response.ok) throw new Error(`Bilibili request failed with HTTP ${String(response.status)}.`)
  return parseExactJson(await response.text())
}

function cookieHeader(credential: BilibiliCredential): string {
  return [
    `SESSDATA=${credential.sessdata}`,
    `bili_jct=${credential.bili_jct}`,
    ...(credential.buvid3.length > 0 ? [`buvid3=${credential.buvid3}`] : []),
    ...(credential.dedeuserid.length > 0 ? [`DedeUserID=${credential.dedeuserid}`] : []),
  ].join('; ')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Keep large integer ids exact when Node supplies JSON source context. */
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
