import { z } from "zod"
import type { SNAPSHOT_SCHEMA } from "./constants"

// The IdP emits `toISOString()` (milliseconds, `Z`); accept any ISO 8601 precision or offset.
const timestamp = z.iso.datetime({ offset: true })

/** Major version 1 only; minor revisions add fields, which are ignored. */
const schemaId = z.string().regex(/^polinetwork\.access-snapshot\/v1(\.\d+)?$/, "unsupported snapshot schema")

const expiries = z.record(z.string().min(1), z.object({ validUntil: timestamp.nullable() }))

// Display names only, so a malformed list is dropped rather than failing the snapshot.
const names = z
  .array(z.object({ key: z.string().min(1), name: z.string() }))
  .optional()
  .catch(undefined)

/**
 * Consumer schema for `polinetwork.access-snapshot/v1`. Deliberately lenient: source keys,
 * health values and error codes are open sets, and unknown fields are ignored, so the IdP can
 * make additive changes before consumers upgrade.
 */
export const accessSnapshotSchema = z.object({
  schema: schemaId,
  projection: z.string().min(1),
  generation: z.number().int().nonnegative(),
  builtAt: timestamp,
  sources: z.record(
    z.string(),
    z.object({
      health: z.string(),
      observedAt: timestamp.nullable(),
      error: z.string().optional(),
    })
  ),
  /** Absent from IdPs before roles were projected. */
  catalog: z.object({ roles: names, permissions: names }).optional().catch(undefined),
  subjects: z.array(
    z.object({
      sub: z.string().min(1),
      telegramId: z
        .string()
        .regex(/^[1-9]\d*$/)
        .nullable(),
      /** Absent from IdPs before roles were projected. */
      roles: expiries.optional(),
      permissions: expiries,
    })
  ),
})

export type AccessSnapshotBody = z.infer<typeof accessSnapshotSchema>

/**
 * Producer types: exactly what the IdP emits today. Stricter than {@link accessSnapshotSchema};
 * widening them (a new source health or error code) is a contract change made here first.
 */
export type AccessSourceV1 = {
  health: "ok" | "degraded"
  /** ISO 8601 with milliseconds; null if the source was never observed. */
  observedAt: string | null
  error?: "graph_unavailable"
}

export type AccessSubjectV1 = {
  sub: string
  /** Decimal string; null when not linked or ambiguous. */
  telegramId: string | null
  /** Granted roles plus every role they inherit from; `validUntil: null` never expires. */
  roles: Record<string, { validUntil: string | null }>
  /** Fully expanded keys; `validUntil: null` never expires. */
  permissions: Record<string, { validUntil: string | null }>
}

/** Sorted by key. Every role, and every permission the projection can carry. */
export type AccessCatalogV1 = {
  roles: { key: string; name: string }[]
  permissions: { key: string; name: string }[]
}

export type AccessSnapshotV1 = {
  schema: typeof SNAPSHOT_SCHEMA
  projection: string
  generation: number
  builtAt: string
  sources: Record<string, AccessSourceV1>
  catalog: AccessCatalogV1
  subjects: AccessSubjectV1[]
}
