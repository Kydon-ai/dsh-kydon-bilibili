import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { pollNotifications } from '../src/lib/notifications.ts'
import { generateReply } from '../src/lib/reply.ts'
import { createRequestLog } from '../src/lib/conversation-log.ts'
import { loginPoll, loginStart } from '../src/lib/login.ts'
import { loggedFetch } from '../src/lib/http-log.ts'

function fixture(t) {
  const parent = resolve('tmp')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'bili-log-test-'))
  t.after(() => {
    const target = resolve(root)
    const within = relative(parent, target)
    assert.ok(within !== '' && !within.startsWith('..') && !isAbsolute(within))
    rmSync(target, { recursive: true, force: true })
  })
  const stateDir = join(root, 'state')
  const logDir = join(root, 'log')
  mkdirSync(stateDir)
  writeFileSync(join(stateDir, 'bili_credential.json'), JSON.stringify({
    sessdata: 'session-cookie-secret', bili_jct: 'csrf-token-secret', buvid3: '', dedeuserid: '1',
  }))
  return { root, stateDir, logDir }
}

function fakeAsrOptions(root) {
  const workerPath = join(root, 'fake-asr-worker.mjs')
  writeFileSync(workerPath, [
    "let input = ''",
    "process.stdin.setEncoding('utf8')",
    "process.stdin.on('data', chunk => { input += chunk })",
    "process.stdin.on('end', () => {",
    '  const request = JSON.parse(input)',
    '  process.stdout.write(JSON.stringify({',
    "    ok: true, bvid: request.bvid, page: request.page, model: 'small', device: 'cpu',",
    "    fallbackReason: 'No CUDA device is available.', durationSeconds: 20, language: 'zh',",
    "    audioPath: 'test-cache/audio/video.m4a', subtitlePath: 'test-cache/subtitles/video.srt',",
    "    cues: [{ startMs: 0, endMs: 2000, text: '本地转写内容' }],",
    '  }))',
    '})',
  ].join('\n'))
  return {
    pythonExecutable: process.execPath,
    workerPath,
    cacheDir: join(root, 'asr-cache'),
    timeoutMs: 5_000,
  }
}

function notification(id) {
  return {
    at_time: 1700000000,
    user: { nickname: '测试用户' },
    item: { subject_id: id, source_id: id, root_id: 0, business_id: 12, source_content: `评论 ${id}` },
  }
}

function mockBilibili(t, items, replyCode = 0) {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async (address) => {
    const url = new URL(address)
    if (url.pathname === '/x/msgfeed/unread') return Response.json({ code: 0, data: { at: items.length, reply: 0 } })
    if (url.pathname === '/x/msgfeed/at') return Response.json({ code: 0, data: { items } })
    if (url.pathname === '/x/article/view') {
      const content = url.searchParams.get('id') === '1' ? '' : '<p>文章正文</p>'
      return Response.json({ code: 0, data: { title: '测试文章', content } })
    }
    if (url.pathname === '/x/v2/reply/add') return Response.json({ code: replyCode })
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
}

function poll(stateDir, logDir, asrOptions) {
  const requestLog = createRequestLog(logDir)
  return pollNotifications(
    stateDir, logDir, requestLog, new AbortController().signal, 5_000,
    () => {}, () => {},
    async (_context, _signal, log) => {
      log.write('模型思考', '模拟思考')
      log.write('模型输出', '模拟回复')
      return '模拟回复'
    },
    () => {}, () => {}, () => {}, asrOptions,
  )
}

test('logs a skipped context failure and the next successful reply separately', async (t) => {
  const { stateDir, logDir } = fixture(t)
  mockBilibili(t, [notification(1), notification(2)])
  const result = await poll(stateDir, logDir)
  assert.equal(result.atReplies, 1)
  const files = readdirSync(logDir).filter(file => file.includes('-at-'))
  assert.equal(files.length, 2)
  const failure = readFileSync(join(logDir, files.find(file => file.includes('-at-1-'))), 'utf8')
  const success = readFileSync(join(logDir, files.find(file => file.includes('-at-2-'))), 'utf8')
  assert.match(failure, /获取上下文失败[\s\S]*no readable article body/)
  assert.match(success, /模型输入：通知上下文[\s\S]*文章正文[\s\S]*评论 2/)
  assert.match(success, /模型思考[\s\S]*模拟思考[\s\S]*模型输出[\s\S]*模拟回复/)
  assert.match(success, /发送成功[\s\S]*去重状态已保存/)
  assert.doesNotMatch(failure + success, /session-cookie-secret|csrf-token-secret/)
})

test('records a rejected Bilibili reply without claiming it was sent', async (t) => {
  const { stateDir, logDir } = fixture(t)
  mockBilibili(t, [notification(2)], -400)
  await assert.rejects(poll(stateDir, logDir), /code -400/)
  const log = readFileSync(join(logDir, readdirSync(logDir).find(file => file.includes('-at-'))), 'utf8')
  assert.match(log, /发送失败[\s\S]*code -400/)
  assert.doesNotMatch(log, /发送成功/)
})

test('transcribes video audio locally without requesting Bilibili subtitles', async (t) => {
  const { root, stateDir, logDir } = fixture(t)
  const asr = fakeAsrOptions(root)
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async (address) => {
    const url = new URL(address)
    if (url.pathname === '/x/msgfeed/unread') return Response.json({ code: 0, data: { at: 1, reply: 0 } })
    if (url.pathname === '/x/msgfeed/at') {
      const item = notification(9)
      item.item.business_id = 1
      item.item.uri = 'https://www.bilibili.com/video/BV1234567890'
      return Response.json({ code: 0, data: { items: [item] } })
    }
    if (url.pathname === '/x/v2/reply/add') return Response.json({ code: 0 })
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
  assert.equal((await poll(stateDir, logDir, asr)).atReplies, 1)
  const files = readdirSync(logDir)
  const httpLog = readFileSync(join(logDir, files.find(file => file.includes('-requests-'))), 'utf8')
  const conversation = readFileSync(join(logDir, files.find(file => file.includes('-at-9-'))), 'utf8')
  for (const path of ['/x/msgfeed/unread', '/x/msgfeed/at', '/x/v2/reply/add']) {
    assert.ok(httpLog.includes(path), `missing ${path}`)
  }
  for (const path of ['/x/v2/reply/add']) {
    assert.ok(conversation.includes(path), `missing ${path}`)
  }
  assert.match(conversation, /视频输入标识[\s\S]*"aid": "9"/)
  assert.match(conversation, /本地音频转写结果[\s\S]*"device": "cpu"/)
  assert.match(conversation, /"subtitlePath": "test-cache\/subtitles\/video.srt"/)
  assert.match(conversation, /Video transcript[\s\S]*本地转写内容/)
  assert.match(conversation, /"method": "POST"[\s\S]*"name": "message",\s+"value": "模拟回复"/)
  assert.match(conversation, /"name": "csrf",\s+"value": "\[已遮盖\]"/)
  assert.match(conversation, /接口响应[\s\S]*"status":200/)
  assert.doesNotMatch(httpLog + conversation, /\/x\/web-interface\/|\/x\/player\/|subtitle_url|session-cookie-secret|csrf-token-secret/)
})

for (const invalidUri of [false, true]) {
  test(`reads the video page from its notification URL${invalidUri ? ' and rejects an invalid BV id' : ''}`, async (t) => {
    const { root, stateDir, logDir } = fixture(t)
    const asr = fakeAsrOptions(root)
    const previous = globalThis.fetch
    t.after(() => { globalThis.fetch = previous })
    globalThis.fetch = async (address) => {
      const url = new URL(address)
      if (url.pathname === '/x/msgfeed/unread') return Response.json({ code: 0, data: { at: 1, reply: 0 } })
      if (url.pathname === '/x/msgfeed/at') {
        const item = notification(9)
        item.item.business_id = 1
        item.item.uri = invalidUri
          ? 'https://www.bilibili.com/video/not-a-bv?p=2'
          : 'https://www.bilibili.com/video/BV1234567890?p=2'
        return Response.json({ code: 0, data: { items: [item] } })
      }
      if (url.pathname === '/x/v2/reply/add') return Response.json({ code: 0 })
      throw new Error(`Unexpected request: ${url.pathname}`)
    }
    const result = await poll(stateDir, logDir, asr)
    const file = readdirSync(logDir).find(name => name.includes('-at-9-'))
    const content = readFileSync(join(logDir, file), 'utf8')
    if (invalidUri) {
      assert.equal(result.atReplies, 0)
      assert.match(content, /no valid BV id/)
    } else {
      assert.equal(result.atReplies, 1)
      assert.match(content, /"page": 2/)
      assert.match(content, /本地转写内容/)
    }
  })
}

test('records QR login requests without retaining the challenge key or cookies', async (t) => {
  const { logDir } = fixture(t)
  const log = createRequestLog(logDir)
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async (address) => {
    const url = new URL(address)
    if (url.pathname.endsWith('/generate')) return Response.json({ data: { qrcode_key: 'qr-secret', url: 'https://example.com/qr' } })
    if (url.pathname.endsWith('/poll')) {
      const headers = new Headers()
      headers.append('Set-Cookie', 'SESSDATA=session-cookie-secret; Path=/')
      headers.append('Set-Cookie', 'bili_jct=csrf-token-secret; Path=/')
      return Response.json({ data: { code: 0 } }, { headers })
    }
    if (url.pathname === '/x/frontend/finger/spi') return Response.json({ data: { b_3: 'fingerprint-secret' } })
    throw new Error(`Unexpected request: ${url.pathname}`)
  }
  const challenge = await loginStart(undefined, log)
  assert.equal((await loginPoll(challenge.key, undefined, log)).state, 'ok')
  const content = readFileSync(log.path, 'utf8')
  assert.match(content, /\/x\/passport-login\/web\/qrcode\/generate/)
  assert.match(content, /\/x\/passport-login\/web\/qrcode\/poll/)
  assert.match(content, /\/x\/frontend\/finger\/spi/)
  assert.match(content, /"name": "qrcode_key",\s+"value": "\[已遮盖\]"/)
  assert.doesNotMatch(content, /qr-secret|session-cookie-secret|csrf-token-secret|fingerprint-secret/)
})

test('records both client login routes and their upstream requests', async (t) => {
  const { stateDir, logDir } = fixture(t)
  const oldHome = process.env.DSH_HOME
  const oldFetch = globalThis.fetch
  const oldInfo = console.info
  const routes = new Map()
  const disposers = []
  process.env.DSH_HOME = dirname(stateDir)
  console.info = () => {}
  globalThis.fetch = async (address) => {
    const path = new URL(address).pathname
    if (path.endsWith('/generate')) return Response.json({ data: { qrcode_key: 'qr-secret', url: 'https://example.com/qr' } })
    if (path.endsWith('/poll')) return Response.json({ data: { code: 86101 } })
    throw new Error(`Unexpected request: ${path}`)
  }
  try {
    const plugin = await import('../src/index.ts')
    plugin.apply({
      connection: { fetch: { register: route => { routes.set(route.path, route.fetch); return () => {} } } },
      effect: fn => { disposers.push(fn()) },
    }, { logDir })
    const start = await routes.get('/api/kydon-bilibili/login/start')(new Request('http://localhost/api/kydon-bilibili/login/start', { method: 'POST' }))
    assert.equal(start.status, 200)
    const result = await routes.get('/api/kydon-bilibili/login/poll')(new Request('http://localhost/api/kydon-bilibili/login/poll', {
      method: 'POST', body: JSON.stringify({ key: 'qr-secret' }),
    }))
    assert.equal(result.status, 200)
    const logFile = readdirSync(logDir).find(file => file.includes('-requests-'))
    const content = readFileSync(join(logDir, logFile), 'utf8')
    assert.match(content, /前端调用 Host 接口[\s\S]*\/api\/kydon-bilibili\/login\/start/)
    assert.match(content, /前端调用 Host 接口[\s\S]*\/api\/kydon-bilibili\/login\/poll/)
    assert.match(content, /"name": "key",\s+"value": "\[已遮盖\]"/)
    assert.match(content, /\/x\/passport-login\/web\/qrcode\/generate/)
    assert.match(content, /\/x\/passport-login\/web\/qrcode\/poll/)
    assert.doesNotMatch(content, /qr-secret/)
  } finally {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') await dispose()
    globalThis.fetch = oldFetch
    console.info = oldInfo
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('preserves a successful response when logging its HTTP result fails', async (t) => {
  const previousFetch = globalThis.fetch
  const previousWarn = console.warn
  t.after(() => { globalThis.fetch = previousFetch; console.warn = previousWarn })
  globalThis.fetch = async () => new Response(null, { status: 200 })
  console.warn = () => {}
  const log = { path: 'unused', write: (stage) => { if (stage === '接口响应') throw new Error('disk failure') } }
  const response = await loggedFetch('https://api.bilibili.com/x/v2/reply/add', { method: 'POST' }, log)
  assert.equal(response.status, 200)
})

test('records actual model inputs and returned reasoning before disposing the session', async () => {
  const records = []
  let disposed = false
  const events = [
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: '实际系统提示' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '实际用户输入' }] } },
    { type: 'assistant/message', seq: 3, data: { message: { content: [
      { type: 'reasoning', text: '提供方思考' }, { type: 'text', text: '生成回复' },
    ] }, stream: [] } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ]
  const agent = { followup() {}, whenIdle: async () => {}, session: { snapshotEvents: () => events }, cancel() {} }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    agents: { create: async () => ({ agent, dispose: async () => { disposed = true } }) },
  }
  const result = await generateReply(ctx, '评论上下文', new AbortController().signal, 5_000, {
    write: (stage, content) => records.push([stage, content]),
  })
  assert.equal(result, '生成回复')
  assert.equal(disposed, true)
  assert.ok(records.some(([stage, content]) => stage === '模型实际系统输入' && content === '实际系统提示'))
  assert.ok(records.some(([stage, content]) => stage === '模型实际用户输入' && content === '实际用户输入'))
  assert.ok(records.some(([stage, content]) => stage.startsWith('模型思考') && content === '提供方思考'))
  assert.ok(records.some(([stage, content]) => stage.startsWith('模型输出') && content === '生成回复'))
})

test('retains partial reasoning from a failed model attempt and disposes the session', async () => {
  const records = []
  let disposed = false
  const agent = {
    followup() {},
    whenIdle: async () => { throw new Error('model unavailable') },
    session: { snapshotEvents: () => [{
      type: 'assistant/attempt', seq: 4,
      data: { stream: [{ type: 'reasoning-chunks', texts: ['部分思考'] }] },
    }] },
    cancel() {},
  }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    agents: { create: async () => ({ agent, dispose: async () => { disposed = true } }) },
  }
  await assert.rejects(generateReply(ctx, '输入', new AbortController().signal, 5_000, {
    write: (stage, content) => records.push([stage, content]),
  }), /model unavailable/)
  assert.equal(disposed, true)
  assert.ok(records.some(([stage, content]) => stage.startsWith('模型思考') && content === '部分思考'))
  assert.ok(records.some(([stage, content]) => stage === '模型输出' && content === '模型未返回文本。'))
})
