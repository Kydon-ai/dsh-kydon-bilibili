/** Bilibili QR login Host plugin and its authenticated browser API. */

import type { Context } from '@deepseek-ai/cordis'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { AsrOptions } from './lib/asr.ts'
import { AsrSetupManager, type AsrSetupSnapshot } from './lib/asr-setup.ts'
import { loginPoll, loginStart, readAccountProfile, renderQrDataUrl, saveCredential } from './lib/login.ts'
import { pollNotifications } from './lib/notifications.ts'
import { generateReply } from './lib/reply.ts'
import { createRequestLog, type ConversationLog } from './lib/conversation-log.ts'
import { logIncoming } from './lib/http-log.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'dsh-kydon-bilibili'

/** Host services for authenticated routes and managed ASR child processes. */
export const inject = ['connection', 'agents', 'agentDefaultModel', 'systemPrompt', 'tools', 'subprocess']

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_LOG_DIR = resolve(PLUGIN_DIR, 'log')
const DEFAULT_ASR_CACHE_DIR = resolve(PLUGIN_DIR, '.cache')
const DEFAULT_UV_EXECUTABLE = 'uv'
const DEFAULT_ASR_ENVIRONMENT_PATH = resolve(PLUGIN_DIR, '.venv')
const DEFAULT_ASR_PYTHON_EXECUTABLE = resolve(
  DEFAULT_ASR_ENVIRONMENT_PATH,
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
)
const ASR_WORKER_PATH = resolve(PLUGIN_DIR, 'asr-worker.py')

/** QR login and Bilibili notification polling behavior configured by the deployment. */
export interface Config {
  /** Delay between QR status requests, in milliseconds. Defaults to 2000. */
  qrPollIntervalMs?: number
  /** Maximum QR login wait, in milliseconds. Defaults to 180000. */
  qrTimeoutMs?: number
  /** Delay between Bilibili notification checks, in milliseconds. Defaults to 60000. */
  notificationPollIntervalMs?: number
  /** Maximum duration of one Bilibili HTTP request, in milliseconds. Defaults to 20000. */
  notificationRequestTimeoutMs?: number
  /** Maximum duration of one model-generated public reply, in milliseconds. Defaults to 120000. */
  replyGenerationTimeoutMs?: number
  /** Python executable with yt-dlp and faster-whisper installed. Defaults to the uv environment in the plugin's .venv. */
  asrPythonExecutable?: string
  /** Directory for the Whisper model, downloaded audio, and SRT files. Defaults to the plugin's .cache directory. */
  asrCacheDir?: string
  /** Maximum duration of one local audio transcription, in milliseconds. Defaults to 1800000. */
  asrTimeoutMs?: number
  /** GPU transcription batch size, from 1 to 64. Defaults to 32. */
  asrBatchSize?: number
  /** uv executable name or absolute path. Defaults to `uv`. */
  uvExecutable?: string
  /** Maximum duration of the consented `uv sync --locked` installation, in milliseconds. Defaults to 1800000. */
  asrInstallTimeoutMs?: number
  /** Directory for per-notification logs. Defaults to the plugin's log directory. */
  logDir?: string
}

/** Cordis-validated login and notification polling settings. */
export const Config: z<Config> = z.object({
  qrPollIntervalMs: z.number().step(1).min(500).max(10_000).default(2_000),
  qrTimeoutMs: z.number().step(1).min(10_000).max(300_000).default(180_000),
  notificationPollIntervalMs: z.number().step(1).min(10_000).max(3_600_000).default(60_000),
  notificationRequestTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(20_000),
  replyGenerationTimeoutMs: z.number().step(1).min(1_000).max(300_000).default(120_000),
  asrPythonExecutable: z.string().min(1).default(DEFAULT_ASR_PYTHON_EXECUTABLE),
  asrCacheDir: z.string().min(1).default(DEFAULT_ASR_CACHE_DIR),
  asrTimeoutMs: z.number().step(1).min(10_000).max(14_400_000).default(1_800_000),
  asrBatchSize: z.number().step(1).min(1).max(64).default(32),
  uvExecutable: z.string().min(1).default(DEFAULT_UV_EXECUTABLE),
  asrInstallTimeoutMs: z.number().step(1).min(60_000).max(7_200_000).default(1_800_000),
  logDir: z.string().min(1).default(DEFAULT_LOG_DIR),
})

interface ResolvedConfig {
  readonly qrPollIntervalMs: number
  readonly qrTimeoutMs: number
  readonly notificationPollIntervalMs: number
  readonly notificationRequestTimeoutMs: number
  readonly replyGenerationTimeoutMs: number
  readonly asrOptions: AsrOptions
  readonly uvExecutable: string
  readonly asrInstallTimeoutMs: number
  readonly logDir: string
}

const LOGIN_STATE_DIR = dshHomePath('kydon-bilibili')
const LOGIN_START_PATH = '/api/kydon-bilibili/login/start'
const LOGIN_POLL_PATH = '/api/kydon-bilibili/login/poll'
const LOGIN_ACCOUNT_PATH = '/api/kydon-bilibili/login/account'
const ASR_SETUP_STATUS_PATH = '/api/kydon-bilibili/asr/status'
const ASR_SETUP_INSTALL_PATH = '/api/kydon-bilibili/asr/install'
const ASR_SETUP_REMOVE_PATH = '/api/kydon-bilibili/asr/remove'
const ASR_MODEL_DOWNLOAD_PATH = '/api/kydon-bilibili/asr/model/download'
const ASR_MODEL_REMOVE_PATH = '/api/kydon-bilibili/asr/model/remove'
const ASR_SETUP_MARKER_PATH = join(LOGIN_STATE_DIR, 'asr-install.json')
const LOG_PREFIX = '[dsh-kydon-bilibili]'

/**
 * Register QR-login routes and gate notification polling on consented ASR setup.
 * @param ctx - Host context with Connection and subprocess services.
 * @param config - Login, notification polling, local transcription, and log-directory settings.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const requestLog = createRequestLog(resolved.logDir)
  let disposed = false
  let stopPoller: (() => Promise<void>) | undefined
  const setup = new AsrSetupManager({
    pluginDir: PLUGIN_DIR,
    lockPath: resolve(PLUGIN_DIR, 'uv.lock'),
    pythonExecutable: DEFAULT_ASR_PYTHON_EXECUTABLE,
    asrOptions: resolved.asrOptions,
    cacheDir: resolved.asrOptions.cacheDir,
    environmentPath: DEFAULT_ASR_ENVIRONMENT_PATH,
    markerPath: ASR_SETUP_MARKER_PATH,
    uvExecutable: resolved.uvExecutable,
    timeoutMs: resolved.asrInstallTimeoutMs,
    subprocess: ctx.subprocess,
    onReady: () => {
      if (!disposed && stopPoller === undefined) stopPoller = startNotificationPoller()
    },
    onPause: async () => {
      const stop = stopPoller
      stopPoller = undefined
      await stop?.()
    },
    warn: message => console.warn(`${LOG_PREFIX} ${message}`),
  })
  // 获取二维码
  ctx.effect(() => ctx.connection.fetch.register({
    path: LOGIN_START_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => startLogin(request, resolved, requestLog),
  }), 'dsh-kydon-bilibili: login start route')

  // 对扫码状态轮询
  ctx.effect(() => ctx.connection.fetch.register({
    path: LOGIN_POLL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => pollLogin(request, requestLog),
  }), 'dsh-kydon-bilibili: login poll route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: LOGIN_ACCOUNT_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => readLoginAccount(request, requestLog),
  }), 'dsh-kydon-bilibili: login account route')

  // 查询转写服务状态
  ctx.effect(() => ctx.connection.fetch.register({
    path: ASR_SETUP_STATUS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: () => readAsrSetupStatus(setup),
  }), 'dsh-kydon-bilibili: ASR setup status route')
  // 安装依赖请求
  ctx.effect(() => ctx.connection.fetch.register({
    path: ASR_SETUP_INSTALL_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => requestAsrInstall(request, setup),
  }), 'dsh-kydon-bilibili: ASR setup install route')
  // 移除转写模型缓存，不删除 Python 环境
  ctx.effect(() => ctx.connection.fetch.register({
    path: ASR_MODEL_DOWNLOAD_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => requestAsrModelDownload(request, setup),
  }), 'dsh-kydon-bilibili: Whisper model download route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: ASR_MODEL_REMOVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => requestAsrModelRemoval(request, setup),
  }), 'dsh-kydon-bilibili: Whisper model removal route')
  ctx.effect(() => ctx.connection.fetch.register({
    path: ASR_SETUP_REMOVE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => requestAsrEnvironmentRemoval(request, setup),
  }), 'dsh-kydon-bilibili: ASR environment removal route')
  // 初始化ASR服务
  ctx.effect(() => {
    void setup.status().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} ASR setup status could not be loaded.`, error)
    })
    return async () => {
      disposed = true
      await setup.dispose()
      await stopPoller?.()
    }
  }, 'dsh-kydon-bilibili: ASR setup and notification lifecycle')

  function startNotificationPoller(): () => Promise<void> {
    const controller = new AbortController()
    let stopping = false
    let activePoll: Promise<void> | undefined
    let reportedMissingCredential = false
    console.info(`${LOG_PREFIX} notification poller started; interval=${String(resolved.notificationPollIntervalMs)}ms; logs=${resolved.logDir}.`)

    // Do not overlap a slow reply batch with the next timer tick.
    const poll = (): void => {
      if (stopping || activePoll !== undefined) return
      const task = pollNotifications(
        LOGIN_STATE_DIR,
        resolved.logDir,
        requestLog,
        controller.signal,
        resolved.notificationRequestTimeoutMs,
        data => console.info(`${LOG_PREFIX} /x/msgfeed/unread ${JSON.stringify(data)}`),
        context => console.info(`${LOG_PREFIX} comment context\n${context}`),
        (context, signal, log) => generateReply(ctx, context, signal, resolved.replyGenerationTimeoutMs, log),
        (kind, timestampMs, content) => console.info(
          `${LOG_PREFIX} [${String(timestampMs)}ms] ${kind} generated reply (posting next): ${JSON.stringify(content)}`,
        ),
        (kind, error) => console.warn(
          `${LOG_PREFIX} ${kind} context retrieval failed; reply skipped.`,
          error instanceof Error ? error.message : String(error),
        ),
        (kind, error) => console.warn(`${LOG_PREFIX} ${kind} reply generation failed; reply skipped.`, error),
        resolved.asrOptions,
        ctx.subprocess,
      ).then((result) => {
        if (result.state === 'no-credentials') {
          if (!reportedMissingCredential) {
            console.info(`${LOG_PREFIX} polling is idle until QR login completes.`)
          }
          reportedMissingCredential = true
          return
        }

        reportedMissingCredential = false
        if (result.atReplies + result.replyReplies > 0) {
          console.info(
            `${LOG_PREFIX} handled notifications: ${String(result.atReplies)} @ replies, `
            + `${String(result.replyReplies)} reply responses.`,
          )
        }
      }).catch((error: unknown) => {
        if (stopping && controller.signal.aborted) return
        console.warn(`${LOG_PREFIX} notification polling failed.`, error)
      }).finally(() => {
        if (activePoll === task) activePoll = undefined
      })
      activePoll = task
    }

    const timer = setInterval(poll, resolved.notificationPollIntervalMs)
    poll()
    return async () => {
      stopping = true
      clearInterval(timer)
      controller.abort(new Error('Bilibili notification poller disposed.'))
      // Cordis waits for this disposer, so unload reaches quiescence.
      await activePoll
    }
  }
}

/** Resolve and validate QR and notification polling settings at plugin load. */
function resolveConfig(config: Config): ResolvedConfig {
  const qrPollIntervalMs = config.qrPollIntervalMs ?? 2_000
  const qrTimeoutMs = config.qrTimeoutMs ?? 180_000
  const notificationPollIntervalMs = config.notificationPollIntervalMs ?? 60_000
  const notificationRequestTimeoutMs = config.notificationRequestTimeoutMs ?? 20_000
  const replyGenerationTimeoutMs = config.replyGenerationTimeoutMs ?? 120_000
  const asrPythonExecutable = config.asrPythonExecutable ?? DEFAULT_ASR_PYTHON_EXECUTABLE
  const asrCacheDir = config.asrCacheDir ?? DEFAULT_ASR_CACHE_DIR
  const asrTimeoutMs = config.asrTimeoutMs ?? 1_800_000
  const asrBatchSize = config.asrBatchSize ?? 32
  const uvExecutable = config.uvExecutable ?? DEFAULT_UV_EXECUTABLE
  const asrInstallTimeoutMs = config.asrInstallTimeoutMs ?? 1_800_000
  const logDir = config.logDir ?? DEFAULT_LOG_DIR
  if (logDir.trim().length === 0 || asrPythonExecutable.trim().length === 0 || asrCacheDir.trim().length === 0 || uvExecutable.trim().length === 0) {
    throw new TypeError('dsh-kydon-bilibili: logDir, asrPythonExecutable, asrCacheDir, and uvExecutable must not be empty')
  }
  if (!Number.isSafeInteger(qrPollIntervalMs) || qrPollIntervalMs < 500 || qrPollIntervalMs > 10_000) {
    throw new TypeError('dsh-kydon-bilibili: qrPollIntervalMs must be an integer from 500 to 10000')
  }
  if (!Number.isSafeInteger(qrTimeoutMs) || qrTimeoutMs < 10_000 || qrTimeoutMs > 300_000) {
    throw new TypeError('dsh-kydon-bilibili: qrTimeoutMs must be an integer from 10000 to 300000')
  }
  if (!Number.isSafeInteger(notificationPollIntervalMs) || notificationPollIntervalMs < 10_000 || notificationPollIntervalMs > 3_600_000) {
    throw new TypeError('dsh-kydon-bilibili: notificationPollIntervalMs must be an integer from 10000 to 3600000')
  }
  if (!Number.isSafeInteger(notificationRequestTimeoutMs) || notificationRequestTimeoutMs < 1_000 || notificationRequestTimeoutMs > 120_000) {
    throw new TypeError('dsh-kydon-bilibili: notificationRequestTimeoutMs must be an integer from 1000 to 120000')
  }
  if (!Number.isSafeInteger(replyGenerationTimeoutMs) || replyGenerationTimeoutMs < 1_000 || replyGenerationTimeoutMs > 300_000) {
    throw new TypeError('dsh-kydon-bilibili: replyGenerationTimeoutMs must be an integer from 1000 to 300000')
  }
  if (!Number.isSafeInteger(asrTimeoutMs) || asrTimeoutMs < 10_000 || asrTimeoutMs > 14_400_000) {
    throw new TypeError('dsh-kydon-bilibili: asrTimeoutMs must be an integer from 10000 to 14400000')
  }
  if (!Number.isSafeInteger(asrBatchSize) || asrBatchSize < 1 || asrBatchSize > 64) {
    throw new TypeError('dsh-kydon-bilibili: asrBatchSize must be an integer from 1 to 64')
  }
  if (!Number.isSafeInteger(asrInstallTimeoutMs) || asrInstallTimeoutMs < 60_000 || asrInstallTimeoutMs > 7_200_000) {
    throw new TypeError('dsh-kydon-bilibili: asrInstallTimeoutMs must be an integer from 60000 to 7200000')
  }
  return {
    qrPollIntervalMs,
    qrTimeoutMs,
    notificationPollIntervalMs,
    notificationRequestTimeoutMs,
    replyGenerationTimeoutMs,
    asrOptions: {
      pythonExecutable: asrPythonExecutable,
      workerPath: ASR_WORKER_PATH,
      cacheDir: resolve(asrCacheDir),
      timeoutMs: asrTimeoutMs,
      batchSize: asrBatchSize,
    },
    uvExecutable,
    asrInstallTimeoutMs,
    logDir: resolve(logDir),
  }
} 

/** Return setup status for the browser card without exposing local paths. */
async function readAsrSetupStatus(setup: AsrSetupManager): Promise<Response> {
  try {
    return asrSetupResponse(await setup.status())
  } catch (error) {
    console.warn(`${LOG_PREFIX} ASR setup status could not be read.`, error)
    return jsonResponse({ error: 'setup_unavailable' }, 500)
  }
}

/** Start dependency installation only after the browser submits explicit approval. */
async function requestAsrInstall(request: Request, setup: AsrSetupManager): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    void error
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400)
  }
  if (!isRecord(body) || body.approved !== true || (body.reinstall !== undefined && typeof body.reinstall !== 'boolean')) {
    return jsonResponse({ error: 'Explicit installation approval is required.' }, 400)
  }
  try {
    return asrSetupResponse(await setup.requestInstall(body.reinstall === true), 202)
  } catch (error) {
    console.warn(`${LOG_PREFIX} ASR installation could not be started.`, error)
    return jsonResponse({ error: 'setup_unavailable' }, 500)
  }
}

/** Start or replace the Whisper model download only after the browser submits explicit approval. */
async function requestAsrModelDownload(request: Request, setup: AsrSetupManager): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    void error
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400)
  }
  if (!isRecord(body) || body.approved !== true || (body.reinstall !== undefined && typeof body.reinstall !== 'boolean')) {
    return jsonResponse({ error: 'Explicit Whisper model download approval is required.' }, 400)
  }
  try {
    return asrSetupResponse(await setup.downloadWhisperModel(body.reinstall === true), 202)
  } catch (error) {
    console.warn(LOG_PREFIX + ' Whisper model download could not be started.', error)
    return jsonResponse({ error: 'setup_unavailable' }, 500)
  }
}

/** Remove cached Whisper weights only after the browser submits explicit approval. */
async function requestAsrModelRemoval(request: Request, setup: AsrSetupManager): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    void error
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400)
  }
  if (!isRecord(body) || body.approved !== true) {
    return jsonResponse({ error: 'Explicit Whisper model-removal approval is required.' }, 400)
  }
  try {
    return asrSetupResponse(await setup.removeWhisperModel(), 202)
  } catch (error) {
    console.warn(`${LOG_PREFIX} Whisper model removal could not be started.`, error)
    return jsonResponse({ error: 'setup_unavailable' }, 500)
  }
}

/** Remove the Python environment only after the browser submits explicit approval. */
async function requestAsrEnvironmentRemoval(request: Request, setup: AsrSetupManager): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    void error
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400)
  }
  if (!isRecord(body) || body.approved !== true) {
    return jsonResponse({ error: 'Explicit ASR environment-removal approval is required.' }, 400)
  }
  try {
    return asrSetupResponse(await setup.removeEnvironment(), 202)
  } catch (error) {
    console.warn(`${LOG_PREFIX} ASR environment removal could not be started.`, error)
    return jsonResponse({ error: 'setup_unavailable' }, 500)
  }
}

/** Project setup state without installation logs or local filesystem paths. */
function asrSetupResponse(snapshot: AsrSetupSnapshot, status = 200): Response {
  return jsonResponse({
    state: snapshot.state,
    whisperModelDownloaded: snapshot.whisperModelDownloaded,
    whisperModelDownloading: snapshot.whisperModelDownloading,
    whisperModelDownloadFailed: snapshot.whisperModelDownloadFailed,
    whisperModelRemoving: snapshot.whisperModelRemoving,
    whisperModelRemovalFailed: snapshot.whisperModelRemovalFailed,
  }, status)
}

/** Create a QR challenge and keep its credential URL in the browser response only. */
async function startLogin(request: Request, config: ResolvedConfig, requestLog: ConversationLog): Promise<Response> {
  try {
    logIncoming(requestLog, request.method, LOGIN_START_PATH)
    const challenge = await loginStart(request.signal, requestLog)
    const qr = await renderQrDataUrl(challenge.url)
    request.signal.throwIfAborted()
    return jsonResponse({
      key: challenge.key,
      qr,
      pollIntervalMs: config.qrPollIntervalMs,
      timeoutMs: config.qrTimeoutMs,
    })
  } catch (error) {
    request.signal.throwIfAborted()
    void error // Keep Bilibili and local filesystem details out of the authenticated browser response.
    return jsonResponse({ error: 'request_failed' }, 502)
  }
}

/** Poll a QR challenge and persist credentials after Bilibili confirms login. */
async function pollLogin(request: Request, requestLog: ConversationLog): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch (error) {
    logIncoming(requestLog, request.method, LOGIN_POLL_PATH)
    void error
    return jsonResponse({ error: 'Request body must be valid JSON.' }, 400)
  }
  const key = isRecord(body) ? body.key : undefined
  logIncoming(requestLog, request.method, LOGIN_POLL_PATH, new URLSearchParams({ key: typeof key === 'string' ? key : '' }))
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) {
    return jsonResponse({ error: 'A valid QR challenge key is required.' }, 400)
  }

  try {
    const result = await loginPoll(key, request.signal, requestLog)
    if (result.state === 'ok') {
      saveCredential(LOGIN_STATE_DIR, result.credential)
      return jsonResponse({ state: 'ok' })
    }
    return jsonResponse({ state: result.state, message: result.message })
  } catch (error) {
    request.signal.throwIfAborted()
    void error // Keep Bilibili and local filesystem details out of the authenticated browser response.
    return jsonResponse({ error: 'request_failed' }, 502)
  }
}

/** Return only the saved account's public profile fields to the settings page. */
async function readLoginAccount(request: Request, requestLog: ConversationLog): Promise<Response> {
  try {
    logIncoming(requestLog, request.method, LOGIN_ACCOUNT_PATH)
    const account = await readAccountProfile(LOGIN_STATE_DIR, request.signal, requestLog)
    return jsonResponse({ account: account ?? null })
  } catch (error) {
    request.signal.throwIfAborted()
    void error // Keep Bilibili and local credential details out of the authenticated browser response.
    return jsonResponse({ error: 'account_unavailable' }, 502)
  }
}

/** Read one object from a request or response JSON value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Build an uncached JSON response for the authenticated login API. */
function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    },
  })
}

