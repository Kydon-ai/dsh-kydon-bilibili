/**
 * Bilibili QR login requests, QR rendering, and local credential storage.
 * Credentials are written only to the caller's DSH home directory.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as QRCode from 'qrcode'
import type { ConversationLog } from './conversation-log.ts'
import { loggedFetch } from './http-log.ts'

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const FINGERPRINT_URL = 'https://api.bilibili.com/x/frontend/finger/spi'
const ACCOUNT_PROFILE_URL = 'https://api.bilibili.com/x/space/myinfo'

/** Credential fields saved for the Bilibili MCP consumer. */
export interface BilibiliCredential {
  sessdata: string
  bili_jct: string
  buvid3: string
  dedeuserid: string
}

/** Public Bilibili account fields shown by the local login card. */
export interface BilibiliAccountProfile {
  readonly face: string
  readonly name: string
  readonly sign: string
  readonly sex: string
  readonly birthday: string | null
  readonly level: number | null
  readonly mid: string
}

/** One QR login poll result. Credentials occur only on success. */
export type LoginPollResult =
  | { state: 'ok'; code: 0; credential: BilibiliCredential }
  | { state: 'waiting' | 'scanned' | 'expired' | 'unknown'; code?: number; message: string }

/** One Bilibili QR challenge. */
export interface LoginChallenge {
  key: string
  url: string
}

/** 判断值是否为非 null、非数组的对象；符合时按键值对象返回，否则返回 undefined。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Recognize filesystem errors without treating unrelated failures as a missing file. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

/** Build the poll URL for one Bilibili QR challenge. */
function pollUrl(key: string): string {
  return `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`
}

/**
 * Request a Bilibili QR challenge.
 * @param signal - optional cancellation for the HTTP request.
 * @param requestLog - optional log for the outgoing HTTP request.
 * @returns the poll key and the URL encoded in the QR code.
 * @throws when the request fails or Bilibili returns an incomplete challenge.
 */
export async function loginStart(signal?: AbortSignal, requestLog?: ConversationLog): Promise<LoginChallenge> {
  const response = await loggedFetch(QR_GENERATE_URL, {
    headers: { 'User-Agent': USER_AGENT },
    ...signalOption(signal),
  }, requestLog)
  if (!response.ok) throw new Error(`Bilibili QR request failed with HTTP ${String(response.status)}`)

  const payload = record(await response.json())
  const data = record(payload?.data)
  const key = data?.qrcode_key
  const url = data?.url
  if (typeof key !== 'string' || key.length === 0 || typeof url !== 'string' || url.length === 0) {
    throw new Error(`Bilibili did not return a QR challenge: ${String(payload?.message ?? 'missing qrcode_key')}`)
  }
  return { key, url }
}

/**
 * Poll one Bilibili QR challenge and read login cookies from the successful response.
 * @param key - challenge key returned by {@link loginStart}.
 * @param signal - optional cancellation for the HTTP requests.
 * @param requestLog - optional log for outgoing HTTP requests.
 * @returns the challenge state and credentials only after confirmed login.
 * @throws when the request fails or is cancelled.
 */
export async function loginPoll(key: string, signal?: AbortSignal, requestLog?: ConversationLog): Promise<LoginPollResult> {
  const response = await loggedFetch(pollUrl(key), {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'manual',
    ...signalOption(signal),
  }, requestLog)

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    signal?.throwIfAborted()
    void error
    return { state: 'unknown', message: 'Bilibili returned an unreadable login response.' }
  }

  const data = record(record(payload)?.data)
  const codeValue = data?.code
  const code = typeof codeValue === 'number' && Number.isSafeInteger(codeValue) ? codeValue : undefined
  const messageValue = record(payload)?.message
  const message = typeof messageValue === 'string' ? messageValue : ''

  if (code === 0) {
    const cookies = response.headers.getSetCookie()
    const credential = await ensureBuvid3(pickCookies(cookies), signal, requestLog)
    if (credential.sessdata.length === 0) {
      return { state: 'unknown', code, message: 'Login succeeded, but the response did not include SESSDATA.' }
    }
    return { state: 'ok', code, credential }
  }

  const states: Readonly<Record<number, Exclude<LoginPollResult['state'], 'ok'>>> = {
    86101: 'waiting',
    86090: 'scanned',
    86038: 'expired',
  }
  const state = code === undefined ? 'unknown' : (states[code] ?? 'unknown')
  return code === undefined ? { state, message } : { state, code, message }
}

/**
 * Render the challenge URL as a PNG data URL for the settings page.
 * @param url - challenge URL returned by Bilibili.
 * @returns a locally generated PNG data URL; no QR service receives the URL.
 */
export function renderQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, { errorCorrectionLevel: 'M', width: 320, margin: 2 })
}

/**
 * Save Bilibili credentials in the plugin's DSH home directory.
 * @param stateDir - user-owned plugin data directory.
 * @param credential - cookies returned by a confirmed QR login.
 * @returns the credential file path.
 */
export function saveCredential(stateDir: string, credential: BilibiliCredential): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, 'bili_credential.json')
  writeFileSync(file, JSON.stringify({
    sessdata: credential.sessdata,
    bili_jct: credential.bili_jct,
    buvid3: credential.buvid3,
    dedeuserid: credential.dedeuserid,
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  if (!hardenPerms(file)) {
    try {
      unlinkSync(file)
    } catch (error) {
      throw new Error('Could not secure or remove the local credential file.', { cause: error })
    }
    throw new Error('Could not secure the local credential file.')
  }
  return file
}

/**
 * Read the saved Bilibili credentials for a Host-side API request.
 * @param stateDir - user-owned plugin data directory.
 * @returns saved credentials, or `undefined` until QR login has completed.
 * @throws when the credential file exists but is unreadable or invalid.
 */
export function readCredential(stateDir: string): BilibiliCredential | undefined {
  const file = join(stateDir, 'bili_credential.json')
  let value: unknown
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw new Error('Could not read the saved Bilibili credentials.', { cause: error })
  }

  const data = record(value)
  if (
    typeof data?.sessdata !== 'string' || data.sessdata.length === 0
    || typeof data.bili_jct !== 'string' || data.bili_jct.length === 0
    || typeof data.buvid3 !== 'string'
    || typeof data.dedeuserid !== 'string'
  ) {
    throw new Error('The saved Bilibili credentials are incomplete; sign in again.')
  }
  return {
    sessdata: data.sessdata,
    bili_jct: data.bili_jct,
    buvid3: data.buvid3,
    dedeuserid: data.dedeuserid,
  }
}

/**
 * Read public profile fields for the saved Bilibili session.
 * @param stateDir - user-owned plugin data directory.
 * @param signal - optional cancellation for the profile request.
 * @param requestLog - optional log for the outgoing HTTP request.
 * @returns the signed-in account, or `undefined` when no valid session is saved.
 * @throws when the saved credential or Bilibili profile response cannot be read.
 */
export async function readAccountProfile(
  stateDir: string,
  signal?: AbortSignal,
  requestLog?: ConversationLog,
): Promise<BilibiliAccountProfile | undefined> {
  const credential = readCredential(stateDir)
  if (credential === undefined) return undefined

  const response = await loggedFetch(ACCOUNT_PROFILE_URL, {
    headers: {
      Cookie: credentialCookie(credential),
      Referer: 'https://www.bilibili.com/',
      'User-Agent': USER_AGENT,
    },
    ...signalOption(signal),
  }, requestLog)
  if (!response.ok) throw new Error(`Bilibili account profile request failed with HTTP ${String(response.status)}`)

  const payload = record(await response.json())
  if (payload?.code === -101) return undefined
  if (payload?.code !== 0) throw new Error(`Bilibili account profile request failed with code ${String(payload?.code)}`)

  const data = record(payload.data)
  if (data === undefined) throw new Error('Bilibili returned an incomplete account profile.')
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const mid = typeof data.mid === 'number' && Number.isSafeInteger(data.mid) && data.mid > 0
    ? String(data.mid)
    : typeof data.mid === 'string' && /^\d+$/u.test(data.mid)
      ? data.mid
      : ''
  if (name.length === 0 || mid.length === 0) throw new Error('Bilibili returned an incomplete account profile.')
  return {
    face: typeof data.face === 'string' ? data.face : '',
    name,
    sign: typeof data.sign === 'string' ? data.sign : '',
    sex: typeof data.sex === 'string' ? data.sex : '',
    birthday: accountBirthday(data.birthday),
    level: typeof data.level === 'number' && Number.isSafeInteger(data.level) && data.level >= 0
      ? data.level
      : null,
    mid,
  }
}

/** Convert Bilibili's birthday timestamp to a date string for the local profile. */
function accountBirthday(value: unknown): string | null {
  if (typeof value === 'string') {
    const birthday = value.trim()
    return birthday.length === 0 ? null : birthday
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null
  const milliseconds = value > 100_000_000_000 ? value : value * 1000
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${date.getUTCFullYear()}-${month}-${day}`
}

/**
 * Restrict the credential file to the current user where the platform supports it.
 * @param file - credential file to secure.
 * @returns whether the platform command completed and the file remained readable.
 */
function hardenPerms(file: string): boolean {
  try {
    if (process.platform === 'win32') {
      const sid = currentUserSid()
      const user = sid === null
        ? `${process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\` : ''}${process.env.USERNAME ?? ''}`
        : `*${sid}`
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true })
      try {
        readFileSync(file)
      } catch (error) {
        void error
        execFileSync('icacls', [file, '/reset'], { stdio: 'ignore', windowsHide: true })
        return false
      }
    } else {
      execFileSync('chmod', ['600', file], { stdio: 'ignore' })
    }
    return true
  } catch (error) {
    void error
    return false
  }
}

/**
 * Retrieve the current Windows user's SID for an unambiguous ACL grant.
 * @returns the SID, or `null` when Windows identity lookup is unavailable.
 */
function currentUserSid(): string | null {
  try {
    const whoami = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe')
    const output = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
    return /"(S-1-[\d-]+)"/.exec(output)?.[1] ?? null
  } catch (error) {
    void error
    return null
  }
}

/** Select the Bilibili cookies consumed by MCP. */
function pickCookies(list: readonly string[]): BilibiliCredential {
  const credential: BilibiliCredential = { sessdata: '', bili_jct: '', buvid3: '', dedeuserid: '' }
  const fields: Readonly<Record<string, keyof BilibiliCredential>> = {
    SESSDATA: 'sessdata',
    bili_jct: 'bili_jct',
    DedeUserID: 'dedeuserid',
    buvid3: 'buvid3',
  }
  for (const raw of list) {
    const first = raw.split(';')[0] ?? ''
    const separator = first.indexOf('=')
    if (separator <= 0) continue
    const name = first.slice(0, separator).trim()
    const value = first.slice(separator + 1).trim()
    const field = fields[name]
    if (field !== undefined) credential[field] = value
  }
  return credential
}

/** Build the Cookie header used only by Host-side Bilibili requests. */
function credentialCookie(credential: BilibiliCredential): string {
  return [
    `SESSDATA=${credential.sessdata}`,
    `bili_jct=${credential.bili_jct}`,
    ...(credential.buvid3.length > 0 ? [`buvid3=${credential.buvid3}`] : []),
    ...(credential.dedeuserid.length > 0 ? [`DedeUserID=${credential.dedeuserid}`] : []),
  ].join('; ')
}

/** Fill the optional buvid3 cookie when Bilibili omits it during login. */
async function ensureBuvid3(credential: BilibiliCredential, signal?: AbortSignal, requestLog?: ConversationLog): Promise<BilibiliCredential> {
  if (credential.buvid3.length > 0) return credential
  try {
    const response = await loggedFetch(FINGERPRINT_URL, {
      headers: { 'User-Agent': USER_AGENT },
      ...signalOption(signal),
    }, requestLog)
    const payload = record(await response.json())
    const data = record(payload?.data)
    if (typeof data?.b_3 === 'string') credential.buvid3 = data.b_3
  } catch (error) {
    signal?.throwIfAborted()
    void error
    // Bilibili can use the other three cookies when fingerprint lookup fails.
  }
  return credential
}

/** Include an optional abort signal without setting RequestInit.signal to undefined. */
function signalOption(signal?: AbortSignal): Pick<RequestInit, 'signal'> | Record<never, never> {
  return signal === undefined ? {} : { signal }
}
