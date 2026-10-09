import { describe, expect, it } from "vitest"
import { formatTelegramActor, parseTelegramActor } from "../src"

describe("actor header", () => {
  it("round-trips numeric and string IDs", () => {
    expect(formatTelegramActor(123456789)).toBe("telegram:123456789")
    expect(parseTelegramActor(formatTelegramActor("555"))).toBe("555")
  })

  it.each(["0", "-1", "1.5", "12a", "", "123456789012345678901"])("refuses to format %j", (id) => {
    expect(() => formatTelegramActor(id)).toThrow(TypeError)
  })

  it.each([
    "telegram:0",
    "telegram:",
    "Telegram:1",
    "telegram:1 ",
    "user:1",
    "telegram:01",
  ])("rejects header %j", (value) => {
    expect(parseTelegramActor(value)).toBeNull()
  })
})
