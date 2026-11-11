/** Browser-side types for the Bilibili login settings card. */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LOCALE_NAMESPACE } from './locales.ts'

/** Login request states rendered by the card. */
export type LoginState = 'idle' | 'starting' | 'waiting' | 'scanned' | 'success' | 'expired' | 'timed-out' | 'failed'

/** States returned while polling a Bilibili QR challenge. */
export type ChallengeState = 'waiting' | 'scanned' | 'ok' | 'expired' | 'unknown'

/** Local transcription environment states returned by the Host. */
export type AsrSetupState = 'consent-required' | 'installing' | 'ready' | 'removing' | 'failed'

/** Setup state and model cache flags returned by the Host. */
export interface AsrSetupStatus {
  readonly state: AsrSetupState
  readonly whisperModelDownloaded: boolean
  readonly whisperModelDownloading: boolean
  readonly whisperModelDownloadFailed: boolean
  readonly whisperModelRemoving: boolean
  readonly whisperModelRemovalFailed: boolean
}

/** QR challenge data shown during Bilibili sign-in. */
export interface LoginChallenge {
  readonly key: string
  readonly qr: string
  readonly pollIntervalMs: number
  readonly timeoutMs: number
}

/** Public account profile fields returned by the Host. */
export interface LoginAccount {
  readonly face: string
  readonly name: string
  readonly sign: string
  readonly sex: string
  readonly birthday: string | null
  readonly level: number | null
  readonly mid: string
}

/** State returned by one QR challenge poll. */
export interface LoginPoll {
  readonly state: ChallengeState
  readonly message?: string
}

/** Props supplied by the Plugins page and this card's locale dictionary. */
export type BilibiliLoginCardProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<typeof LOCALE_NAMESPACE>

/** Props for the login panel and its request controls. */
export interface LoginPanelProps {
  readonly active: boolean
  readonly account: LoginAccount | null | undefined
  readonly accountVisible: boolean
  readonly accountLoading: boolean
  readonly accountLoadFailed: boolean
  readonly error: string | undefined
  readonly qr: string | undefined
  readonly status: LoginState
  readonly statusText: string
  readonly t: BilibiliLoginCardProps['t']
  readonly onCancel: () => void
  readonly onStart: () => void
  readonly onToggleAccount: () => void
}

/** Props for the saved account details and reveal control. */
export interface LoginAccountDetailsProps {
  readonly account: LoginAccount
  readonly visible: boolean
  readonly t: BilibiliLoginCardProps['t']
  readonly onToggle: () => void
}

/** Props for the localized Markdown usage guide. */
export interface UsageGuideProps {
  readonly t: BilibiliLoginCardProps['t']
}

/** Props for dependency statuses and available setup operations. */
export interface AsrSetupPanelProps {
  readonly state: AsrSetupState | undefined
  readonly whisperModelDownloaded: boolean
  readonly whisperModelDownloading: boolean
  readonly whisperModelDownloadFailed: boolean
  readonly whisperModelRemoving: boolean
  readonly whisperModelRemovalFailed: boolean
  readonly t: BilibiliLoginCardProps['t']
  readonly onInstall: () => void
  readonly onDownloadModel: () => void
  readonly onReinstallModel: () => void
  readonly onRemoveModel: () => void
}

/** Icon names supported by dependency action buttons. */
export type DependencyActionIcon = 'download' | 'refresh' | 'delete'

/** Color roles supported by dependency action buttons. */
export type DependencyActionTone = 'jade' | 'cinnabar' | 'muted'

/** Props for a compact dependency action button. */
export interface IconActionButtonProps {
  readonly icon: DependencyActionIcon
  readonly label: string
  readonly ariaLabel?: string
  readonly tone: DependencyActionTone
  readonly onClick: () => void
}

/** Props for a dependency's installed-state glyph. */
export interface DependencyStatusIconProps {
  readonly installed: boolean
  readonly label: string
}
