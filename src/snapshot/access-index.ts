import type { AccessSnapshotBody } from "../contract/snapshot"
import { AuthKitError } from "../errors"

export type AccessSubject = Readonly<{
  sub: string
  telegramId: string | null
  /** Permission key → expiry in epoch milliseconds; `null` never expires. */
  permissions: ReadonlyMap<string, number | null>
}>

/**
 * One validated snapshot, indexed by `sub` and Telegram ID. Immutable, so a client swaps it in
 * with a single assignment and readers never see a half-applied snapshot.
 *
 * A subject that is absent holds no permissions: the IdP omits everyone without a projected
 * permission, including people who linked Telegram.
 */
export class AccessIndex {
  readonly projection: string
  readonly generation: number
  readonly builtAt: string
  readonly sources: AccessSnapshotBody["sources"]
  readonly #bySub: ReadonlyMap<string, AccessSubject>
  readonly #byTelegramId: ReadonlyMap<string, AccessSubject>

  private constructor(
    body: AccessSnapshotBody,
    bySub: Map<string, AccessSubject>,
    byTelegramId: Map<string, AccessSubject>
  ) {
    this.projection = body.projection
    this.generation = body.generation
    this.builtAt = body.builtAt
    this.sources = body.sources
    this.#bySub = bySub
    this.#byTelegramId = byTelegramId
  }

  /** Throws `snapshot_invalid` on a duplicate `sub` or Telegram ID. */
  static from(body: AccessSnapshotBody): AccessIndex {
    const bySub = new Map<string, AccessSubject>()
    const byTelegramId = new Map<string, AccessSubject>()
    for (const raw of body.subjects) {
      const subject: AccessSubject = Object.freeze({
        sub: raw.sub,
        telegramId: raw.telegramId,
        permissions: new Map(
          Object.entries(raw.permissions).map(([key, { validUntil }]) => [
            key,
            validUntil === null ? null : Date.parse(validUntil),
          ])
        ),
      })
      if (bySub.has(subject.sub)) throw new AuthKitError("snapshot_invalid", `Duplicate sub ${subject.sub}`)
      bySub.set(subject.sub, subject)
      if (subject.telegramId === null) continue
      if (byTelegramId.has(subject.telegramId))
        throw new AuthKitError("snapshot_invalid", `Duplicate Telegram ID ${subject.telegramId}`)
      byTelegramId.set(subject.telegramId, subject)
    }
    return new AccessIndex(body, bySub, byTelegramId)
  }

  get size(): number {
    return this.#bySub.size
  }

  bySub(sub: string): AccessSubject | undefined {
    return this.#bySub.get(sub)
  }

  byTelegramId(telegramId: string | number): AccessSubject | undefined {
    return this.#byTelegramId.get(String(telegramId))
  }

  /**
   * Whether the subject holds the permission at `now`. A permission is dropped once
   * `now ≥ validUntil`, whatever the sync state (RFC §5.3). Staleness is the client's concern.
   */
  has(subject: AccessSubject | undefined, permission: string, now = Date.now()): boolean {
    const validUntil = subject?.permissions.get(permission)
    if (validUntil === undefined) return false
    return validUntil === null || now < validUntil
  }

  /** The subject's permissions that are still valid at `now`, sorted. */
  permissions(subject: AccessSubject | undefined, now = Date.now()): string[] {
    if (!subject) return []
    return [...subject.permissions.keys()].filter((key) => this.has(subject, key, now)).sort()
  }
}
