import { describe, expect, it } from "vitest"
import { type AuthKitError, parseAccessSnapshot } from "../src"
import { fixture } from "./fixtures"

const BUILT_AT = Date.parse("2026-10-09T10:15:02.123Z")
const DIRETTIVO_EXPIRY = Date.parse("2026-10-09T11:14:31.456Z")

function expectInvalid(body: string, projection = "backend") {
  expect(() => parseAccessSnapshot(body, projection)).toThrowError(
    expect.objectContaining({ name: "AuthKitError", code: "snapshot_invalid" }) as AuthKitError
  )
}

describe("parseAccessSnapshot", () => {
  it("indexes subjects by sub and Telegram ID", () => {
    const index = parseAccessSnapshot(fixture("snapshot-v1.json"), "backend")
    expect(index.generation).toBe(4813)
    expect(index.size).toBe(5)
    expect(index.byTelegramId(123456789)?.sub).toBe("usr_moderator")
    expect(index.byTelegramId("555")?.sub).toBe("usr_direttivo")
    expect(index.bySub("usr_web")?.telegramId).toBeNull()
  })

  it("treats unknown subjects and Telegram IDs as holding nothing", () => {
    const index = parseAccessSnapshot(fixture("snapshot-v1.json"), "backend")
    expect(index.bySub("usr_nobody")).toBeUndefined()
    expect(index.has(index.byTelegramId("987654321"), "tg:moderate", BUILT_AT)).toBe(false)
    expect(index.permissions(undefined)).toEqual([])
  })

  it("drops a permission once now reaches validUntil, keeping other paths", () => {
    const index = parseAccessSnapshot(fixture("snapshot-v1.json"), "backend")
    const direttivo = index.bySub("usr_direttivo")
    expect(index.has(direttivo, "tg:moderate:global", DIRETTIVO_EXPIRY - 1)).toBe(true)
    expect(index.has(direttivo, "tg:moderate:global", DIRETTIVO_EXPIRY)).toBe(false)
    expect(index.permissions(direttivo, DIRETTIVO_EXPIRY)).toEqual(["tg:audit:read"])
  })

  it("never expires a null validUntil", () => {
    const index = parseAccessSnapshot(fixture("snapshot-v1.json"), "backend")
    expect(index.has(index.bySub("usr_admin_breakglass"), "tg:grants:manage", Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it("accepts degraded sources, empty snapshots and additive changes", () => {
    expect(parseAccessSnapshot(fixture("snapshot-degraded.json"), "backend").sources["entra:soci"]?.error).toBe(
      "graph_unavailable"
    )
    expect(parseAccessSnapshot(fixture("snapshot-empty.json"), "backend").size).toBe(0)
    expect(parseAccessSnapshot(fixture("snapshot-additive.json"), "backend").size).toBe(5)
  })

  it.each([
    "unknown-major",
    "duplicate-sub",
    "duplicate-telegram-id",
    "numeric-telegram-id",
    "bad-timestamp",
  ])("rejects invalid/%s", (name) => {
    expectInvalid(fixture(`invalid/${name}.json`))
  })

  it("rejects another projection and non-JSON bodies", () => {
    expectInvalid(fixture("snapshot-v1.json"), "rooms")
    expectInvalid("<html>")
  })
})
