import { describe, expect, it } from "vitest"
import { type Actor, accessSnapshot, memoryPersistence, type TokenSource } from "../src"
import { fixture } from "./fixtures"
import { clock, fakeFetch } from "./idp"

const URL = "http://auth.internal/api/internal/access-snapshot"
const BODY = fixture("snapshot-v1.json")
const ETAG = '"sha256-aaaa"'
const moderator: Actor = { kind: "telegram", client: "telegram-bot", telegramId: "123456789", sub: "usr_moderator" }

function tokenSource() {
  let n = 0
  let invalidated = 0
  const tokens: TokenSource = {
    getToken: async () => `token-${n}`,
    invalidate: () => {
      invalidated++
      n++
    },
  }
  return { tokens, invalidated: () => invalidated }
}

type Reply = (request: Request) => Response | Promise<Response>

function setup(reply: Reply, persistence = memoryPersistence()) {
  const time = clock(Date.parse("2026-10-09T10:20:00.000Z"))
  const { tokens, invalidated } = tokenSource()
  const errors: unknown[] = []
  const { fetch, requests } = fakeFetch(reply)
  const client = accessSnapshot({
    url: URL,
    tokens,
    projection: "backend",
    persistence,
    fetch,
    now: time.now,
    onError: (error) => errors.push(error),
  })
  return { client, time, requests, errors, persistence, invalidated }
}

const ok = () => new Response(BODY, { status: 200, headers: { ETag: ETAG } })

describe("accessSnapshot", () => {
  it("pulls with a bearer token, swaps in the snapshot and answers permission checks", async () => {
    const { client, requests } = setup(ok)
    await client.start()
    client.stop()
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer token-0")
    expect(requests[0]?.headers.has("if-none-match")).toBe(false)
    expect(client.status()).toMatchObject({ fresh: true, generation: 4813, subjects: 5 })
    expect(client.has(moderator, "tg:moderate")).toBe(true)
    expect(client.has(moderator, "tg:moderate:global")).toBe(false)
    expect(client.subjectByTelegramId("555")?.sub).toBe("usr_direttivo")
  })

  it("denies service actors, actors without sub, and expired permission paths", async () => {
    const { client, time } = setup(ok)
    await client.start()
    client.stop()
    expect(client.has({ kind: "service", client: "telegram-bot" }, "tg:moderate")).toBe(false)
    expect(client.has({ ...moderator, sub: null }, "tg:moderate")).toBe(false)
    const direttivo: Actor = { kind: "user", client: "admin-dashboard", sub: "usr_direttivo", telegramId: "555" }
    expect(client.has(direttivo, "tg:moderate:global")).toBe(true)
    time.advance(55 * 60_000)
    expect(client.has(direttivo, "tg:moderate:global")).toBe(false)
    expect(client.has(direttivo, "tg:audit:read")).toBe(true)
  })

  it("revalidates with the ETag and counts a 304 as a sync", async () => {
    let calls = 0
    const { client, time, requests } = setup(() => (++calls === 1 ? ok() : new Response(null, { status: 304 })))
    await client.start()
    client.stop()
    time.advance(50 * 60_000)
    await client.refresh()
    expect(requests[1]?.headers.get("if-none-match")).toBe(ETAG)
    time.advance(50 * 60_000)
    expect(client.status().fresh).toBe(true)
    expect(client.has(moderator, "tg:moderate")).toBe(true)
  })

  it("fails closed once the last sync is older than MAX_STALE", async () => {
    let online = true
    const { client, time } = setup(() => (online ? ok() : new Response(null, { status: 503 })))
    await client.start()
    client.stop()
    online = false
    time.advance(60 * 60_000)
    await expect(client.refresh()).rejects.toMatchObject({ code: "snapshot_unavailable" })
    expect(client.has(moderator, "tg:moderate")).toBe(true)
    time.advance(1)
    expect(client.has(moderator, "tg:moderate")).toBe(false)
    expect(client.subjectBySub("usr_moderator")).toBeUndefined()
    expect(client.current()?.bySub("usr_moderator")).toBeDefined()
  })

  it("renews the token once after a 401", async () => {
    let calls = 0
    const { client, invalidated, requests } = setup((request) =>
      ++calls === 1 && request.headers.get("authorization") === "Bearer token-0"
        ? Response.json({ error: "invalid_token" }, { status: 401 })
        : ok()
    )
    await client.refresh()
    expect(invalidated()).toBe(1)
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer token-1")
    expect(client.status().fresh).toBe(true)
  })

  it("keeps the previous snapshot when a new one is invalid", async () => {
    let calls = 0
    const { client } = setup(() => (++calls === 1 ? ok() : new Response(fixture("invalid/duplicate-sub.json"))))
    await client.refresh()
    await expect(client.refresh()).rejects.toMatchObject({ code: "snapshot_invalid" })
    expect(client.status().generation).toBe(4813)
    expect(client.has(moderator, "tg:moderate")).toBe(true)
  })

  it("resumes from the persisted snapshot after a restart during an outage", async () => {
    const persistence = memoryPersistence()
    const first = setup(ok, persistence)
    await first.client.start()
    first.client.stop()

    const restarted = setup(() => new Response(null, { status: 503 }), persistence)
    await restarted.client.start()
    restarted.client.stop()
    expect(restarted.errors).toHaveLength(1)
    expect(restarted.client.has(moderator, "tg:moderate")).toBe(true)
    restarted.time.advance(60 * 60_000 + 1)
    expect(restarted.client.has(moderator, "tg:moderate")).toBe(false)
  })

  it("ignores a persisted snapshot dated in the future", async () => {
    const persistence = memoryPersistence()
    await persistence.save(
      "snapshot:backend",
      JSON.stringify({ body: BODY, etag: ETAG, lastSyncAt: Date.parse("2027-01-01T00:00:00.000Z") })
    )
    const { client } = setup(() => new Response(null, { status: 503 }), persistence)
    await client.start()
    client.stop()
    expect(client.status().lastSyncAt).toBeNull()
    expect(client.has(moderator, "tg:moderate")).toBe(false)
  })

  it("abandons a pull that hangs and keeps the previous snapshot", async () => {
    let calls = 0
    const time = clock()
    const { fetch } = fakeFetch((request) =>
      ++calls === 1
        ? ok()
        : new Promise<Response>((_, reject) => {
            request.signal.addEventListener("abort", () => reject(request.signal.reason))
          })
    )
    const client = accessSnapshot({
      url: URL,
      tokens: tokenSource().tokens,
      projection: "backend",
      fetch,
      now: time.now,
      timeoutMs: 20,
    })
    await client.refresh()
    await expect(client.refresh()).rejects.toMatchObject({ code: "snapshot_unavailable" })
    expect(client.has(moderator, "tg:moderate")).toBe(true)
  })

  it("fails closed on a cold start without a stored snapshot", async () => {
    const { client } = setup(() => new Response(null, { status: 503 }))
    await client.start()
    client.stop()
    expect(client.status()).toEqual({ lastSyncAt: null, fresh: false, generation: null, subjects: 0 })
    expect(client.has(moderator, "tg:moderate")).toBe(false)
  })

  it("runs one pull at a time and queues a single follow-up for triggers during a pull", async () => {
    const pending: Array<() => void> = []
    const { client, requests } = setup(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(() => resolve(ok()))
        })
    )
    const first = client.refresh()
    const second = client.refresh()
    const third = client.refresh()
    expect(second).toBe(third)
    await Promise.resolve()
    expect(requests).toHaveLength(1)
    pending.shift()?.()
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requests).toHaveLength(2)
    pending.shift()?.()
    await second
    expect(requests).toHaveLength(2)
  })
})
