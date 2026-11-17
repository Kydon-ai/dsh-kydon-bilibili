/** Entry identity and client-visible values for the plugin's live Config form. */

/** Stable Loader entry id used by cordis.yml and configForms.get(). */
export const BILIBILI_CONFIG_ENTRY_ID = 'dsh-kydon-bilibili'

/** Settings used to gate notification replies and automatic video summaries. */
export interface BilibiliAutomationSettings {
  /** UID whose messages may receive an automatic reply; empty disables polling. */
  readonly ownerUid: string
  /** Whether the plugin should periodically watch videos and publish summaries. */
  readonly videoCommentEnabled: boolean
}
