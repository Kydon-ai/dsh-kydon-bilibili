/** Fetch Bilibili popular, personalized recommendation, and search candidates. */

import { createHash as createNodeHash } from 'node:crypto'
import { requestBilibiliJson } from './bilibili-api.ts'
import type { BilibiliCredential } from './login.ts'
import type { ConversationLog } from './conversation-log.ts'

const API_ORIGIN = 'https://api.bilibili.com'
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
] as const

/** Source used to discover a public video for a summary comment. */
export type VideoDiscoverySource = 'popular' | 'recommendation' | 'search'

/** Video fields needed for transcription and a grounded public comment. */
export interface VideoCandidate {
  readonly aid: string
  readonly bvid: string
  readonly title: string
  readonly description: string
  readonly durationSeconds: number | null
  readonly source: VideoDiscoverySource
  readonly searchKeyword: string | null
}

/** Candidates fetched from each discovery API in one scan. */
export interface VideoDiscoveryResults {
  readonly popular: readonly VideoCandidate[]
  readonly recommendations: readonly VideoCandidate[]
  readonly search: readonly VideoCandidate[]
  readonly searchKeyword: string
}

/** Fetch one page from each Bilibili discovery source.
 * @param credential - saved Bilibili login cookies.
 * @param signal - caller lifetime signal.
 * @param requestTimeoutMs - maximum duration of each API request.
 * @param requestLog - plugin-wide HTTP request log.
 * @param searchKeyword - configured term for the video search request.
 * @returns normalized candidates grouped by source.
 * @throws when an endpoint rejects the request or returns an unreadable payload.
 */
export async function discoverBilibiliVideos(
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  searchKeyword: string,
): Promise<VideoDiscoveryResults> {
  const key = await readWbiKey(credential, signal, requestTimeoutMs, requestLog)
  const [popularPayload, recommendationPayload, searchPayload] = await Promise.all([
    readSignedEndpoint('/x/web-interface/popular', { pn: 1, ps: 20, web_location: '333.934' }, key,
      credential, signal, requestTimeoutMs, requestLog, 'https://www.bilibili.com/v/popular/'),
    readSignedEndpoint('/x/web-interface/wbi/index/top/feed/rcmd', {
      fresh_type: 4,
      feed_version: 'V8',
      homepage_ver: 1,
      ps: 12,
      fresh_idx: 1,
      web_location: '1430650',
    }, key, credential, signal, requestTimeoutMs, requestLog, 'https://www.bilibili.com/'),
    readSignedEndpoint('/x/web-interface/wbi/search/type', {
      search_type: 'video',
      keyword: searchKeyword,
      order: 'totalrank',
      page: 1,
    }, key, credential, signal, requestTimeoutMs, requestLog, 'https://search.bilibili.com/'),
  ])

  return {
    popular: parseCandidateList(payloadList(popularPayload, 'popular', ['list']), 'popular'),
    recommendations: parseCandidateList(payloadList(recommendationPayload, 'recommendation', ['item', 'list']), 'recommendation'),
    search: parseCandidateList(payloadList(searchPayload, 'search', ['result']), 'search', searchKeyword),
    searchKeyword,
  }
}

async function readWbiKey(
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
): Promise<string> {
  const payload = await requestBilibiliJson(
    `${API_ORIGIN}/x/web-interface/nav`,
    credential,
    signal,
    requestTimeoutMs,
    requestLog,
    undefined,
    {},
    'https://www.bilibili.com/',
  )
  const root = requireRecord(payload, 'navigation response')
  requireSuccess(root, 'navigation response')
  const data = requireRecord(root.data, 'navigation data')
  const wbi = requireRecord(data.wbi_img, 'WBI image keys')
  const imageKey = keyFromImageUrl(wbi.img_url)
  const subKey = keyFromImageUrl(wbi.sub_url)
  const joined = imageKey + subKey
  if (joined.length < 64) throw new Error('Bilibili navigation response has incomplete WBI keys.')
  return MIXIN_KEY_ENC_TAB.map(index => joined[index] ?? '').join('').slice(0, 32)
}

function keyFromImageUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Bilibili navigation response has an invalid WBI image URL.')
  let path: string
  try {
    path = new URL(value).pathname
  } catch (error) {
    throw new Error('Bilibili navigation response has an invalid WBI image URL.', { cause: error })
  }
  const key = path.split('/').at(-1)?.replace(/\.[^.]+$/u, '')
  if (key === undefined || !/^[0-9A-Za-z]{32}$/u.test(key)) {
    throw new Error('Bilibili navigation response has an invalid WBI image key.')
  }
  return key
}

async function readSignedEndpoint(
  path: string,
  parameters: Readonly<Record<string, string | number>>,
  mixinKey: string,
  credential: BilibiliCredential,
  signal: AbortSignal,
  requestTimeoutMs: number,
  requestLog: ConversationLog,
  referer: string,
): Promise<unknown> {
  const url = signedUrl(`${API_ORIGIN}${path}`, parameters, mixinKey)
  const payload = await requestBilibiliJson(url, credential, signal, requestTimeoutMs, requestLog, undefined, {}, referer)
  const root = requireRecord(payload, path + ' response')
  requireSuccess(root, path + ' response')
  return payload
}

function signedUrl(base: string, parameters: Readonly<Record<string, string | number>>, mixinKey: string): string {
  const values = { ...parameters, wts: Math.floor(Date.now() / 1_000) }
  const canonical = Object.entries(values)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${encodeWbiPart(name)}=${encodeWbiPart(String(value))}`)
    .join('&')
  const wbiRid = createHash(canonical + mixinKey)
  return `${base}?${canonical}&w_rid=${wbiRid}`
}

function encodeWbiPart(value: string): string {
  return encodeURIComponent(value.replace(/[!'()*]/gu, ''))
}

function createHash(value: string): string {
  return createNodeHash('md5').update(value).digest('hex')
}

function payloadList(payload: unknown, subject: string, fieldNames: readonly string[]): readonly unknown[] {
  const root = requireRecord(payload, subject + ' response')
  const data = requireRecord(root.data, subject + ' data')
  for (const fieldName of fieldNames) {
    const value = data[fieldName]
    if (Array.isArray(value)) {
      if (fieldName !== 'result') return value
      const grouped = value.flatMap((entry) => {
        const group = asRecord(entry)
        if (group === undefined) return []
        if (group.result_type === 'video' && Array.isArray(group.data)) return group.data
        return []
      })
      return grouped.length > 0 ? grouped : value
    }
    if (fieldName === 'item' && asRecord(value) !== undefined) {
      const nested = asRecord(value)
      if (Array.isArray(nested?.item)) return nested.item
    }
  }
  throw new Error(`Bilibili ${subject} response has no video list.`)
}

function parseCandidateList(
  values: readonly unknown[],
  source: VideoDiscoverySource,
  searchKeyword: string | null = null,
): readonly VideoCandidate[] {
  const candidates: VideoCandidate[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const record = asRecord(value)
    if (record === undefined) continue
    const bvid = typeof record.bvid === 'string' ? record.bvid : ''
    const aid = readIdentifier(record.aid ?? record.id)
    if (!/^BV[0-9A-Za-z]{10}$/u.test(bvid) || aid === undefined || seen.has(bvid)) continue
    const title = stringField(record.title).replace(/<[^>]*>/gu, '').trim()
    if (title.length === 0) continue
    seen.add(bvid)
    candidates.push({
      aid,
      bvid,
      title,
      description: stringField(record.desc ?? record.description),
      durationSeconds: durationSeconds(record.duration),
      source,
      searchKeyword,
    })
  }
  return candidates
}

function durationSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value !== 'string' || !/^\d{1,3}:\d{2}:\d{2}$/u.test(value)) return null
  const parts = value.split(':').map(Number)
  if (parts.length !== 3) return null
  const [hours, minutes, seconds] = parts
  if (hours === undefined || minutes === undefined || seconds === undefined) return null
  return hours * 3_600 + minutes * 60 + seconds
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  return undefined
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  const result = asRecord(value)
  if (result === undefined) throw new Error(`Bilibili ${subject} is not an object.`)
  return result
}

function requireSuccess(root: Record<string, unknown>, subject: string): void {
  if (root.code !== 0) throw new Error(`Bilibili ${subject} returned code ${String(root.code)}.`)
}
