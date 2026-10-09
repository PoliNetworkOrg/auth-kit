import { base64url, createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from "jose"
import { z } from "zod"
import { AuthKitError } from "./errors"
import type { Persistence } from "./persistence"

export const DEFAULT_KEYS_REFRESH_INTERVAL_MS = 600_000
export const DEFAULT_KEYS_MAX_AGE_MS = 86_400_000
export const DEFAULT_UNKNOWN_KID_MIN_INTERVAL_MS = 30_000
/** Even a token newer than the last fetch cannot trigger fetches closer together than this. */
const NEW_KEY_MIN_INTERVAL_MS = 1_000

export interface KeyStoreOptions {
  jwksUrl: string
  /** Stores the last good key set so a restart during an IdP outage can still verify. */
  persistence?: Persistence
  refreshIntervalMs?: number
  /** Past this age without a successful fetch, verification fails closed. Default 24 h. */
  maxAgeMs?: number
  /**
   * Minimum gap between refetches for an unknown `kid`, unless the token was issued after the
   * last fetch: the IdP signs with a new key as soon as it creates it (docs/contract.md).
   */
  unknownKidMinIntervalMs?: number
  /** Abandons a JWKS request after this long. Default 10 s. */
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
  onError?: (error: unknown) => void
}

export interface KeyStoreStatus {
  /** Epoch ms of the last successful fetch, or null before the first one. */
  fetchedAt: number | null
  kids: string[]
}

export interface KeyStore {
  /** Loads persisted keys, fetches once, then refreshes in the background. */
  start(): Promise<void>
  stop(): void
  /** For `jose`'s `jwtVerify`. An unknown `kid` always fails closed after at most one refetch. */
  getKey: JWTVerifyGetKey
  status(): KeyStoreStatus
}

const jwksSchema = z.object({ keys: z.array(z.looseObject({ kty: z.string() })) })
const persistedSchema = z.object({ fetchedAt: z.number(), jwks: jwksSchema })

type KeySet = {
  /** When the fetch that produced these keys completed; drives `maxAgeMs`. */
  fetchedAt: number
  /** When it started: a key created after this may be missing. */
  startedAt: number
  jwks: JSONWebKeySet
  resolve: ReturnType<typeof createLocalJWKSet>
}

/** JWKS cache that keeps serving its last good key set during an IdP outage (RFC §6.5). */
export function createKeyStore(options: KeyStoreOptions): KeyStore {
  const refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_KEYS_REFRESH_INTERVAL_MS
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_KEYS_MAX_AGE_MS
  const unknownKidMinIntervalMs = options.unknownKidMinIntervalMs ?? DEFAULT_UNKNOWN_KID_MIN_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? 10_000
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const persistenceKey = `jwks:${options.jwksUrl}`

  let current: KeySet | null = null
  let lastAttemptAt: number | null = null
  let inflight: Promise<void> | null = null
  let timer: ReturnType<typeof setInterval> | null = null

  function install(jwks: JSONWebKeySet, fetchedAt: number, startedAt: number) {
    current = { fetchedAt, startedAt, jwks, resolve: createLocalJWKSet(jwks) }
  }

  async function fetchKeys(): Promise<void> {
    const startedAt = now()
    lastAttemptAt = startedAt
    let jwks: JSONWebKeySet
    try {
      const response = await doFetch(options.jwksUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`JWKS endpoint answered ${response.status}`)
      }
      jwks = jwksSchema.parse(await response.json()) as JSONWebKeySet
    } catch (error) {
      throw new AuthKitError("keys_unavailable", "Could not fetch the IdP's signing keys", { cause: error })
    }
    const fetchedAt = now()
    install(jwks, fetchedAt, startedAt)
    try {
      await options.persistence?.save(persistenceKey, JSON.stringify({ fetchedAt, jwks }))
    } catch (error) {
      options.onError?.(error)
    }
  }

  /** One fetch at a time; concurrent callers share it. */
  function refresh(): Promise<void> {
    inflight ??= fetchKeys().finally(() => {
      inflight = null
    })
    return inflight
  }

  /** Refetches unless one ran less than `minIntervalMs` ago; resolves either way. */
  async function refreshAtMostEvery(minIntervalMs: number) {
    if (inflight) return inflight.catch(() => {})
    if (lastAttemptAt !== null && now() - lastAttemptAt < minIntervalMs) return
    await refresh().catch((error) => options.onError?.(error))
  }

  function fresh(keys: KeySet | null): keys is KeySet {
    return keys !== null && now() - keys.fetchedAt <= maxAgeMs
  }

  function issuedAt(token: { payload?: unknown }): number | null {
    try {
      if (typeof token.payload !== "string") return null
      const { iat } = JSON.parse(new TextDecoder().decode(base64url.decode(token.payload))) as { iat?: unknown }
      return typeof iat === "number" ? iat * 1000 : null
    } catch {
      return null
    }
  }

  const getKey: JWTVerifyGetKey = async (header, token) => {
    if (!fresh(current)) await refreshAtMostEvery(unknownKidMinIntervalMs)
    if (!fresh(current)) throw new AuthKitError("keys_unavailable", "No signing keys fetched recently enough")
    try {
      return await current.resolve(header, token)
    } catch (error) {
      if (!(error instanceof errors.JWKSNoMatchingKey)) throw error
      // A token issued since the last fetch started may be signed with a key created since then.
      // `iat` has one-second resolution, so compare against the start of that second.
      const iat = issuedAt(token)
      const lastFetchSecond = Math.floor(current.startedAt / 1000) * 1000
      const minInterval = iat !== null && iat >= lastFetchSecond ? NEW_KEY_MIN_INTERVAL_MS : unknownKidMinIntervalMs
      await refreshAtMostEvery(minInterval)
      if (!fresh(current)) throw new AuthKitError("keys_unavailable", "No signing keys fetched recently enough")
      return current.resolve(header, token)
    }
  }

  return {
    async start() {
      try {
        const stored = await options.persistence?.load(persistenceKey)
        if (stored) {
          const parsed = persistedSchema.parse(JSON.parse(stored))
          // A timestamp from the future would keep old keys valid indefinitely.
          if (parsed.fetchedAt > now()) throw new Error("Persisted key set is dated in the future")
          install(parsed.jwks as JSONWebKeySet, parsed.fetchedAt, parsed.fetchedAt)
        }
      } catch (error) {
        options.onError?.(error)
      }
      await refresh().catch((error) => options.onError?.(error))
      if (!timer) {
        timer = setInterval(() => {
          refresh().catch((error) => options.onError?.(error))
        }, refreshIntervalMs)
        timer.unref?.()
      }
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    getKey,
    status() {
      return {
        fetchedAt: current?.fetchedAt ?? null,
        kids: (current?.jwks.keys ?? []).map((key) => key.kid).filter((kid): kid is string => !!kid),
      }
    },
  }
}
