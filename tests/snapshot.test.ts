import { describe, expect, it } from "vitest"
import { type AuthKitError, parseAccessSnapshot } from "../src"
import { fixture } from "./fixtures"

const BUILT_AT = Date.parse("2026-10-09T10:15:02.123Z")
const DIRETTIVO_EXPIRY = Date.parse("2026-10-09T11:14:31.456Z")

/** The v1 fixture as an IdP sent it before roles and the catalog were projected. */
function withoutRoles(): string {
  const body = JSON.parse(fixture("snapshot-v1.json"))
  delete body.catalog
  for (const subject of body.subjects) delete subject.roles
  return JSON.stringify(body)
}

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

  it("indexes effective roles and drops each once now reaches its validUntil", () => {
    const index = parseAccessSnapshot(fixture("snapshot-v1.json"), "backend")
    const direttivo = index.bySub("usr_direttivo")
    expect(index.roles(direttivo, DIRETTIVO_EXPIRY - 1)).toEqual(["auditor", "direttivo", "socio"])
    expect(index.hasRole(direttivo, "socio", DIRETTIVO_EXPIRY - 1)).toBe(true)
    expect(index.hasRole(direttivo, "socio", DIRETTIVO_EXPIRY)).toBe(false)
    expect(index.roles(direttivo, DIRETTIVO_EXPIRY)).toEqual(["auditor"])
    expect(index.hasRole(index.bySub("usr_admin_breakglass"), "master-admin", Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(index.hasRole(undefined, "moderator")).toBe(false)
    expect(index.roles(undefined)).toEqual([])
  })

  it("exposes the role and permission catalog, frozen", () => {
    const catalog = parseAccessSnapshot(fixture("snapshot-v1.json"), "backend").catalog()
    expect(catalog.roles.map(({ key }) => key)).toEqual([
      "auditor",
      "direttivo",
      "master-admin",
      "moderator",
      "socio",
      "student",
      "web-editor",
    ])
    expect(catalog.permissions[0]).toEqual({ key: "admin:access", name: "Admin access" })
    expect(catalog.permissions).toHaveLength(19)
    expect(Object.isFrozen(catalog.roles)).toBe(true)
    expect(Object.isFrozen(catalog.roles[0])).toBe(true)
  })

  it("accepts snapshots from before roles and the catalog", () => {
    const index = parseAccessSnapshot(withoutRoles(), "backend")
    const moderator = index.bySub("usr_moderator")
    expect(moderator?.roles.size).toBe(0)
    expect(index.roles(moderator)).toEqual([])
    expect(index.has(moderator, "tg:moderate", BUILT_AT)).toBe(true)
    expect(index.catalog()).toEqual({ roles: [], permissions: [] })
  })

  it("drops a malformed catalog rather than rejecting the snapshot", () => {
    const body = JSON.parse(fixture("snapshot-v1.json"))
    body.catalog.roles = [{ key: "" }]
    expect(parseAccessSnapshot(JSON.stringify(body), "backend").catalog()).toMatchObject({ roles: [] })
    body.catalog = "roles"
    expect(parseAccessSnapshot(JSON.stringify(body), "backend").catalog()).toEqual({ roles: [], permissions: [] })
  })

  it("rejects a role with an invalid validUntil", () => {
    const body = JSON.parse(fixture("snapshot-v1.json"))
    body.subjects[0].roles["master-admin"] = { validUntil: "tomorrow" }
    expectInvalid(JSON.stringify(body))
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
