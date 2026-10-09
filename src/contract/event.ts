import { z } from "zod"
import { ACCESS_CHANGED_EVENT, EVENT_LIFETIME_SEC } from "./constants"

/** Claims of an access-changed Security Event Token (RFC 8417). Carries no data beyond "pull now". */
export type AccessChangedEventClaims = {
  iss: string
  aud: string
  jti: string
  iat: number
  exp: number
  events: { [ACCESS_CHANGED_EVENT]: { projection: string } }
}

/**
 * Builds the claims the IdP signs for each delivery attempt (header `typ: secevent+jwt`).
 * `jti` may repeat across retries; receivers never deduplicate on it.
 */
export function accessChangedEventClaims(input: {
  issuer: string
  audience: string
  jti: string
  projection: string
  /** Epoch seconds; defaults to now. */
  now?: number
}): AccessChangedEventClaims {
  const iat = input.now ?? Math.floor(Date.now() / 1000)
  return {
    iss: input.issuer,
    aud: input.audience,
    jti: input.jti,
    iat,
    exp: iat + EVENT_LIFETIME_SEC,
    events: { [ACCESS_CHANGED_EVENT]: { projection: input.projection } },
  }
}

/** Consumer schema for the verified claims; signature, issuer and audience are checked by `jose`. */
export const accessChangedEventSchema = z.object({
  jti: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
  events: z.object({
    [ACCESS_CHANGED_EVENT]: z.object({ projection: z.string().min(1) }),
  }),
})
