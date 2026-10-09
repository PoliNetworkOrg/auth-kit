/**
 * Values fixed in the IdP's code (`auth`, branch `migration-phase1`). Changing any of them
 * needs a coordinated IdP change; see docs/contract.md.
 */
export const SNAPSHOT_SCHEMA = "polinetwork.access-snapshot/v1"
export const SNAPSHOT_PATH = "/api/internal/access-snapshot"
export const ACCESS_CHANGED_EVENT = "https://schemas.polinetwork.org/events/access-changed"
export const ACCESS_READ_SCOPE = "idp:access:read"
export const SUBJECT_TYPE_CLAIM = "pn_subject_type"
export const SIGNING_ALGORITHMS = ["EdDSA"] as const
export const TOKEN_TYPES = { access: "at+jwt", event: "secevent+jwt" } as const
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
export const EVENT_CONTENT_TYPE = "application/secevent+jwt"
/** `exp − iat` of every access-changed event. */
export const EVENT_LIFETIME_SEC = 60
/** The IdP abandons an event delivery after this long and retries it later. */
export const IDP_EVENT_TIMEOUT_MS = 8_000

export type IdpEndpoints = {
  /** `iss` of every token and event the IdP signs. */
  issuer: string
  jwksUrl: string
  tokenUrl: string
  /** `aud` of `private_key_jwt` client assertions: always the public token endpoint. */
  tokenAudience: string
  snapshotUrl: string
}

/**
 * Derives the IdP's URLs. Identifiers (`issuer`, `tokenAudience`) always come from the public
 * URL; requests go to `internalUrl` when set, e.g. in-cluster Service DNS (RFC §12).
 */
export function idpEndpoints(options: { publicUrl: string; internalUrl?: string }): IdpEndpoints {
  const issuer = new URL("/api/auth", options.publicUrl).href
  const requestBase = new URL("/api/auth", options.internalUrl ?? options.publicUrl).href
  return {
    issuer,
    jwksUrl: `${requestBase}/jwks`,
    tokenUrl: `${requestBase}/oauth2/token`,
    tokenAudience: `${issuer}/oauth2/token`,
    snapshotUrl: new URL(SNAPSHOT_PATH, options.internalUrl ?? options.publicUrl).href,
  }
}
