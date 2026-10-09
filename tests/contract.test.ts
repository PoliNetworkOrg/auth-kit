import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import {
  ACCESS_CHANGED_EVENT,
  type AccessSnapshotV1,
  accessChangedEventClaims,
  accessChangedEventSchema,
  accessSnapshotSchema,
  idpEndpoints,
} from "../src/contract"
import * as main from "../src/index"
import { fixture } from "./fixtures"

describe("idpEndpoints", () => {
  it("derives the IdP's URLs from its public base URL", () => {
    expect(idpEndpoints({ publicUrl: "https://auth.polinetwork.org" })).toEqual({
      issuer: "https://auth.polinetwork.org/api/auth",
      jwksUrl: "https://auth.polinetwork.org/api/auth/jwks",
      tokenUrl: "https://auth.polinetwork.org/api/auth/oauth2/token",
      tokenAudience: "https://auth.polinetwork.org/api/auth/oauth2/token",
      snapshotUrl: "https://auth.polinetwork.org/api/internal/access-snapshot",
    })
  })

  it("sends requests in-cluster but keeps public identifiers", () => {
    const endpoints = idpEndpoints({
      publicUrl: "https://auth.polinetwork.org",
      internalUrl: "http://auth-service.auth.svc.cluster.local:3000",
    })
    expect(endpoints.issuer).toBe("https://auth.polinetwork.org/api/auth")
    expect(endpoints.tokenAudience).toBe("https://auth.polinetwork.org/api/auth/oauth2/token")
    expect(endpoints.tokenUrl).toBe("http://auth-service.auth.svc.cluster.local:3000/api/auth/oauth2/token")
    expect(endpoints.snapshotUrl).toBe("http://auth-service.auth.svc.cluster.local:3000/api/internal/access-snapshot")
  })
})

describe("snapshot producer types", () => {
  it("are accepted by the consumer schema", () => {
    expectTypeOf<AccessSnapshotV1>().toExtend<z.input<typeof accessSnapshotSchema>>()
  })

  it("describe the shared fixtures", () => {
    const body: AccessSnapshotV1 = JSON.parse(fixture("snapshot-v1.json"))
    expect(accessSnapshotSchema.safeParse(body).success).toBe(true)
  })
})

describe("access-changed event", () => {
  const claims = accessChangedEventClaims({
    issuer: "https://auth.polinetwork.org/api/auth",
    audience: "https://backend.internal.polinetwork.org",
    jti: "access-42",
    projection: "backend",
    now: 1_791_200_130,
  })

  it("matches the IdP's dispatcher output", () => {
    expect(claims).toEqual(JSON.parse(fixture("event-claims.json")))
    expect(claims.exp - claims.iat).toBe(60)
  })

  it("is accepted by the consumer schema", () => {
    expect(accessChangedEventSchema.parse(claims).events[ACCESS_CHANGED_EVENT].projection).toBe("backend")
  })

  it("rejects an event for another URI", () => {
    const { events: _, ...rest } = claims
    expect(accessChangedEventSchema.safeParse({ ...rest, events: { "urn:other": {} } }).success).toBe(false)
  })
})

it("re-exports the whole contract from the main entry", async () => {
  const contract = await import("../src/contract")
  for (const name of Object.keys(contract)) expect(main).toHaveProperty(name)
})
