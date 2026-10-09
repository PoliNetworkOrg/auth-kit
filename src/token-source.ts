import type { JWK } from "jose"
import { notImplemented } from "./errors"

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
  fetch?: typeof fetch
  now?: () => number
}

/** Client credentials with `private_key_jwt` (RFC 7523), cached and renewed early (RFC §14.1). */
export function serviceTokenSource(_options: ServiceTokenSourceOptions): TokenSource {
  return notImplemented("serviceTokenSource")
}
