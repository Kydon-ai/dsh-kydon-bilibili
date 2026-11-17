/** Bilibili's first-level page inside DSH Settings. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BilibiliLoginCard } from './LoginCard.tsx'
import type { BilibiliSettingsInjected } from './login-card.types.ts'
import type { LOCALE_NAMESPACE } from './locales.ts'

/** Props supplied by the root Settings section slot and this plugin's settings face. */
export type BilibiliSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<typeof LOCALE_NAMESPACE>
  & InjectFace<BilibiliSettingsInjected>

/** Render the existing login and automation card as its own Settings section. */
export function BilibiliSettingsSection({ t, useSettings, saveSettings }: BilibiliSettingsSectionProps) {
  return <BilibiliLoginCard view="page" t={t} useSettings={useSettings} saveSettings={saveSettings} />
}
