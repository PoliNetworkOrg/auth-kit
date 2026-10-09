import type { Actor } from "../actor"
import { notImplemented } from "../errors"
import type { Persistence } from "../persistence"
import type { TokenSource } from "../token-source"
import type { AccessIndex, AccessSubject } from "./access-index"

export const DEFAULT_POLL_INTERVAL_MS = 30_000
export const DEFAULT_MAX_STALE_MS = 3_600_000

export interface AccessSnapshotOptions {
  /** See `idpEndpoints(...).snapshotUrl`. */
  url: string
  /** Client credentials for the IdP's internal resource with `idp:access:read`. */
  tokens: TokenSource
  /** Projection this client expects, e.g. `backend`; any other projection is rejected. */
  projection: string
  persistence?: Persistence
  pollIntervalMs?: number
  /** Past this time since the last `200`/`304`, every permission check denies. Default 1 h. */
  maxStaleMs?: number
  fetch?: typeof fetch
  now?: () => number
  onError?: (error: unknown) => void
}

export interface SnapshotStatus {
  /** Epoch ms of the last `200` or `304`. The only input to staleness; `builtAt` is not. */
  lastSyncAt: number | null
  fresh: boolean
  generation: number | null
  subjects: number
}

export interface AccessSnapshotClient {
  /** Loads the persisted snapshot, pulls once, then polls. */
  start(): Promise<void>
  stop(): void
  /**
   * Pulls now. At most one pull runs at a time; a call during a pull schedules one more pull
   * after it and resolves when that pull settles.
   */
  refresh(): Promise<void>
  /** The current snapshot regardless of staleness, for lookups that are not decisions. */
  current(): AccessIndex | null
  /** Snapshot subject for a decision, or undefined when stale or unknown. */
  subjectBySub(sub: string): AccessSubject | undefined
  subjectByTelegramId(telegramId: string | number): AccessSubject | undefined
  /** False for service actors, actors without `sub`, unknown subjects and a stale snapshot. */
  has(actor: Actor, permission: string): boolean
  status(): SnapshotStatus
}

/**
 * Keeps a local, always-current copy of a projection (RFC §5): polling with ETag, single-flight
 * refresh, validation before an atomic swap, persistence and the `MAX_STALE` rule.
 */
export function accessSnapshot(_options: AccessSnapshotOptions): AccessSnapshotClient {
  return notImplemented("accessSnapshot")
}
