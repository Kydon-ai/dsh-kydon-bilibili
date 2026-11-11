/** Record HTTP request details without recording credentials. */

import { randomUUID } from 'node:crypto'
import type { ConversationLog } from './conversation-log.ts'

const SECRET_NAME = /csrf|cookie|sessdata|bili_jct|buvid|qrcode_key|secret|ticket|password|^(key|token|sign|w_rid)$|auth.?key|access.?key|access.?token|refresh.?token|signature|authorization/i

function parameters(values: URLSearchParams): Array<{ name: string; value: string }> {
  return [...values].map(([name, value]) => ({ name, value: SECRET_NAME.test(name) ? '[已遮盖]' : value }))
}

function endpoint(address: string): { origin: string; path: string; query: Array<{ name: string; value: string }> } {
  const url = new URL(address)
  return { origin: url.origin, path: url.pathname, query: parameters(url.searchParams) }
}

function safeReferer(address: string): string {
  try {
    const url = endpoint(address)
    const query = new URLSearchParams(url.query.map(({ name, value }) => [name, value])).toString()
    return `${url.origin}${url.path}${query.length > 0 ? `?${query}` : ''}`
  } catch (error) {
    void error // A malformed Referer must not change the outgoing request.
    return '[无效地址]'
  }
}

/**
 * Record one incoming login route request.
 * @param log - running plugin's HTTP log.
 * @param method - HTTP method received by the Host.
 * @param path - registered route path.
 * @param body - recognized route body fields.
 */
export function logIncoming(log: ConversationLog, method: string, path: string, body?: URLSearchParams): void {
  log.write('前端调用 Host 接口', JSON.stringify({ method, path, body: body === undefined ? [] : parameters(body) }, null, 2))
}

/**
 * Fetch an HTTP resource and log the request and HTTP status.
 * @param address - absolute upstream URL.
 * @param init - request method, headers, optional form, and cancellation signal.
 * @param requestLog - plugin-wide HTTP log, when logging is enabled by the caller.
 * @param conversationLog - optional notification log receiving the same request record.
 * @returns the upstream response.
 * @throws when request logging or the fetch fails before a response arrives.
 */
export async function loggedFetch(
  address: string,
  init: RequestInit,
  requestLog?: ConversationLog,
  conversationLog?: ConversationLog,
): Promise<Response> {
  const logs = [requestLog, conversationLog].filter((log): log is ConversationLog => log !== undefined)
  const url = endpoint(address)
  const requestId = randomUUID()
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = new Headers(init.headers)
  const referer = headers.get('Referer')
  const request = {
    requestId,
    method,
    ...url,
    form: init.body instanceof URLSearchParams ? parameters(init.body) : [],
    headers: {
      ...(headers.has('User-Agent') ? { 'User-Agent': headers.get('User-Agent') } : {}),
      ...(headers.has('Content-Type') ? { 'Content-Type': headers.get('Content-Type') } : {}),
      ...(referer === null ? {} : { Referer: safeReferer(referer) }),
      ...(headers.has('Cookie') ? { Cookie: '[已遮盖]' } : {}),
    },
  }
  for (const log of logs) log.write('接口请求', JSON.stringify(request, null, 2))
  let response: Response
  try {
    response = await fetch(address, init)
  } catch (error) {
    writeAfterFetch(logs, '接口请求失败', JSON.stringify({ requestId, method, path: url.path, error: error instanceof Error ? error.name : 'Error' }))
    throw error
  }
  writeAfterFetch(logs, '接口响应', JSON.stringify({ requestId, method, path: url.path, status: response.status }))
  return response
}

function writeAfterFetch(logs: readonly ConversationLog[], stage: string, text: string): void {
  for (const log of logs) {
    try {
      log.write(stage, text)
    } catch (error) {
      console.warn('[dsh-kydon-bilibili] Could not record HTTP result.', error instanceof Error ? error.name : 'Error')
    }
  }
}
