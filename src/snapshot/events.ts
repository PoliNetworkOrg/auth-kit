import { notImplemented } from "../errors"
import type { KeyStore } from "../key-store"
import type { AccessSnapshotClient } from "./client"

/** Stays below the IdP's 8 s delivery timeout (`IDP_EVENT_TIMEOUT_MS`). */
export const DEFAULT_EVENT_PULL_TIMEOUT_MS = 6_000

export interface AccessEventHandlerOptions {
  keyStore: Pick<KeyStore, "getKey">
  issuer: string
  /** This service's resource identifier; the event's `aud`. */
  audience: string
  projection: string
  snapshot: Pick<AccessSnapshotClient, "refresh">
  /** How long to wait for the triggered pull before answering `503`. */
  pullTimeoutMs?: number
}

/**
 * Receiver for the IdP's access-changed events (RFC §5.6), as a Fetch API handler that Hono,
 * Bun and Node frameworks can mount.
 *
 * Verifies the SET (`typ: secevent+jwt`, issuer, audience, event URI, projection), then pulls.
 * Answers `202` once the pull completes, `503` if it fails or exceeds `pullTimeoutMs` (the pull
 * keeps running), `401` for an invalid token. Never deduplicates by `jti`: the IdP reuses it on
 * retries that may cover newer changes.
 */
export function createAccessEventHandler(_options: AccessEventHandlerOptions): (request: Request) => Promise<Response> {
  return notImplemented("createAccessEventHandler")
}
