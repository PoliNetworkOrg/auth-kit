/** Who a backend request acts for (RFC §6.1). Every request resolves to exactly one actor. */
export type Actor =
  | { kind: "service"; client: string }
  | { kind: "telegram"; client: string; telegramId: string; sub: string | null }
  | { kind: "user"; client: string; sub: string; telegramId: string | null }

/** Set by a client holding the act-as scope to act for a Telegram user (RFC §6.3). */
export const ACTOR_HEADER = "X-PN-Actor"

const TELEGRAM_ID = /^[1-9]\d{0,19}$/
const TELEGRAM_ACTOR = /^telegram:([1-9]\d{0,19})$/

/** Value for {@link ACTOR_HEADER}. Throws on anything but a positive integer ID. */
export function formatTelegramActor(telegramId: number | string): string {
  const id = String(telegramId)
  if (!TELEGRAM_ID.test(id)) throw new TypeError(`Invalid Telegram user ID: ${id}`)
  return `telegram:${id}`
}

/** The Telegram ID in a {@link ACTOR_HEADER} value, or null if it is malformed. */
export function parseTelegramActor(value: string): string | null {
  return TELEGRAM_ACTOR.exec(value)?.[1] ?? null
}
