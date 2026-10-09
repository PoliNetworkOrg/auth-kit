import { exportJWK, generateKeyPair, type JWK, type JWTPayload, SignJWT } from "jose"

export const ISSUER = "https://auth.example.org/api/auth"
export const BACKEND = "https://backend.internal.example.org"
export const JWKS_URL = `${ISSUER}/jwks`

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]

export type SigningKey = { kid: string; privateKey: PrivateKey; publicJwk: JWK; privateJwk: JWK }

export async function signingKey(kid: string, alg: "EdDSA" | "ES256" = "EdDSA"): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true })
  return {
    kid,
    privateKey,
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg, use: "sig" },
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg },
  }
}

export function sign(
  key: SigningKey,
  claims: JWTPayload,
  header: { typ?: string; alg?: string; kid?: string } = {}
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({
      alg: header.alg ?? key.publicJwk.alg ?? "EdDSA",
      kid: header.kid ?? key.kid,
      typ: header.typ ?? "at+jwt",
    })
    .sign(key.privateKey)
}

export const nowSec = () => Math.floor(Date.now() / 1000)

export function serviceClaims(overrides: JWTPayload = {}): JWTPayload {
  const iat = nowSec()
  return {
    iss: ISSUER,
    aud: BACKEND,
    sub: "telegram-bot",
    client_id: "telegram-bot",
    azp: "telegram-bot",
    scope: "backend:tg:read backend:tg:act-as",
    pn_subject_type: "client",
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 3600,
    ...overrides,
  }
}

/** Claims without the given keys, to test missing claims. */
export function without(claims: JWTPayload, ...keys: string[]): JWTPayload {
  return Object.fromEntries(Object.entries(claims).filter(([key]) => !keys.includes(key)))
}

export function userClaims(overrides: JWTPayload = {}): JWTPayload {
  return serviceClaims({
    sub: "usr_moderator",
    client_id: "admin-dashboard",
    azp: "admin-dashboard",
    aud: [BACKEND, `${ISSUER}/oauth2/userinfo`],
    scope: "openid profile email offline_access backend:admin",
    pn_subject_type: "user",
    ...overrides,
  })
}

type Handler = (request: Request) => Response | Promise<Response>

/** A `fetch` that records requests and answers from a handler. */
export function fakeFetch(handler: Handler) {
  const requests: Request[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request.clone())
    return handler(request)
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

export function jwksHandler(keys: () => SigningKey[]): Handler {
  return () => Response.json({ keys: keys().map((key) => key.publicJwk) })
}

/** A controllable clock. */
export function clock(start = Date.now()) {
  let at = start
  return {
    now: () => at,
    advance(ms: number) {
      at += ms
    },
  }
}
