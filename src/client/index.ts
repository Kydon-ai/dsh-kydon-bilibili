/** Bilibili login settings card, browser half. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { BilibiliLoginCard } from './LoginCard.tsx'
import { BilibiliSettingsSection } from './SettingsSection.tsx'
import { en, LOCALE_NAMESPACE, zh } from './locales.ts'
import type { BilibiliSettingsInjected } from './login-card.types.ts'
import { BILIBILI_CONFIG_ENTRY_ID, type BilibiliAutomationSettings } from '../settings.ts'

/** Services used by the card's localized plugin-manager slot. */
export const inject = ['locale', 'slots', 'configForms']

/**
 * Register the localized login card on this bundle's configuration page.
 * @param ctx - browser context carrying locale and slot services.
 */
export function apply(ctx: ClientContext): void {
  const settings = ctx.configForms.get<BilibiliAutomationSettings>(BILIBILI_CONFIG_ENTRY_ID)
  const settingsFace = (): BilibiliSettingsInjected => ({
    hooks: { settings },
    saveSettings: async (ownerUid, videoCommentEnabled) => {
      const before = settings.getSnapshot()
      if (before.status !== 'ready' || !before.writable) {
        throw new Error('Bilibili settings are not writable in this connection.')
      }
      const accepted = await settings.mutate([
        { op: 'set', path: ['ownerUid'], value: ownerUid },
        { op: 'set', path: ['videoCommentEnabled'], value: videoCommentEnabled },
      ], before.revision)
      if (!accepted) throw new Error('Bilibili settings were rejected by the Host.')
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

  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'bilibili',
    order: 30,
    label: () => t('settingsSectionLabel'),
    locale: LOCALE_NAMESPACE,
    inject: settingsFace,
  }, BilibiliSettingsSection))
}
