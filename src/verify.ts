import { type JWTPayload, jwtVerify } from "jose"
import { type Actor, parseTelegramActor } from "./actor"
import { SIGNING_ALGORITHMS, SUBJECT_TYPE_CLAIM, TOKEN_TYPES } from "./contract/constants"
import { AuthKitError } from "./errors"
import type { KeyStore } from "./key-store"
import type { AccessIndex } from "./snapshot/access-index"

export interface VerifyAccessTokenOptions {
  issuer: string
  /** This resource server's identifier; matched as membership, since `aud` may be an array. */
  audience: string
  keyStore: Pick<KeyStore, "getKey">
  clockToleranceSec?: number
  maxTokenAge?: string | number
}

/** A verified bearer token, before any `X-PN-Actor` assertion is applied. */
export type VerifiedToken = {
  kind: "service" | "user"
  clientId: string
  sub: string
  scopes: ReadonlySet<string>
  claims: JWTPayload
}

export const DEFAULT_CLOCK_TOLERANCE_SEC = 30
export const DEFAULT_MAX_TOKEN_AGE = "2h"
const REQUIRED_CLAIMS = ["exp", "iat", "sub", "client_id", "scope", "jti", SUBJECT_TYPE_CLAIM]

/**
 * The RFC §6.4 checks: issuer, audience, `typ: at+jwt`, EdDSA only, required claims, clock
 * tolerance, and `pn_subject_type` consistent with `sub` and `client_id`.
 * Throws `token_invalid`, or `keys_unavailable` when no usable key set is available.
 */
export async function verifyAccessToken(token: string, options: VerifyAccessTokenOptions): Promise<VerifiedToken> {
  let claims: JWTPayload
  try {
    ;({ payload: claims } = await jwtVerify(token, options.keyStore.getKey, {
      issuer: options.issuer,
      audience: options.audience,
      typ: TOKEN_TYPES.access,
      algorithms: [...SIGNING_ALGORITHMS],
      requiredClaims: REQUIRED_CLAIMS,
      clockTolerance: options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC,
      maxTokenAge: options.maxTokenAge ?? DEFAULT_MAX_TOKEN_AGE,
    }))
  } catch (error) {
    if (error instanceof AuthKitError) throw error
    throw new AuthKitError("token_invalid", "Access token failed verification", { cause: error })
  }

  const { sub, client_id: clientId, scope } = claims
  const subjectType = claims[SUBJECT_TYPE_CLAIM]
  if (typeof sub !== "string" || typeof clientId !== "string" || typeof scope !== "string" || !sub || !clientId)
    throw new AuthKitError("token_invalid", "Access token has malformed claims")
  let kind: VerifiedToken["kind"]
  if (subjectType === "client" && sub === clientId) kind = "service"
  else if (subjectType === "user" && sub !== clientId) kind = "user"
  else throw new AuthKitError("token_invalid", "Access token subject type does not match its subject")

  return { kind, clientId, sub, scopes: new Set(scope.split(" ").filter(Boolean)), claims }
}

export interface ResolveActorOptions {
  /** The raw `X-PN-Actor` header, if present. */
  actorHeader?: string | null | undefined
  /** Scope that allows asserting a Telegram actor, e.g. `backend:tg:act-as`. */
  actAsScope: string
  /** Current snapshot, to fill in `sub` / `telegramId`; null before the first sync. */
  snapshot: AccessIndex | null
}

/**
 * Turns a verified token into the request's actor. Only a service token holding `actAsScope`
 * may assert a Telegram actor; anything else with the header throws `actor_forbidden`.
 */
export function resolveActor(token: VerifiedToken, options: ResolveActorOptions): Actor {
  const { actorHeader, snapshot } = options
  if (actorHeader === undefined || actorHeader === null) {
    if (token.kind === "service") return { kind: "service", client: token.clientId }
    return {
      kind: "user",
      client: token.clientId,
      sub: token.sub,
      telegramId: snapshot?.bySub(token.sub)?.telegramId ?? null,
    }
  }
  if (token.kind !== "service" || !token.scopes.has(options.actAsScope))
    throw new AuthKitError("actor_forbidden", "This token may not assert an actor")
  const telegramId = parseTelegramActor(actorHeader)
  if (!telegramId) throw new AuthKitError("actor_forbidden", "Malformed actor header")
  return {
    kind: "telegram",
    client: token.clientId,
    telegramId,
    sub: snapshot?.byTelegramId(telegramId)?.sub ?? null,
  }
}
