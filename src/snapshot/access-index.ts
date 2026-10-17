import type { AccessSnapshotBody } from "../contract/snapshot"
import { AuthKitError } from "../errors"

export type AccessSubject = Readonly<{
  sub: string
  telegramId: string | null
  /** Effective role key → expiry in epoch milliseconds; `null` never expires. */
  roles: ReadonlyMap<string, number | null>
  /** Permission key → expiry in epoch milliseconds; `null` never expires. */
  permissions: ReadonlyMap<string, number | null>
}>

export type AccessCatalogEntry = Readonly<{ key: string; name: string }>

/** Names to show in a picker; empty lists when the IdP does not send them. */
export type AccessCatalog = Readonly<{
  roles: readonly AccessCatalogEntry[]
  permissions: readonly AccessCatalogEntry[]
}>

type Expiries = Record<string, { validUntil: string | null }>

function epochs(entries: Expiries = {}): Map<string, number | null> {
  return new Map(
    Object.entries(entries).map(([key, { validUntil }]) => [key, validUntil === null ? null : Date.parse(validUntil)])
  )
}

function entries(list: readonly AccessCatalogEntry[] = []): readonly AccessCatalogEntry[] {
  return Object.freeze(list.map(({ key, name }) => Object.freeze({ key, name })))
}

/** A key is dropped once `now ≥ validUntil`, whatever the sync state (RFC §5.3). */
function holds(expiries: ReadonlyMap<string, number | null> | undefined, key: string, now: number): boolean {
  const validUntil = expiries?.get(key)
  if (validUntil === undefined) return false
  return validUntil === null || now < validUntil
}

function valid(expiries: ReadonlyMap<string, number | null> | undefined, now: number): string[] {
  if (!expiries) return []
  return [...expiries.keys()].filter((key) => holds(expiries, key, now)).sort()
}

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
  readonly #catalog: AccessCatalog
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
    this.#catalog = Object.freeze({
      roles: entries(body.catalog?.roles),
      permissions: entries(body.catalog?.permissions),
    })
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
        roles: epochs(raw.roles),
        permissions: epochs(raw.permissions),
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
    return holds(subject?.permissions, permission, now)
  }

  /** The subject's permissions that are still valid at `now`, sorted. */
  permissions(subject: AccessSubject | undefined, now = Date.now()): string[] {
    return valid(subject?.permissions, now)
  }

  /** Whether the subject holds the role, directly or by inheritance, at `now`. Same expiry rule as `has`. */
  hasRole(subject: AccessSubject | undefined, role: string, now = Date.now()): boolean {
    return holds(subject?.roles, role, now)
  }

  /** The subject's effective roles that are still valid at `now`, sorted. */
  roles(subject: AccessSubject | undefined, now = Date.now()): string[] {
    return valid(subject?.roles, now)
  }

  /** Every role, and every permission the projection can carry, with display names. */
  catalog(): AccessCatalog {
    return this.#catalog
  }
}
