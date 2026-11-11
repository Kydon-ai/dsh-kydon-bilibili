/** Maximum Bilibili reply length measured in JavaScript UTF-16 code units. */
export const BILIBILI_REPLY_MAX_CHARACTERS = 1_000

/** Target length for model rewrites, leaving room below Bilibili's reply limit. */
export const BILIBILI_REPLY_REWRITE_TARGET_CHARACTERS = 900

/**
 * Count the UTF-16 code units used by the reply length guard.
 * @param text - final reply text.
 * @returns the number of UTF-16 code units.
 */
export function countReplyCharacters(text: string): number {
  return text.length
}

/**
 * Reject reply text that exceeds the configured Bilibili comment limit.
 * @param text - final reply text.
 * @returns nothing.
 * @throws when the reply exceeds the Bilibili comment limit.
 */
export function assertReplyLength(text: string): void {
  const length = countReplyCharacters(text)
  if (length > BILIBILI_REPLY_MAX_CHARACTERS) {
    throw new Error(`Bilibili reply is ${String(length)} characters; the limit is ${String(BILIBILI_REPLY_MAX_CHARACTERS)}.`)
  }
}
