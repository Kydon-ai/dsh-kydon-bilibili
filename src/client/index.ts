/** Bilibili login settings card, browser half. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { BilibiliLoginCard } from './LoginCard.tsx'
import { en, LOCALE_NAMESPACE, zh } from './locales.ts'

/** Services used by the card's localized plugin-manager slot. */
export const inject = ['locale', 'slots']

/**
 * Register the localized login card on this bundle's configuration page.
 * @param ctx - browser context carrying locale and slot services.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { en, zh }),
    'dsh-kydon-bilibili: browser dictionaries',
  )
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: '@kydon/dsh-kydon-bilibili',
    locale: LOCALE_NAMESPACE,
  }, BilibiliLoginCard))
}
