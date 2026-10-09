import { importJWK, type JWK, SignJWT } from "jose"
import { CLIENT_ASSERTION_TYPE } from "./contract/constants"
import { AuthKitError } from "./errors"

export interface TokenSource {
  /** A valid access token, from cache or freshly issued. Concurrent callers share one request. */
  getToken(): Promise<string>
  /** Drops the cached token, e.g. after the resource server answered `401`. */
  invalidate(): void
}

export interface ServiceTokenSourceOptions {
  clientId: string
  /** The client's private signing key, with `kid` and `alg` (`EdDSA` or `ES256`). */
  privateKey: JWK
  /** Where to send the request; may be an in-cluster address. See `idpEndpoints`. */
  tokenUrl: string
  /** `aud` of the client assertion; always the public token endpoint. See `idpEndpoints`. */
  tokenAudience: string
  /**
   * Exactly one resource. Without it the IdP issues an opaque token; with two, `aud` becomes an
   * array, which the snapshot endpoint rejects.
   */
  resource: string
  scopes: readonly string[]
  /** Fraction of the token lifetime after which it is renewed. Default 0.5. */
  refreshRatio?: number
  /** After a failed request, callers get the cached token or the error until this has passed. Default 5 s. */
  retryAfterFailureMs?: number
  /** Abandons a token request after this long. Default 10 s. */
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
  /** Reports a failed renewal while a cached token is still being served. */
  onError?: (error: unknown) => void
}

export const DEFAULT_REFRESH_RATIO = 0.5
export const DEFAULT_RETRY_AFTER_FAILURE_MS = 5_000
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** Client assertions are single-use and short-lived. */
const ASSERTION_LIFETIME_SEC = 60
/** A cached token is not handed out in its last seconds, so it cannot expire in flight. */
const EXPIRY_MARGIN_MS = 10_000
const SIGNING_ALGORITHMS = new Set(["EdDSA", "ES256"])

type CachedToken = { value: string; refreshAt: number; expiresAt: number }

/** Client credentials with `private_key_jwt` (RFC 7523), cached and renewed early (RFC §14.1). */
export function serviceTokenSource(options: ServiceTokenSourceOptions): TokenSource {
  const { clientId, privateKey } = options
  const alg = privateKey.alg
  if (!alg || !SIGNING_ALGORITHMS.has(alg)) throw new TypeError("privateKey.alg must be EdDSA or ES256")
  if (!privateKey.kid) throw new TypeError("privateKey.kid is required")
  if (!privateKey.d) throw new TypeError("privateKey must be a private key")
  const kid = privateKey.kid
  const refreshRatio = options.refreshRatio ?? DEFAULT_REFRESH_RATIO
  if (!(refreshRatio > 0 && refreshRatio <= 1)) throw new TypeError("refreshRatio must be in (0, 1]")
  const retryAfterFailureMs = options.retryAfterFailureMs ?? DEFAULT_RETRY_AFTER_FAILURE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const signingKey = importJWK(privateKey, alg)
  // Surfaced by the first request instead of as an unhandled rejection.
  signingKey.catch(() => {})

  let cached: CachedToken | null = null
  let inflight: Promise<string> | null = null
  let lastFailure: { at: number; error: unknown } | null = null

  async function assertion(issuedAt: number): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: alg as string, kid })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(options.tokenAudience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SEC)
      .setJti(crypto.randomUUID())
      .sign(await signingKey)
  }

  async function request(): Promise<string> {
    const startedAt = now()
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await assertion(Math.floor(startedAt / 1000)),
      resource: options.resource,
      scope: options.scopes.join(" "),
    })
    let response: Response
    try {
      response = await doFetch(options.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new AuthKitError("token_request_failed", "Token endpoint unreachable", { cause: error })
    }
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null
    if (!response.ok) {
      // Only the OAuth error code: the description may echo request details.
      const code = typeof json?.error === "string" ? json.error : "unknown_error"
      throw new AuthKitError("token_request_failed", `Token endpoint answered ${response.status} (${code})`)
    }
    const token = json?.access_token
    const expiresIn = json?.expires_in
    const tokenType = json?.token_type
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      typeof expiresIn !== "number" ||
      !(expiresIn > 0) ||
      (typeof tokenType === "string" && tokenType.toLowerCase() !== "bearer")
    )
      throw new AuthKitError("token_request_failed", "Token endpoint returned an unusable response")
    const lifetimeMs = expiresIn * 1000
    cached = { value: token, refreshAt: startedAt + lifetimeMs * refreshRatio, expiresAt: startedAt + lifetimeMs }
    lastFailure = null
    return token
  }

  function usable(token: CachedToken | null, at: number): token is CachedToken {
    return token !== null && at < token.expiresAt - EXPIRY_MARGIN_MS
  }

  /** One request at a time; a failure starts the backoff window. */
  function renew(): Promise<string> {
    inflight ??= request()
      .catch((error: unknown) => {
        lastFailure = { at: now(), error }
        throw error
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  function backingOff(at: number) {
    return lastFailure !== null && at - lastFailure.at < retryAfterFailureMs
  }

  return {
    async getToken() {
      const at = now()
      if (usable(cached, at)) {
        // Past the renewal point a still-valid token is handed out at once while a new one is fetched.
        if (at >= cached.refreshAt && !inflight && !backingOff(at)) renew().catch((error) => options.onError?.(error))
        return cached.value
      }
      if (backingOff(at)) throw lastFailure?.error
      return renew()
    },
    invalidate() {
      cached = null
      lastFailure = null
    },
  }
}
