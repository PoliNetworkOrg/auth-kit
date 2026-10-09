import { type JWTPayload, jwtVerify } from "jose"
import { ACCESS_CHANGED_EVENT, EVENT_CONTENT_TYPE, SIGNING_ALGORITHMS, TOKEN_TYPES } from "../contract/constants"
import { accessChangedEventSchema } from "../contract/event"
import { AuthKitError } from "../errors"
import type { KeyStore } from "../key-store"
import type { AccessSnapshotClient } from "./client"

/** Stays below the IdP's 8 s delivery timeout (`IDP_EVENT_TIMEOUT_MS`). */
export const DEFAULT_EVENT_PULL_TIMEOUT_MS = 6_000
/** An event is a signed "pull now" of a few hundred bytes. */
const MAX_EVENT_BYTES = 16_384

export interface AccessEventHandlerOptions {
  keyStore: Pick<KeyStore, "getKey">
  issuer: string
  /** This service's resource identifier; the event's `aud`. */
  audience: string
  projection: string
  snapshot: Pick<AccessSnapshotClient, "refresh">
  /** How long to wait for the triggered pull before answering `503`. */
  pullTimeoutMs?: number
  clockToleranceSec?: number
  /** Reports rejected events and failed pulls. */
  onError?: (error: unknown) => void
}

/** The body as text, or null once it exceeds `limit` bytes; stops reading at the limit. */
async function readAtMost(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? "0") > limit) return null
  if (!request.body) return ""
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

function reply(status: number, err?: string, description?: string): Response {
  if (!err) return new Response(null, { status })
  // RFC 8935 §2.3 error body.
  return Response.json({ err, description }, { status })
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
export function createAccessEventHandler(options: AccessEventHandlerOptions): (request: Request) => Promise<Response> {
  const pullTimeoutMs = options.pullTimeoutMs ?? DEFAULT_EVENT_PULL_TIMEOUT_MS

  return async (request) => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
    if (contentType !== EVENT_CONTENT_TYPE) return reply(415, "invalid_request", "Expected a security event token")
    const raw = await readAtMost(request, MAX_EVENT_BYTES)
    if (raw === null) return reply(413, "invalid_request", "Event too large")
    const body = raw.trim()
    if (body.length === 0) return reply(400, "invalid_request", "Invalid body")

    let claims: JWTPayload
    try {
      ;({ payload: claims } = await jwtVerify(body, options.keyStore.getKey, {
        issuer: options.issuer,
        audience: options.audience,
        typ: TOKEN_TYPES.event,
        algorithms: [...SIGNING_ALGORITHMS],
        requiredClaims: ["iat", "exp", "jti"],
        clockTolerance: options.clockToleranceSec ?? 30,
      }))
    } catch (error) {
      options.onError?.(error)
      // Without keys the event may be valid: let the IdP retry instead of dropping it.
      if (error instanceof AuthKitError && error.code === "keys_unavailable") return reply(503)
      return reply(401, "authentication_failed", "Invalid security event token")
    }
    const event = accessChangedEventSchema.safeParse(claims)
    if (!event.success || event.data.events[ACCESS_CHANGED_EVENT].projection !== options.projection)
      return reply(400, "invalid_request", "Unexpected event")

    let timeout: ReturnType<typeof setTimeout> | undefined
    const pulled = options.snapshot.refresh().then(
      () => true,
      (error) => {
        options.onError?.(error)
        return false
      }
    )
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), pullTimeoutMs)
    })
    try {
      return (await Promise.race([pulled, timedOut])) ? reply(202) : reply(503)
    } finally {
      clearTimeout(timeout)
    }
  }
}
