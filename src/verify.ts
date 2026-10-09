import type { JWTPayload } from "jose"
import type { Actor } from "./actor"
import { notImplemented } from "./errors"
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

/**
 * The RFC §6.4 checks: issuer, audience, `typ: at+jwt`, EdDSA only, required claims, clock
 * tolerance, and `pn_subject_type` consistent with `sub` and `client_id`.
 * Throws `token_invalid`.
 */
export async function verifyAccessToken(_token: string, _options: VerifyAccessTokenOptions): Promise<VerifiedToken> {
  return notImplemented("verifyAccessToken")
}

export interface ResolveActorOptions {
  /** The raw `X-PN-Actor` header, if present. */
  actorHeader?: string | null
  /** Scope that allows asserting a Telegram actor, e.g. `backend:tg:act-as`. */
  actAsScope: string
  /** Current snapshot, to fill in `sub` / `telegramId`; null before the first sync. */
  snapshot: AccessIndex | null
}

/**
 * Turns a verified token into the request's actor. Only a service token holding `actAsScope`
 * may assert a Telegram actor; anything else with the header throws `actor_forbidden`.
 */
export function resolveActor(_token: VerifiedToken, _options: ResolveActorOptions): Actor {
  return notImplemented("resolveActor")
}
