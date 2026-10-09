import { createLocalJWKSet, jwtVerify } from "jose"
import { describe, expect, it } from "vitest"
import { AuthKitError, CLIENT_ASSERTION_TYPE, serviceTokenSource } from "../src"
import { BACKEND, clock, fakeFetch, ISSUER, signingKey } from "./idp"

const TOKEN_URL = "http://auth.internal/api/auth/oauth2/token"
const TOKEN_AUDIENCE = `${ISSUER}/oauth2/token`

async function setup(respond: (count: number) => Response, ratio?: number) {
  const key = await signingKey("bot-key")
  const time = clock()
  let count = 0
  const errors: unknown[] = []
  const { fetch, requests } = fakeFetch(() => respond(++count))
  const tokens = serviceTokenSource({
    clientId: "telegram-bot",
    privateKey: key.privateJwk,
    tokenUrl: TOKEN_URL,
    tokenAudience: TOKEN_AUDIENCE,
    resource: BACKEND,
    scopes: ["backend:tg:read", "backend:tg:ingest"],
    fetch,
    now: time.now,
    onError: (error) => errors.push(error),
    ...(ratio === undefined ? {} : { refreshRatio: ratio }),
  })
  return { key, time, tokens, requests, errors, count: () => count }
}

/** Waits for a background renewal to reach the given state. */
async function until(condition: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition not met")
}

const issued = (n: number) =>
  Response.json({ access_token: `token-${n}`, token_type: "Bearer", expires_in: 3600, scope: "backend:tg:read" })

describe("serviceTokenSource", () => {
  it("requests client credentials with a private_key_jwt assertion and one resource", async () => {
    const { key, tokens, requests } = await setup(issued)
    expect(await tokens.getToken()).toBe("token-1")
    const request = requests[0]
    expect(request?.url).toBe(TOKEN_URL)
    expect(request?.method).toBe("POST")
    const form = new URLSearchParams(await request?.text())
    expect(form.get("grant_type")).toBe("client_credentials")
    expect(form.get("client_id")).toBe("telegram-bot")
    expect(form.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE)
    expect(form.getAll("resource")).toEqual([BACKEND])
    expect(form.get("scope")).toBe("backend:tg:read backend:tg:ingest")
    const { payload, protectedHeader } = await jwtVerify(
      form.get("client_assertion") ?? "",
      createLocalJWKSet({ keys: [key.publicJwk] }),
      { issuer: "telegram-bot", subject: "telegram-bot", audience: TOKEN_AUDIENCE }
    )
    expect(protectedHeader).toMatchObject({ alg: "EdDSA", kid: "bot-key" })
    expect(Number(payload.exp) - Number(payload.iat)).toBe(60)
    expect(payload.jti).toEqual(expect.any(String))
  })

  it("caches the token, shares one request between concurrent callers and renews at half the lifetime", async () => {
    const { tokens, time, count } = await setup(issued)
    expect(await Promise.all([tokens.getToken(), tokens.getToken(), tokens.getToken()])).toEqual([
      "token-1",
      "token-1",
      "token-1",
    ])
    expect(count()).toBe(1)
    time.advance(1_799_000)
    expect(await tokens.getToken()).toBe("token-1")
    expect(count()).toBe(1)
    time.advance(2_000)
    // Past the renewal point the valid token is returned at once and a new one is fetched.
    expect(await tokens.getToken()).toBe("token-1")
    await until(async () => (await tokens.getToken()) === "token-2")
    expect(count()).toBe(2)
  })

  it("keeps serving a cached token while renewal fails, then fails once it expires", async () => {
    const { tokens, time, errors, count } = await setup((n) =>
      n === 1
        ? issued(n)
        : Response.json({ error: "server_error", error_description: "secret detail" }, { status: 500 })
    )
    await tokens.getToken()
    time.advance(2_000_000)
    expect(await tokens.getToken()).toBe("token-1")
    await until(() => errors.length === 1)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).not.toContain("secret detail")
    // Inside the backoff window no new request is made.
    expect(await tokens.getToken()).toBe("token-1")
    expect(count()).toBe(2)
    time.advance(1_600_000)
    await expect(tokens.getToken()).rejects.toMatchObject({ code: "token_request_failed" })
  })

  it("does not retry a failed request inside the backoff window", async () => {
    const { tokens, time, count } = await setup(() => new Response(null, { status: 503 }))
    await expect(tokens.getToken()).rejects.toBeInstanceOf(AuthKitError)
    await expect(tokens.getToken()).rejects.toMatchObject({ code: "token_request_failed" })
    expect(count()).toBe(1)
    time.advance(5_000)
    await expect(tokens.getToken()).rejects.toMatchObject({ code: "token_request_failed" })
    expect(count()).toBe(2)
  })

  it("abandons a token request that hangs", async () => {
    const key = await signingKey("bot-key")
    const { fetch } = fakeFetch(
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason))
        })
    )
    const tokens = serviceTokenSource({
      clientId: "telegram-bot",
      privateKey: key.privateJwk,
      tokenUrl: TOKEN_URL,
      tokenAudience: TOKEN_AUDIENCE,
      resource: BACKEND,
      scopes: [],
      fetch,
      timeoutMs: 20,
    })
    await expect(tokens.getToken()).rejects.toMatchObject({ code: "token_request_failed" })
  })

  it("fetches a new token after invalidate()", async () => {
    const { tokens } = await setup(issued)
    await tokens.getToken()
    tokens.invalidate()
    expect(await tokens.getToken()).toBe("token-2")
  })

  it("rejects unusable responses and keys", async () => {
    const { tokens } = await setup(() => Response.json({ access_token: "x", token_type: "DPoP", expires_in: 60 }))
    await expect(tokens.getToken()).rejects.toMatchObject({ code: "token_request_failed" })
    const key = await signingKey("k")
    const base = {
      clientId: "c",
      tokenUrl: TOKEN_URL,
      tokenAudience: TOKEN_AUDIENCE,
      resource: BACKEND,
      scopes: [],
    }
    expect(() => serviceTokenSource({ ...base, privateKey: key.publicJwk })).toThrow(TypeError)
    expect(() => serviceTokenSource({ ...base, privateKey: { ...key.privateJwk, alg: "RS256" } })).toThrow(TypeError)
  })
})
