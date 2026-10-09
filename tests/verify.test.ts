import type { JWTPayload } from "jose"
import { describe, expect, it } from "vitest"
import { createKeyStore, parseAccessSnapshot, resolveActor, type VerifiedToken, verifyAccessToken } from "../src"
import { fixture } from "./fixtures"
import {
  BACKEND,
  fakeFetch,
  ISSUER,
  JWKS_URL,
  nowSec,
  serviceClaims,
  sign,
  signingKey,
  userClaims,
  without,
} from "./idp"

const key = await signingKey("k1")
const store = createKeyStore({
  jwksUrl: JWKS_URL,
  fetch: fakeFetch(() => Response.json({ keys: [key.publicJwk] })).fetch,
})
await store.start()
store.stop()

const options = { issuer: ISSUER, audience: BACKEND, keyStore: store }
const verify = async (claims: JWTPayload, header?: Parameters<typeof sign>[2]) =>
  verifyAccessToken(await sign(key, claims, header), options)

describe("verifyAccessToken", () => {
  it("accepts a service token and a user token whose aud is an array", async () => {
    const service = await verify(serviceClaims())
    expect(service).toMatchObject({ kind: "service", clientId: "telegram-bot", sub: "telegram-bot" })
    expect([...service.scopes]).toEqual(["backend:tg:read", "backend:tg:act-as"])
    expect(await verify(userClaims())).toMatchObject({
      kind: "user",
      clientId: "admin-dashboard",
      sub: "usr_moderator",
    })
  })

  it.each([
    ["another issuer", serviceClaims({ iss: "https://evil.example/api/auth" }), undefined],
    ["another audience", serviceClaims({ aud: "https://auth.example.org/api/internal" }), undefined],
    ["an expired token", serviceClaims({ iat: nowSec() - 7200, exp: nowSec() - 3600 }), undefined],
    ["a token older than 2 h", serviceClaims({ iat: nowSec() - 3 * 3600, exp: nowSec() + 60 }), undefined],
    ["a missing jti", without(serviceClaims(), "jti"), undefined],
    ["a missing subject type", without(serviceClaims(), "pn_subject_type"), undefined],
    ["a client token whose sub is not the client", serviceClaims({ sub: "usr_x" }), undefined],
    ["a user token whose sub is the client", userClaims({ sub: "admin-dashboard" }), undefined],
    ["an unknown subject type", serviceClaims({ pn_subject_type: "robot" }), undefined],
    ["an ID token", userClaims(), { typ: "JWT" }],
    ["a security event token", serviceClaims(), { typ: "secevent+jwt" }],
  ])("rejects %s", async (_name, claims, header) => {
    await expect(verify(claims, header)).rejects.toMatchObject({ code: "token_invalid" })
  })

  it("rejects algorithms other than EdDSA", async () => {
    const es256 = await signingKey("k1", "ES256")
    await expect(verifyAccessToken(await sign(es256, serviceClaims()), options)).rejects.toMatchObject({
      code: "token_invalid",
    })
  })

  it("reports missing keys as keys_unavailable rather than an invalid token", async () => {
    const offline = createKeyStore({
      jwksUrl: JWKS_URL,
      fetch: fakeFetch(() => new Response(null, { status: 503 })).fetch,
      onError: () => {},
    })
    await expect(
      verifyAccessToken(await sign(key, serviceClaims()), { ...options, keyStore: offline })
    ).rejects.toMatchObject({ code: "keys_unavailable" })
  })
})

describe("resolveActor", () => {
  const snapshot = parseAccessSnapshot(fixture("snapshot-v1.json"), "backend")
  const token = (kind: "service" | "user", scopes: string[], sub = "telegram-bot"): VerifiedToken => ({
    kind,
    clientId: kind === "service" ? sub : "admin-dashboard",
    sub,
    scopes: new Set(scopes),
    claims: {},
  })
  const actAsScope = "backend:tg:act-as"

  it("returns the service itself without an actor header", () => {
    expect(resolveActor(token("service", []), { actAsScope, snapshot })).toEqual({
      kind: "service",
      client: "telegram-bot",
    })
  })

  it("fills in a user's Telegram ID from the snapshot", () => {
    expect(resolveActor(token("user", [], "usr_moderator"), { actAsScope, snapshot })).toEqual({
      kind: "user",
      client: "admin-dashboard",
      sub: "usr_moderator",
      telegramId: "123456789",
    })
    expect(resolveActor(token("user", [], "usr_moderator"), { actAsScope, snapshot: null })).toMatchObject({
      telegramId: null,
    })
  })

  it("lets a service with the act-as scope assert a Telegram actor", () => {
    const service = token("service", [actAsScope])
    expect(resolveActor(service, { actAsScope, snapshot, actorHeader: "telegram:123456789" })).toEqual({
      kind: "telegram",
      client: "telegram-bot",
      telegramId: "123456789",
      sub: "usr_moderator",
    })
    expect(resolveActor(service, { actAsScope, snapshot, actorHeader: "telegram:42" })).toMatchObject({ sub: null })
  })

  it.each([
    ["a service without the act-as scope", token("service", ["backend:tg:read"]), "telegram:1"],
    ["a user token", token("user", [actAsScope], "usr_moderator"), "telegram:1"],
    ["a malformed header", token("service", [actAsScope]), "telegram:abc"],
    ["an empty header", token("service", [actAsScope]), ""],
  ])("forbids an actor header from %s", (_name, verified, actorHeader) => {
    expect(() => resolveActor(verified, { actAsScope, snapshot, actorHeader })).toThrowError(
      expect.objectContaining({ code: "actor_forbidden" })
    )
  })
})
