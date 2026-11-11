/** Browser login card with a temporary QR challenge and cancellable polling. */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { IconCheckOutline16, IconCloseOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AsrSetupPanelProps,
  AsrSetupState,
  AsrSetupStatus,
  BilibiliLoginCardProps,
  DependencyStatusIconProps,
  IconActionButtonProps,
  LoginAccount,
  LoginAccountDetailsProps,
  LoginChallenge,
  LoginPanelProps,
  LoginPoll,
  LoginState,
  UsageGuideProps,
} from './login-card.types.ts'
export type { BilibiliLoginCardProps } from './login-card.types.ts'

const LOGIN_START_PATH = '/api/kydon-bilibili/login/start'
const LOGIN_POLL_PATH = '/api/kydon-bilibili/login/poll'
const LOGIN_ACCOUNT_PATH = '/api/kydon-bilibili/login/account'
const ASR_SETUP_STATUS_PATH = '/api/kydon-bilibili/asr/status'
const ASR_SETUP_INSTALL_PATH = '/api/kydon-bilibili/asr/install'
const ASR_MODEL_DOWNLOAD_PATH = '/api/kydon-bilibili/asr/model/download'
const ASR_MODEL_REMOVE_PATH = '/api/kydon-bilibili/asr/model/remove'

const CLASSIC = {
  ink: '#37352d',
  muted: '#756d5d',
  jade: '#52776a',
  cinnabar: '#a94c3e',
  blue: '#647887',
} as const

/**
 * Render the Bilibili account details and QR login controls.
 * @param props - the requested card view and localized text.
 * @returns a one-line summary or the login form.
 */
export function BilibiliLoginCard({ view, t }: BilibiliLoginCardProps) {
  const [status, setStatus] = useState<LoginState>('idle')
  const [asrSetup, setAsrSetup] = useState<AsrSetupState>()
  const [whisperModelDownloaded, setWhisperModelDownloaded] = useState(false)
  const [whisperModelDownloading, setWhisperModelDownloading] = useState(false)
  const [whisperModelDownloadFailed, setWhisperModelDownloadFailed] = useState(false)
  const [whisperModelRemoving, setWhisperModelRemoving] = useState(false)
  const [whisperModelRemovalFailed, setWhisperModelRemovalFailed] = useState(false)
  const [qr, setQr] = useState<string>()
  const [error, setError] = useState<string>()
  const [account, setAccount] = useState<LoginAccount | null>()
  const [accountVisible, setAccountVisible] = useState(false)
  const [accountLoading, setAccountLoading] = useState(false)
  const [accountLoadFailed, setAccountLoadFailed] = useState(false)
  const request = useRef<AbortController | null>(null)
  const accountRequest = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refreshAccount = useCallback(async (): Promise<void> => {
    accountRequest.current?.abort()
    const controller = new AbortController()
    accountRequest.current = controller
    setAccountLoading(true)
    setAccountLoadFailed(false)
    try {
      const value = await getJson(LOGIN_ACCOUNT_PATH, controller.signal, 'The account request failed.')
      const next = readLoginAccount(value)
      if (next === undefined) throw new Error('The account response was invalid.')
      if (accountRequest.current !== controller) return
      setAccount(next)
      setAccountVisible(false)
      if (next !== null) setStatus('success')
    } catch {
      if (controller.signal.aborted || accountRequest.current !== controller) return
      setAccountLoadFailed(true)
    } finally {
      if (accountRequest.current === controller) {
        accountRequest.current = null
        setAccountLoading(false)
      }
    }
  }, [])

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    request.current?.abort()
    request.current = null
  }, [])

  useEffect(() => {
    if (view === 'summary') return
    void refreshAccount()
    return () => {
      accountRequest.current?.abort()
      accountRequest.current = null
    }
  }, [refreshAccount, view])

  useEffect(() => {
    if (view === 'summary') return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    const refresh = async (): Promise<void> => {
      try {
        const value = await getJson(ASR_SETUP_STATUS_PATH, controller.signal, t('asrUnavailable'))
        const next = readAsrSetup(value)
        if (next === undefined) throw new Error(t('invalidResponse'))
        setAsrSetup(next.state)
        setWhisperModelDownloaded(next.whisperModelDownloaded)
        setWhisperModelDownloading(next.whisperModelDownloading)
        setWhisperModelDownloadFailed(next.whisperModelDownloadFailed)
        setWhisperModelRemoving(next.whisperModelRemoving)
        setWhisperModelRemovalFailed(next.whisperModelRemovalFailed)
        if ((next.state === 'installing' || next.state === 'removing' || next.whisperModelDownloading || next.whisperModelRemoving
          || (next.state === 'ready' && !next.whisperModelDownloaded)) && !stopped) {
          const interval = next.state === 'installing' || next.state === 'removing' || next.whisperModelDownloading || next.whisperModelRemoving ? 1500 : 10_000
          timer = setTimeout(() => { void refresh() }, interval)
        }
      } catch {
        if (controller.signal.aborted || stopped) return
        timer = setTimeout(() => { void refresh() }, 3000)
      }
    }
    void refresh()
    return () => {
      stopped = true
      controller.abort()
      if (timer !== null) clearTimeout(timer)
    }
  }, [asrSetup, t, view, whisperModelDownloading, whisperModelRemoving])

  if (view === 'summary') return t('description')

  function stopActive(abort: boolean): void {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
    const active = request.current
    request.current = null
    if (abort) active?.abort()
  }

  function finish(controller: AbortController, next: LoginState): void {
    if (request.current !== controller) return
    stopActive(false)
    setQr(undefined)
    setStatus(next)
  }

  function schedulePoll(
    challenge: LoginChallenge,
    controller: AbortController,
    expiresAt: number,
  ): void {
    if (request.current !== controller) return
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) {
      finish(controller, 'timed-out')
      return
    }
    timer.current = setTimeout(() => {
      timer.current = null
      void poll(challenge, controller, expiresAt)
    }, Math.min(challenge.pollIntervalMs, remaining))
  }

  async function poll(
    challenge: LoginChallenge,
    controller: AbortController,
    expiresAt: number,
  ): Promise<void> {
    if (request.current !== controller || controller.signal.aborted) return
    if (Date.now() >= expiresAt) {
      finish(controller, 'timed-out')
      return
    }
    try {
      const value = await postJson(
        LOGIN_POLL_PATH,
        { key: challenge.key },
        controller.signal,
        t('requestFailed'),
      )
      if (request.current !== controller || controller.signal.aborted) return
      const result = readPoll(value)
      if (result === undefined) {
        finish(controller, 'failed')
        setError(t('invalidResponse'))
        return
      }
      setError(undefined)
      switch (result.state) {
        case 'ok':
          finish(controller, 'success')
          setAccount(undefined)
          setAccountVisible(false)
          void refreshAccount()
          return
        case 'expired':
          finish(controller, 'expired')
          return
        case 'unknown':
          finish(controller, 'failed')
          setError(result.message || t('failed'))
          return
        case 'scanned':
          setStatus('scanned')
          break
        case 'waiting':
          setStatus('waiting')
          break
      }
      schedulePoll(challenge, controller, expiresAt)
    } catch {
      if (controller.signal.aborted || request.current !== controller) return
      setStatus('waiting')
      setError(t('networkRetry'))
      schedulePoll(challenge, controller, expiresAt)
    }
  }

  async function startLogin(): Promise<void> {
    if (status === 'starting') return
    accountRequest.current?.abort()
    accountRequest.current = null
    setAccountLoading(false)
    setAccountLoadFailed(false)
    setAccountVisible(false)
    stopActive(true)
    const controller = new AbortController()
    request.current = controller
    setQr(undefined)
    setError(undefined)
    setStatus('starting')
    try {
      const value = await postJson(LOGIN_START_PATH, {}, controller.signal, t('requestFailed'))
      if (request.current !== controller || controller.signal.aborted) return
      const challenge = readChallenge(value)
      if (challenge === undefined) throw new Error(t('invalidResponse'))
      setQr(challenge.qr)
      setStatus('waiting')
      schedulePoll(challenge, controller, Date.now() + challenge.timeoutMs)
    } catch {
      if (controller.signal.aborted || request.current !== controller) return
      stopActive(false)
      setStatus('failed')
      setError(t('requestFailed'))
    }
  }

  function cancelLogin(): void {
    stopActive(true)
    setQr(undefined)
    setError(undefined)
    setStatus(account === undefined || account === null ? 'idle' : 'success')
  }

  async function installAsrDependencies(): Promise<void> {
    if (asrSetup === 'installing' || asrSetup === 'removing' || whisperModelDownloading || whisperModelRemoving
      || asrSetup === 'ready') return
    setAsrSetup('installing')
    const controller = new AbortController()
    try {
      const value = await postJson(
        ASR_SETUP_INSTALL_PATH,
        { approved: true },
        controller.signal,
        t('asrUnavailable'),
      )
      const next = readAsrSetup(value)
      if (next === undefined) throw new Error(t('invalidResponse'))
      setAsrSetup(next.state)
      setWhisperModelDownloaded(next.whisperModelDownloaded)
      setWhisperModelDownloading(next.whisperModelDownloading)
      setWhisperModelDownloadFailed(next.whisperModelDownloadFailed)
    } catch {
      setAsrSetup('failed')
    }
  }

  async function downloadWhisperModel(reinstall = false): Promise<void> {
    if (asrSetup !== 'ready' || whisperModelDownloading || whisperModelRemoving) return
    setWhisperModelDownloadFailed(false)
    setWhisperModelDownloading(true)
    const controller = new AbortController()
    try {
      const value = await postJson(
        ASR_MODEL_DOWNLOAD_PATH,
        { approved: true, ...(reinstall ? { reinstall: true } : {}) },
        controller.signal,
        t('asrUnavailable'),
      )
      const next = readAsrSetup(value)
      if (next === undefined) throw new Error(t('invalidResponse'))
      setAsrSetup(next.state)
      setWhisperModelDownloaded(next.whisperModelDownloaded)
      setWhisperModelDownloading(next.whisperModelDownloading)
      setWhisperModelDownloadFailed(next.whisperModelDownloadFailed)
      setWhisperModelRemoving(next.whisperModelRemoving)
      setWhisperModelRemovalFailed(next.whisperModelRemovalFailed)
    } catch {
      setWhisperModelDownloading(false)
      setWhisperModelDownloadFailed(true)
    }
  }

  async function removeWhisperModel(): Promise<void> {
    if (asrSetup === 'installing' || asrSetup === 'removing' || whisperModelDownloading || whisperModelRemoving) return
    setWhisperModelDownloadFailed(false)
    setWhisperModelRemovalFailed(false)
    setWhisperModelRemoving(true)
    const controller = new AbortController()
    try {
      const value = await postJson(
        ASR_MODEL_REMOVE_PATH,
        { approved: true },
        controller.signal,
        t('asrUnavailable'),
      )
      const next = readAsrSetup(value)
      if (next === undefined) throw new Error(t('invalidResponse'))
      setAsrSetup(next.state)
      setWhisperModelDownloaded(next.whisperModelDownloaded)
      setWhisperModelDownloading(next.whisperModelDownloading)
      setWhisperModelDownloadFailed(next.whisperModelDownloadFailed)
      setWhisperModelRemoving(next.whisperModelRemoving)
      setWhisperModelRemovalFailed(next.whisperModelRemovalFailed)
    } catch {
      setWhisperModelRemoving(false)
      setWhisperModelRemovalFailed(true)
    }
  }

  const statusCopy: Record<LoginState, string> = {
    idle: t('loginStateIdle'),
    starting: t('starting'),
    waiting: t('waiting'),
    scanned: t('scanned'),
    success: t('succeeded'),
    expired: t('expired'),
    'timed-out': t('timedOut'),
    failed: t('failed'),
  }
  const active = status === 'starting' || status === 'waiting' || status === 'scanned'
  return (
    <section style={{
      background: 'radial-gradient(ellipse at 4% 0%, rgba(179, 112, 76, 0.11), transparent 32%), radial-gradient(ellipse at 100% 8%, rgba(96, 128, 112, 0.1), transparent 31%), repeating-linear-gradient(0deg, rgba(118, 91, 56, 0.018) 0, rgba(118, 91, 56, 0.018) 1px, transparent 1px, transparent 5px), linear-gradient(145deg, #fbf7ed 0%, #f4ecdc 56%, #f8f3e8 100%)',
      border: '3px double rgba(157, 127, 76, 0.42)',
      borderRadius: '18px',
      boxShadow: '0 12px 30px rgba(91, 70, 43, 0.12)',
      boxSizing: 'border-box',
      color: CLASSIC.ink,
      display: 'grid',
      gap: '1rem',
      fontFamily: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
      padding: 'clamp(0.9rem, 2.5vw, 1.45rem)',
    }}>
      <div style={{ alignItems: 'stretch', display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 25rem), 1fr))' }}>
        <AsrSetupPanel
          state={asrSetup}
          whisperModelDownloaded={whisperModelDownloaded}
          whisperModelDownloading={whisperModelDownloading}
          whisperModelDownloadFailed={whisperModelDownloadFailed}
          whisperModelRemoving={whisperModelRemoving}
          whisperModelRemovalFailed={whisperModelRemovalFailed}
          t={t}
          onInstall={() => { void installAsrDependencies() }}
          onDownloadModel={() => { void downloadWhisperModel() }}
          onReinstallModel={() => { void downloadWhisperModel(true) }}
          onRemoveModel={() => { void removeWhisperModel() }}
        />
        <LoginPanel
          active={active}
          account={account}
          accountVisible={accountVisible}
          accountLoading={accountLoading}
          accountLoadFailed={accountLoadFailed}
          error={error}
          qr={qr}
          status={status}
          statusText={statusCopy[status]}
          t={t}
          onCancel={cancelLogin}
          onStart={() => { void startLogin() }}
          onToggleAccount={() => setAccountVisible(value => !value)}
        />
      </div>

      <UsageGuide t={t} />
    </section>
  )
}

/** Render the saved account profile or the current QR login challenge. */
function LoginPanel({ active, account, accountVisible, accountLoading, accountLoadFailed, error, qr, status, statusText, t, onCancel, onStart, onToggleAccount }: LoginPanelProps) {
  const success = status === 'success'
  const showingAccount = qr === undefined && !active && account !== undefined && account !== null
  const attention = status === 'failed' || status === 'expired' || status === 'timed-out'
  const statusColor = success ? CLASSIC.jade : attention ? CLASSIC.cinnabar : status === 'starting' ? '#9b7a42' : CLASSIC.blue
  const statusBackground = success ? '#e6eee2' : attention ? '#f4e5da' : '#eee9dc'
  const primaryButton: CSSProperties = {
    background: 'linear-gradient(135deg, #b45a46, #933f35)',
    border: '1px solid #c69d5a',
    borderRadius: '7px',
    boxShadow: '0 4px 10px rgba(133, 67, 46, 0.18), inset 0 1px rgba(255, 241, 210, 0.22)',
    color: '#fff8e9',
    cursor: status === 'starting' ? 'wait' : 'pointer',
    font: 'inherit',
    fontWeight: 700,
    opacity: status === 'starting' ? 0.68 : 1,
    padding: '0.7rem 1rem',
  }
  const secondaryButton: CSSProperties = {
    background: 'linear-gradient(135deg, #fffaf0, #f1e8d7)',
    border: '1px solid rgba(161, 132, 82, 0.4)',
    borderRadius: '7px',
    color: '#625641',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: 650,
    padding: '0.7rem 1rem',
  }

  return (
    <section style={{
      background: 'linear-gradient(145deg, #fffaf0, #f8f2e6)',
      border: '1px solid rgba(164, 136, 86, 0.36)',
      borderRadius: '13px',
      boxShadow: '0 5px 15px rgba(91, 70, 43, 0.08)',
      display: 'grid',
      gap: '0.7rem',
      minWidth: 0,
      padding: '1rem',
    }}>
      <header style={{ alignItems: 'center', display: 'flex', gap: '0.65rem', justifyContent: 'space-between', minWidth: 0 }}>
        <div style={{ alignItems: 'center', display: 'flex', gap: '0.5rem', minWidth: 0 }}>
          <span aria-hidden="true" style={{ color: CLASSIC.jade, fontSize: '1.05rem' }}>❖</span>
          <strong style={{ color: '#37352d', fontSize: '1rem', letterSpacing: '0.04em' }}>{t('loginCardTitle')}</strong>
        </div>
        <span aria-live="polite" title={error ?? statusText} style={{ alignItems: 'center', background: statusBackground, border: `1px solid ${statusColor}55`, borderRadius: '5px', color: statusColor, display: 'inline-flex', flex: '0 0 auto', fontSize: '0.76rem', fontWeight: 700, maxWidth: '48%', overflow: 'hidden', padding: '0.25rem 0.55rem', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {statusText}
        </span>
      </header>
      <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'center', padding: '0.15rem 0' }}>
        {showingAccount && account !== undefined && account !== null
          ? <LoginAccountDetails account={account} visible={accountVisible} t={t} onToggle={onToggleAccount} />
          : qr === undefined
          ? (
            <div style={{ alignItems: 'center', background: 'rgba(255, 252, 244, 0.88)', border: '1px dashed rgba(164, 136, 86, 0.52)', borderRadius: '9px', color: '#8d7951', display: 'flex', flexDirection: 'column', gap: '0.4rem', height: '205px', justifyContent: 'center', maxWidth: '220px', padding: '0.6rem', width: '100%' }}>
              <span aria-hidden="true" style={{ color: CLASSIC.jade, fontSize: '2.5rem', lineHeight: 1 }}>{status === 'starting' ? '…' : '▦'}</span>
              <span style={{ fontSize: '0.88rem' }}>
                {status === 'starting'
                  ? t('qrPreparing')
                  : accountLoading
                    ? t('accountLoading')
                    : accountLoadFailed
                      ? t('accountLoadFailed')
                      : success
                        ? t('accountUnavailable')
                        : t('qrPlaceholder')}
              </span>
            </div>
          )
          : (
            <img
              src={qr}
              alt={t('qrAlt')}
              width={220}
              height={220}
              style={{ background: '#fffdf7', border: '5px solid #fffdf7', borderRadius: '8px', boxShadow: '0 0 0 1px rgba(164, 136, 86, 0.42), 0 5px 13px rgba(91, 70, 43, 0.12)', height: 'auto', maxWidth: '100%', objectFit: 'contain', width: '205px' }}
            />
          )}
      </div>
      <p style={{ color: CLASSIC.muted, fontSize: '0.86rem', lineHeight: 1.55, margin: 0, textAlign: 'center' }}>
        {showingAccount ? t('accountDetailsHint') : t('instructions')}
      </p>
      {error !== undefined && <p aria-live="polite" role="status" style={{ background: '#f4e5da', borderRadius: '5px', color: attention ? CLASSIC.cinnabar : '#795d46', fontSize: '0.82rem', lineHeight: 1.5, margin: 0, padding: '0.45rem 0.6rem' }}>{error}</p>}
      {success && <p style={{ color: CLASSIC.jade, fontSize: '0.82rem', lineHeight: 1.5, margin: 0, textAlign: 'center' }}>{t('loginSuccessHint')}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <button type="button" disabled={status === 'starting'} onClick={onStart} style={{ ...primaryButton, flex: '1 1 8rem' }}>
          {qr !== undefined ? t('restartLogin') : account !== undefined && account !== null ? t('switchAccount') : t('startLogin')}
        </button>
        {active && <button type="button" onClick={onCancel} style={{ ...secondaryButton, flex: '1 1 8rem' }}>{t('cancel')}</button>}
      </div>
      {qr !== undefined && <p style={{ color: CLASSIC.muted, fontSize: '0.78rem', lineHeight: 1.5, margin: 0, textAlign: 'center' }}>{t('scanHint')}</p>}
    </section>
  )
}

/** Render the public account profile with a local reveal control. */
function LoginAccountDetails({ account, visible, t, onToggle }: LoginAccountDetailsProps) {
  const profileValue = (value: string | number | null): string => {
    if (value === null || value === '') return t('accountValueMissing')
    return visible ? String(value) : t('accountValueMasked')
  }

  return (
    <div style={{ background: '#fffbe6', border: '1px solid #ffd666', borderRadius: '10px', boxSizing: 'border-box', color: '#8d7951', display: 'grid', gap: '0.75rem', maxWidth: '340px', minHeight: '226px', padding: '0.85rem', width: '100%' }}>
      <header style={{ alignItems: 'center', display: 'flex', gap: '0.7rem', minWidth: 0 }}>
        <div style={{ alignItems: 'center', background: '#fff1b8', border: '1px solid #ffd666', borderRadius: '12px', color: '#faad14', display: 'flex', flex: '0 0 56px', height: '56px', justifyContent: 'center', overflow: 'hidden', width: '56px' }}>
          {account.face !== '' && <img
            src={account.face}
            alt={visible ? account.name : t('accountAvatarAlt')}
            referrerPolicy="no-referrer"
            onError={event => { event.currentTarget.style.visibility = 'hidden' }}
            style={{ filter: visible ? 'none' : 'blur(8px)', height: '100%', objectFit: 'cover', transform: visible ? 'none' : 'scale(1.18)', width: '100%' }}
          />}
          {account.face === '' && <span aria-hidden="true" style={{ fontSize: '1.5rem' }}>✦</span>}
        </div>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <span style={{ color: CLASSIC.muted, display: 'block', fontSize: '0.74rem', marginBottom: '0.15rem' }}>{t('accountCurrent')}</span>
          <strong style={{ color: '#37352d', display: 'block', fontSize: '1rem', overflowWrap: 'anywhere' }}>
            {visible ? account.name : maskAccountName(account.name)}
          </strong>
        </div>
        <button
          type="button"
          aria-label={visible ? t('hideAccountDetails') : t('showAccountDetails')}
          aria-pressed={visible}
          onClick={onToggle}
          title={visible ? t('hideAccountDetails') : t('showAccountDetails')}
          style={{ alignItems: 'center', background: '#fff1b8', border: '1px solid #ffd666', borderRadius: '6px', color: '#613400', cursor: 'pointer', display: 'inline-flex', flex: '0 0 36px', height: '34px', justifyContent: 'center', padding: '0', width: '36px' }}
        >
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
            {visible
              ? <><path d="M3 3l18 18" /><path d="M10.6 10.6a2 2 0 002.8 2.8" /><path d="M9.9 5.2A10.7 10.7 0 0112 5c6 0 9.5 7 9.5 7a15.6 15.6 0 01-3.2 4.1" /><path d="M6.6 6.6A15.5 15.5 0 002.5 12s3.5 7 9.5 7a10.6 10.6 0 004.1-.8" /></>
              : <><path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z" /><circle cx="12" cy="12" r="3" /></>}
          </svg>
        </button>
      </header>
      <div style={{ borderLeft: '3px solid #ffd666', minWidth: 0, padding: '0.1rem 0 0.1rem 0.55rem' }}>
        <span style={{ color: CLASSIC.muted, display: 'block', fontSize: '0.74rem', marginBottom: '0.15rem' }}>{t('accountSign')}</span>
        <p style={{ color: '#625641', fontSize: '0.82rem', lineHeight: 1.45, margin: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{profileValue(account.sign)}</p>
      </div>
      <dl style={{ display: 'grid', gap: '0.5rem', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', margin: 0, minWidth: 0 }}>
        <AccountField label={t('accountSex')} value={profileValue(displaySex(account.sex, t))} />
        <AccountField label={t('accountBirthday')} value={profileValue(account.birthday)} />
        <AccountField label={t('accountLevel')} value={profileValue(account.level)} />
        <AccountField label={t('accountMid')} value={visible ? account.mid : maskAccountMid(account.mid)} />
      </dl>
    </div>
  )
}

/** Render one compact account profile field. */
function AccountField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={{ background: '#fff1b8', borderRadius: '6px', minWidth: 0, padding: '0.4rem 0.5rem' }}>
      <dt style={{ color: CLASSIC.muted, fontSize: '0.7rem', marginBottom: '0.1rem' }}>{label}</dt>
      <dd style={{ color: '#37352d', fontSize: '0.78rem', margin: 0, overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  )
}

/** Map Bilibili's sex value to the active locale. */
function displaySex(sex: string, t: LoginAccountDetailsProps['t']): string {
  switch (sex) {
    case '\u7537': return t('accountSexMale')
    case '\u5973': return t('accountSexFemale')
    case '\u4fdd\u5bc6': return t('accountSexPrivate')
    default: return ''
  }
}

/** Hide all but the first account-name character. */
function maskAccountName(name: string): string {
  const characters = Array.from(name)
  if (characters.length <= 1) return '\u2022\u2022\u2022'
  return characters[0] + '\u2022'.repeat(Math.min(4, characters.length - 1))
}

/** Keep two MID digits at each end visible. */
function maskAccountMid(mid: string): string {
  if (mid.length <= 4) return '\u2022'.repeat(mid.length)
  return mid.slice(0, 2) + '\u2022'.repeat(Math.min(5, mid.length - 4)) + mid.slice(-2)
}

/** Render the localized usage instructions from their Markdown source. */
function UsageGuide({ t }: UsageGuideProps) {
  const labels = useMemo(() => ({
    code: { copyLabel: t('markdownCopyLabel'), copiedLabel: t('markdownCopiedLabel') },
    footnotes: t('markdownFootnotesLabel'),
  }), [t])
  return (
    <section style={{
      background: 'linear-gradient(125deg, #fffaf0, #f5eddc 55%, #f7f3e8)',
      border: '1px solid rgba(164, 136, 86, 0.34)',
      borderRadius: '13px',
      boxShadow: '0 5px 15px rgba(91, 70, 43, 0.07)',
      padding: '1rem',
    }}>
      <MarkdownText text={t('usageMarkdown')} labels={labels} variant="compact" />
    </section>
  )
}

/** Render dependency states and their available operations. */
function AsrSetupPanel({
  state,
  whisperModelDownloaded,
  whisperModelDownloading,
  whisperModelRemoving,
  t,
  onInstall,
  onDownloadModel,
  onReinstallModel,
  onRemoveModel,
}: AsrSetupPanelProps) {
  const cardStyle: CSSProperties = {
    background: 'linear-gradient(145deg, #fffaf0, #f6efdf)',
    border: '1px solid rgba(164, 136, 86, 0.36)',
    borderRadius: '13px',
    boxShadow: '0 5px 15px rgba(91, 70, 43, 0.08)',
    color: CLASSIC.ink,
    minWidth: 0,
    padding: '1rem',
  }
  let setupActions: ReactNode = null
  if (state === 'consent-required' || state === 'failed') {
    setupActions = <IconActionButton icon="download" label={t('asrInstallAction')} ariaLabel={t('asrInstall')} tone="cinnabar" onClick={onInstall} />
  }

  const pythonStatus = state === undefined
    ? t('asrStateChecking')
    : state === 'ready'
      ? t('asrStateReady')
      : state === 'installing'
        ? t('asrStateInstalling')
        : state === 'removing'
          ? t('asrStateRemoving')
          : state === 'failed'
            ? t('asrStateFailed')
            : t('asrStatePending')
  
  
  const setupBusy = state === 'installing' || state === 'removing'

  return (
    <section style={cardStyle}>
      <div style={{ alignItems: 'center', background: 'rgba(255, 252, 244, 0.72)', border: '1px solid rgba(164, 136, 86, 0.25)', borderRadius: '8px', display: 'flex', flexWrap: 'wrap', gap: '0.7rem', justifyContent: 'space-between', padding: '0.75rem' }}>
        <div style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.45rem', minWidth: 0 }}>
          <DependencyStatusIcon installed={state === 'ready'} label={pythonStatus} />
          <strong style={{ color: '#443c30', fontSize: '0.9rem' }}>{t('asrPythonEnvTitle')}</strong>
          {/* <span aria-live="polite" style={{ color: state === 'ready' ? CLASSIC.jade : state === 'failed' ? CLASSIC.cinnabar : CLASSIC.muted, fontSize: '0.78rem' }}>{pythonStatus}</span> */}
        </div>
        <div style={{ alignItems: 'center', display: 'flex', flex: '0 0 auto', flexWrap: 'wrap', gap: '0.35rem' }}>{setupActions}</div>
      </div>
      {setupBusy && <progress aria-label={pythonStatus} style={{ accentColor: state === 'removing' ? CLASSIC.cinnabar : CLASSIC.jade, display: 'block', height: '0.55rem', marginTop: '0.65rem', width: '100%' }} />}
      <ul style={{ background: 'rgba(255, 252, 244, 0.72)', border: '1px solid rgba(164, 136, 86, 0.25)', borderRadius: '8px', listStyle: 'none', margin: '0.85rem 0 0', padding: '0 0.75rem' }}>
        <li style={{ padding: '0.75rem 0' }}>
          <div style={{ alignItems: 'center', display: 'flex', gap: '0.75rem', justifyContent: 'space-between', minWidth: 0 }}>
            <div style={{ alignItems: 'center', display: 'flex', gap: '0.45rem', minWidth: 0 }}>
              <DependencyStatusIcon installed={whisperModelDownloaded} label={t(whisperModelDownloaded ? 'asrDownloaded' : 'asrNotDownloaded')} />
              <strong style={{ color: '#443c30', fontSize: '0.9rem' }}>{t('asrModelTitle')}</strong>
            </div>
            <div style={{ alignItems: 'center', display: 'flex', flex: '0 0 auto', flexWrap: 'wrap', gap: '0.35rem' }}>
              
              {state === 'ready' && !whisperModelDownloaded && !whisperModelDownloading && !whisperModelRemoving && !setupBusy && (
                <IconActionButton
                  icon="download"
                  label={t('asrModelDownloadAction')}
                  ariaLabel={t('asrModelDownload')}
                  tone="jade"
                  onClick={onDownloadModel}
                />
              )}
              {state === 'ready' && whisperModelDownloaded && !whisperModelDownloading && !whisperModelRemoving && !setupBusy && (
                <IconActionButton
                  icon="refresh"
                  label={t('asrModelReinstallAction')}
                  ariaLabel={t('asrModelReinstall')}
                  tone="jade"
                  onClick={onReinstallModel}
                />
              )}
              {whisperModelDownloaded && !whisperModelRemoving && !whisperModelDownloading && !setupBusy && (
                <IconActionButton
                  icon="delete"
                  label={t('asrRemoveAction')}
                  ariaLabel={t('asrModelRemove')}
                  tone="cinnabar"
                  onClick={onRemoveModel}
                />
              )}
            </div>
          </div>
          {(whisperModelDownloading || whisperModelRemoving) && (
            <progress
              aria-label={t(whisperModelDownloading ? 'asrModelDownloading' : 'asrModelRemoving')}
              style={{
                accentColor: whisperModelRemoving ? CLASSIC.cinnabar : CLASSIC.jade,
                display: 'block',
                height: '0.55rem',
                marginTop: '0.65rem',
                width: '100%',
              }}
            />
          )}
        </li>
      </ul>
    </section>
  )
}

/** Mark whether a local dependency is present using the shared check and close glyphs. */
function DependencyStatusIcon({ installed, label }: DependencyStatusIconProps) {
  const color = installed ? CLASSIC.jade : CLASSIC.cinnabar
  return (
    <span
      aria-label={label}
      role="img"
      title={label}
      style={{ alignItems: 'center', border: `1px solid ${color}`, borderRadius: '50%', color, display: 'inline-flex', flex: '0 0 16px', height: '16px', justifyContent: 'center', width: '16px' }}
    >
      {installed ? <IconCheckOutline16 size={10} /> : <IconCloseOutline16 size={9} />}
    </span>
  )
}

/** Render a compact, labeled dependency action at the end of its list row. */
function IconActionButton({ icon, label, ariaLabel = label, tone, onClick }: IconActionButtonProps) {
  const color = tone === 'jade' ? CLASSIC.jade : tone === 'cinnabar' ? CLASSIC.cinnabar : CLASSIC.muted
  const path = icon === 'download'
    ? 'M12 3v11m0 0 4-4m-4 4-4-4M5 20h14'
    : icon === 'refresh'
      ? 'M20 7v5h-5M4 17v-5h5m-3-4a7 7 0 0 1 12-2l2 1m-16 6-1 1m1-1a7 7 0 0 0 12 2'
      : 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v6m4-6v6'
  return (
    <button
      aria-label={ariaLabel}
      title={ariaLabel}
      type="button"
      onClick={onClick}
      style={{ alignItems: 'center', background: tone === 'jade' ? '#edf1e7' : tone === 'cinnabar' ? '#f7eae1' : '#f2eee4', border: `1px solid ${color}55`, borderRadius: '6px', color, cursor: 'pointer', display: 'inline-flex', flex: '0 0 auto', font: 'inherit', fontSize: '0.78rem', fontWeight: 650, gap: '0.35rem', height: '34px', justifyContent: 'center', padding: '0 0.55rem', whiteSpace: 'nowrap' }}
    >
      <svg aria-hidden="true" fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="17">
        <path d={path} />
      </svg>
      <span>{label}</span>
    </button>
  )
}

/** Send one authenticated, same-origin JSON request to the Host login route. */
async function postJson(
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  fallback: string,
): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  let value: unknown
  try {
    value = await response.json()
  } catch (error) {
    void error
    throw new Error(fallback)
  }
  if (!response.ok) {
    throw new Error(fallback)
  }
  return value
}

/** Read one same-origin JSON response without adding credentials to the request. */
async function getJson(path: string, signal: AbortSignal, fallback: string): Promise<unknown> {
  const response = await fetch(path, { method: 'GET', signal, cache: 'no-store' })
  let value: unknown
  try {
    value = await response.json()
  } catch (error) {
    void error
    throw new Error(fallback)
  }
  if (!response.ok) throw new Error(fallback)
  return value
}

/** Validate a setup state returned by the Host. */
function readAsrSetup(value: unknown): AsrSetupStatus | undefined {
  if (!isRecord(value)) return undefined
  const state = value.state
  if (state !== 'consent-required' && state !== 'installing' && state !== 'ready' && state !== 'removing' && state !== 'failed') return undefined
  if (typeof value.whisperModelDownloaded !== 'boolean'
    || typeof value.whisperModelDownloading !== 'boolean'
    || typeof value.whisperModelDownloadFailed !== 'boolean'
    || typeof value.whisperModelRemoving !== 'boolean'
    || typeof value.whisperModelRemovalFailed !== 'boolean') return undefined
  return {
    state,
    whisperModelDownloaded: value.whisperModelDownloaded,
    whisperModelDownloading: value.whisperModelDownloading,
    whisperModelDownloadFailed: value.whisperModelDownloadFailed,
    whisperModelRemoving: value.whisperModelRemoving,
    whisperModelRemovalFailed: value.whisperModelRemovalFailed,
  }
}

/** Validate the Host's QR challenge response before displaying the image. */
function readChallenge(value: unknown): LoginChallenge | undefined {
  if (!isRecord(value)) return undefined
  const { key, qr, pollIntervalMs, timeoutMs } = value
  if (typeof key !== 'string' || key.length === 0 || key.length > 512) return undefined
  if (typeof qr !== 'string' || !qr.startsWith('data:image/png;base64,')) return undefined
  if (typeof pollIntervalMs !== 'number' || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) return undefined
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return undefined
  return { key, qr, pollIntervalMs, timeoutMs }
}

/** Validate one login-poll response from the Host. */
function readPoll(value: unknown): LoginPoll | undefined {
  if (!isRecord(value)) return undefined
  const state = value.state
  if (state !== 'waiting' && state !== 'scanned' && state !== 'ok' && state !== 'expired' && state !== 'unknown') {
    return undefined
  }
  return typeof value.message === 'string' ? { state, message: value.message } : { state }
}

/** Validate public account fields returned by the Host. */
function readLoginAccount(value: unknown): LoginAccount | null | undefined {
  if (!isRecord(value) || !('account' in value)) return undefined
  if (value.account === null) return null
  if (!isRecord(value.account)) return undefined
  const { face, name, sign, sex, birthday, level, mid } = value.account
  const safeFace = typeof face === 'string' && (face === '' || isHttpsUrl(face)) ? face : ''
  const validLevel = level === null || (typeof level === 'number' && Number.isSafeInteger(level) && level >= 0)
  return typeof name === 'string' && name.trim().length > 0
    && typeof sign === 'string'
    && typeof sex === 'string'
    && (birthday === null || typeof birthday === 'string')
    && validLevel
    && typeof mid === 'string' && /^\d+$/u.test(mid)
    ? { face: safeFace, name, sign, sex, birthday, level, mid }
    : undefined
}

/** Accept only HTTPS profile image URLs from the Host response. */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Narrow one untrusted JSON value to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
