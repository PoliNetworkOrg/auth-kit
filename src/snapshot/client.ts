import { z } from "zod"
import type { Actor } from "../actor"
import { AuthKitError } from "../errors"
import type { Persistence } from "../persistence"
import type { TokenSource } from "../token-source"
import type { AccessIndex, AccessSubject } from "./access-index"
import { parseAccessSnapshot } from "./parse"

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
  /** Abandons a pull, including reading its body, after this long. Default 10 s. */
  timeoutMs?: number
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

const persistedSchema = z.object({ body: z.string(), etag: z.string().nullable(), lastSyncAt: z.number() })

/**
 * Keeps a local, always-current copy of a projection (RFC §5): polling with ETag, single-flight
 * refresh, validation before an atomic swap, persistence and the `MAX_STALE` rule.
 */
export function accessSnapshot(options: AccessSnapshotOptions): AccessSnapshotClient {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS
  const timeoutMs = options.timeoutMs ?? 10_000
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const persistenceKey = `snapshot:${options.projection}`

  // Replaced together, so readers never see an index with another snapshot's ETag or body.
  let state: { index: AccessIndex; body: string; etag: string | null } | null = null
  let lastSyncAt: number | null = null
  let running: Promise<void> | null = null
  let queued: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  async function persist() {
    if (!options.persistence || !state || lastSyncAt === null) return
    try {
      await options.persistence.save(persistenceKey, JSON.stringify({ body: state.body, etag: state.etag, lastSyncAt }))
    } catch (error) {
      options.onError?.(error)
    }
  }

  async function request(token: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" }
    // Only an ETag the IdP returned: `If-None-Match: *` would always answer 304.
    if (state?.etag) headers["If-None-Match"] = state.etag
    try {
      return await doFetch(options.url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      throw new AuthKitError("snapshot_unavailable", "Snapshot endpoint unreachable", { cause: error })
    }
  }

  async function pull(): Promise<void> {
    let response = await request(await options.tokens.getToken())
    if (response.status === 401) {
      await response.body?.cancel()
      options.tokens.invalidate()
      response = await request(await options.tokens.getToken())
    }
    if (response.status === 304) {
      if (!state?.etag) {
        throw new AuthKitError("snapshot_unavailable", "Snapshot endpoint answered 304 without a snapshot and ETag")
      }
      lastSyncAt = now()
      await persist()
      return
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new AuthKitError("snapshot_unavailable", `Snapshot endpoint answered ${response.status}`)
    }
    let body: string
    try {
      body = await response.text()
    } catch (error) {
      throw new AuthKitError("snapshot_unavailable", "Snapshot body could not be read", { cause: error })
    }
    // Throws snapshot_invalid; the previous snapshot stays in place.
    const index = parseAccessSnapshot(body, options.projection)
    state = { index, body, etag: response.headers.get("etag") }
    lastSyncAt = now()
    await persist()
  }

  function refresh(): Promise<void> {
    if (!running) {
      running = pull().finally(() => {
        running = null
      })
      return running
    }
    // A trigger during a pull may announce a change the running pull has not seen.
    queued ??= running
      .catch(() => {})
      .then(() => {
        queued = null
        return refresh()
      })
    return queued
  }

  function fresh() {
    return lastSyncAt !== null && now() - lastSyncAt <= maxStaleMs
  }

  function decisionIndex(): AccessIndex | null {
    return state && fresh() ? state.index : null
  }

  return {
    async start() {
      try {
        const stored = await options.persistence?.load(persistenceKey)
        if (stored) {
          const parsed = persistedSchema.parse(JSON.parse(stored))
          // A timestamp from the future would keep an old snapshot fresh indefinitely.
          if (parsed.lastSyncAt > now()) throw new Error("Persisted snapshot is dated in the future")
          state = { index: parseAccessSnapshot(parsed.body, options.projection), body: parsed.body, etag: parsed.etag }
          lastSyncAt = parsed.lastSyncAt
        }
      } catch (error) {
        options.onError?.(error)
      }
      await refresh().catch((error) => options.onError?.(error))
      if (!timer) {
        timer = setInterval(() => {
          refresh().catch((error) => options.onError?.(error))
        }, pollIntervalMs)
        timer.unref?.()
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    refresh,
    current: () => state?.index ?? null,
    subjectBySub: (sub) => decisionIndex()?.bySub(sub),
    subjectByTelegramId: (telegramId) => decisionIndex()?.byTelegramId(telegramId),
    has(actor, permission) {
      if (actor.kind === "service" || actor.sub === null) return false
      const index = decisionIndex()
      return index ? index.has(index.bySub(actor.sub), permission, now()) : false
    },
    status() {
      return {
        lastSyncAt,
        fresh: fresh(),
        generation: state?.index.generation ?? null,
        subjects: state?.index.size ?? 0,
      }
    },
  }
}
