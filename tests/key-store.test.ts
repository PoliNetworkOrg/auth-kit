import { jwtVerify } from "jose"
import { describe, expect, it } from "vitest"
import { createKeyStore, memoryPersistence } from "../src"
import { clock, fakeFetch, JWKS_URL, nowSec, type SigningKey, serviceClaims, sign, signingKey } from "./idp"

async function setup(initial: SigningKey[]) {
  let published = initial
  let online = true
  const time = clock()
  const persistence = memoryPersistence()
  const { fetch, requests } = fakeFetch(() =>
    online ? Response.json({ keys: published.map((key) => key.publicJwk) }) : new Response(null, { status: 503 })
  )
  const make = () => createKeyStore({ jwksUrl: JWKS_URL, persistence, fetch, now: time.now, onError: () => {} })
  return {
    time,
    persistence,
    requests,
    make,
    publish: (keys: SigningKey[]) => {
      published = keys
    },
    setOnline: (value: boolean) => {
      online = value
    },
  }
}

const verify = (token: string, store: { getKey: Parameters<typeof jwtVerify>[1] }) =>
  jwtVerify(token, store.getKey as never, { algorithms: ["EdDSA"] })

describe("createKeyStore", () => {
  it("fetches, persists and resolves keys by kid", async () => {
    const first = await signingKey("k1")
    const env = await setup([first])
    const store = env.make()
    await store.start()
    store.stop()
    expect(store.status()).toMatchObject({ kids: ["k1"] })
    expect(await env.persistence.load(`jwks:${JWKS_URL}`)).toContain("k1")
    await expect(verify(await sign(first, serviceClaims()), store)).resolves.toBeTruthy()
  })

  it("refetches immediately for a token newer than the last fetch, and fails closed on an unknown kid", async () => {
    const first = await signingKey("k1")
    const second = await signingKey("k2")
    const env = await setup([first])
    const store = env.make()
    await store.start()
    store.stop()
    env.publish([first, second])
    env.time.advance(2_000)
    // Issued after the last fetch: a key the IdP created since then.
    const fresh = await sign(second, serviceClaims({ iat: nowSec() + 2 }))
    await expect(verify(fresh, store)).resolves.toBeTruthy()
    expect(env.requests).toHaveLength(2)

    // Within 30 s of the last fetch, an old token with an unknown kid triggers no fetch at all.
    const stranger = await signingKey("unknown")
    const early = await sign(stranger, serviceClaims({ iat: nowSec() - 60 }))
    await expect(verify(early, store)).rejects.toThrow()
    expect(env.requests).toHaveLength(2)
    env.time.advance(30_000)
    const old = await sign(stranger, serviceClaims({ iat: nowSec() - 60 }))
    await expect(verify(old, store)).rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" })
    await expect(verify(old, store)).rejects.toMatchObject({ code: "ERR_JWKS_NO_MATCHING_KEY" })
    // Old tokens with unknown kids refetch at most once per 30 s.
    expect(env.requests).toHaveLength(3)
  })

  it("refetches for a token issued in the same second as the last fetch", async () => {
    const first = await signingKey("k1")
    const second = await signingKey("k2")
    const env = await setup([first])
    const store = env.make()
    await store.start()
    store.stop()
    const fetchSecond = Math.floor(env.time.now() / 1000)
    env.publish([first, second])
    env.time.advance(1_000)
    const token = await sign(second, serviceClaims({ iat: fetchSecond }))
    await expect(verify(token, store)).resolves.toBeTruthy()
    expect(env.requests).toHaveLength(2)
  })

  it("ignores persisted keys dated in the future", async () => {
    const first = await signingKey("k1")
    const env = await setup([first])
    await env.persistence.save(
      `jwks:${JWKS_URL}`,
      JSON.stringify({ fetchedAt: env.time.now() + 86_400_000, jwks: { keys: [first.publicJwk] } })
    )
    env.setOnline(false)
    const store = env.make()
    await store.start()
    store.stop()
    expect(store.status().fetchedAt).toBeNull()
  })

  it("keeps the persisted keys through an outage until they are a day old", async () => {
    const first = await signingKey("k1")
    const env = await setup([first])
    const warm = env.make()
    await warm.start()
    warm.stop()

    env.setOnline(false)
    const restarted = env.make()
    await restarted.start()
    restarted.stop()
    const token = await sign(first, serviceClaims())
    await expect(verify(token, restarted)).resolves.toBeTruthy()
    env.time.advance(86_400_001)
    await expect(verify(token, restarted)).rejects.toMatchObject({ code: "keys_unavailable" })
  })

  it("fails closed on a cold start with the IdP unreachable", async () => {
    const first = await signingKey("k1")
    const env = await setup([first])
    env.setOnline(false)
    const store = env.make()
    await store.start()
    store.stop()
    await expect(verify(await sign(first, serviceClaims()), store)).rejects.toMatchObject({ code: "keys_unavailable" })
    expect(store.status()).toEqual({ fetchedAt: null, kids: [] })
  })
})
