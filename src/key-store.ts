import type { JWTVerifyGetKey } from "jose"
import { notImplemented } from "./errors"
import type { Persistence } from "./persistence"

export const DEFAULT_KEYS_REFRESH_INTERVAL_MS = 600_000
export const DEFAULT_KEYS_MAX_AGE_MS = 86_400_000
export const DEFAULT_UNKNOWN_KID_MIN_INTERVAL_MS = 30_000

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

/** JWKS cache that keeps serving its last good key set during an IdP outage (RFC §6.5). */
export function createKeyStore(_options: KeyStoreOptions): KeyStore {
  return notImplemented("createKeyStore")
}
