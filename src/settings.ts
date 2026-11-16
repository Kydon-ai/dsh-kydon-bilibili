/** Namespace and client-visible values for the plugin's user settings. */

/** Durable settings namespace registered by the Bilibili plugin. */
export const BILIBILI_SETTINGS_NAMESPACE = 'kydon-bilibili'

/** Settings used to gate notification replies and automatic video summaries. */
export interface BilibiliAutomationSettings {
  /** UID whose messages may receive an automatic reply; empty disables polling. */
  readonly ownerUid: string
  /** Whether the plugin should periodically watch videos and publish summaries. */
  readonly videoCommentEnabled: boolean
}
