import { describe, expect, it } from "vitest"
import { ACCESS_CHANGED_EVENT, accessChangedEventClaims, createAccessEventHandler, createKeyStore } from "../src"
import { BACKEND, fakeFetch, ISSUER, JWKS_URL, sign, signingKey } from "./idp"

const key = await signingKey("k1")
const store = createKeyStore({
  jwksUrl: JWKS_URL,
  fetch: fakeFetch(() => Response.json({ keys: [key.publicJwk] })).fetch,
})
await store.start()
store.stop()

function handler(refresh: () => Promise<void>, pullTimeoutMs = 200) {
  let pulls = 0
  const handle = createAccessEventHandler({
    keyStore: store,
    issuer: ISSUER,
    audience: BACKEND,
    projection: "backend",
    snapshot: {
      refresh: () => {
        pulls++
        return refresh()
      },
    },
    pullTimeoutMs,
    onError: () => {},
  })
  return { handle, pulls: () => pulls }
}

const event = (overrides: Record<string, unknown> = {}, typ = "secevent+jwt") =>
  sign(
    key,
    {
      ...accessChangedEventClaims({ issuer: ISSUER, audience: BACKEND, jti: "access-1", projection: "backend" }),
      ...overrides,
    },
    { typ }
  )

const post = (body: string, contentType = "application/secevent+jwt") =>
  new Request("http://backend/internal/events", { method: "POST", headers: { "Content-Type": contentType }, body })

describe("createAccessEventHandler", () => {
  it("pulls and answers 202 for a valid event, every time it arrives", async () => {
    const { handle, pulls } = handler(async () => {})
    const token = await event()
    expect((await handle(post(token))).status).toBe(202)
    expect((await handle(post(token))).status).toBe(202)
    expect(pulls()).toBe(2)
  })

  it.each([
    ["an access token", {}, "at+jwt"],
    ["another audience", { aud: "https://auth.example.org/api/internal" }, undefined],
    ["another issuer", { iss: "https://evil.example/api/auth" }, undefined],
    ["an expired event", { iat: 1, exp: 61 }, undefined],
  ])("rejects %s with 401 without pulling", async (_name, overrides, typ) => {
    const { handle, pulls } = handler(async () => {})
    expect((await handle(post(await event(overrides, typ)))).status).toBe(401)
    expect(pulls()).toBe(0)
  })

  it("rejects another projection and other event types", async () => {
    const { handle, pulls } = handler(async () => {})
    const other = await event({ events: { [ACCESS_CHANGED_EVENT]: { projection: "rooms" } } })
    expect((await handle(post(other))).status).toBe(400)
    const unknown = await event({ events: { "https://example.org/other": {} } })
    expect((await handle(post(unknown))).status).toBe(400)
    expect(pulls()).toBe(0)
  })

  it("rejects other methods and content types", async () => {
    const { handle } = handler(async () => {})
    expect((await handle(new Request("http://backend/internal/events"))).status).toBe(405)
    expect((await handle(post(await event(), "application/json"))).status).toBe(415)
  })

  it("refuses oversized bodies without pulling, even without a Content-Length", async () => {
    const { handle, pulls } = handler(async () => {})
    const chunk = new TextEncoder().encode("a".repeat(8_192))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
    })
    const request = new Request("http://backend/internal/events", {
      method: "POST",
      headers: { "Content-Type": "application/secevent+jwt" },
      body: stream,
      duplex: "half",
    } as RequestInit)
    expect((await handle(request)).status).toBe(413)
    expect(pulls()).toBe(0)
  })

  it("answers 503 when the pull fails or outlasts the budget", async () => {
    const failing = handler(async () => {
      throw new Error("IdP down")
    })
    expect((await failing.handle(post(await event()))).status).toBe(503)
    const slow = handler(() => new Promise((resolve) => setTimeout(resolve, 1_000)), 20)
    expect((await slow.handle(post(await event()))).status).toBe(503)
  })
})
