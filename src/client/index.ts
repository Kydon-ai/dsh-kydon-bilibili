/** Bilibili login settings card, browser half. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { BilibiliLoginCard } from './LoginCard.tsx'
import { en, LOCALE_NAMESPACE, zh } from './locales.ts'
import type { BilibiliSettingsInjected } from './login-card.types.ts'
import { BILIBILI_SETTINGS_NAMESPACE, type BilibiliAutomationSettings } from '../settings.ts'

/** Services used by the card's localized plugin-manager slot. */
export const inject = ['locale', 'slots', 'settingsScope']

/**
 * Register the localized login card on this bundle's configuration page.
 * @param ctx - browser context carrying locale and slot services.
 */
export function apply(ctx: ClientContext): void {
  const settings = ctx.settingsScope.bind<BilibiliAutomationSettings>({
    namespace: BILIBILI_SETTINGS_NAMESPACE,
    decode: decodeAutomationSettings,
  })
  const settingsFace = (): BilibiliSettingsInjected => ({
    hooks: { settings },
    saveSettings: async (ownerUid, videoCommentEnabled) => {
      const before = settings.getSnapshot()
      if (before.status !== 'ready' || !before.writable) {
        throw new Error('Bilibili settings are not writable in this connection.')
      }
      await settings.mutate([
        { op: 'set', path: ['ownerUid'], value: ownerUid },
        { op: 'set', path: ['videoCommentEnabled'], value: videoCommentEnabled },
      ], before.revision)
      const saved = settings.getSnapshot()
      if (saved.status !== 'ready' || saved.value?.ownerUid !== ownerUid
        || saved.value.videoCommentEnabled !== videoCommentEnabled) {
        throw new Error('Bilibili settings were not saved.')
      }
    },
  })
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'dsh-kydon-bilibili: browser dictionaries',
  )
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@kydon/dsh-kydon-bilibili',
    locale: LOCALE_NAMESPACE,
    inject: settingsFace,
  }, BilibiliLoginCard))
}

/** Narrow the settings wire section to the fields this card edits. */
function decodeAutomationSettings(value: unknown): BilibiliAutomationSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return typeof record.ownerUid === 'string' && typeof record.videoCommentEnabled === 'boolean'
    ? { ownerUid: record.ownerUid, videoCommentEnabled: record.videoCommentEnabled }
    : undefined
}
