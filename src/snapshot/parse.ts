import { z } from "zod"
import { accessSnapshotSchema } from "../contract/snapshot"
import { AuthKitError } from "../errors"
import { AccessIndex } from "./access-index"

/**
 * Parses and validates a snapshot response body. Throws `snapshot_invalid` on any problem, so
 * the caller keeps its previous snapshot (RFC §5.5).
 */
export function parseAccessSnapshot(body: string, expectedProjection: string): AccessIndex {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch (error) {
    throw new AuthKitError("snapshot_invalid", "Snapshot body is not JSON", { cause: error })
  }
  const result = accessSnapshotSchema.safeParse(json)
  if (!result.success) throw new AuthKitError("snapshot_invalid", z.prettifyError(result.error))
  if (result.data.projection !== expectedProjection)
    throw new AuthKitError(
      "snapshot_invalid",
      `Expected projection "${expectedProjection}", got "${result.data.projection}"`
    )
  return AccessIndex.from(result.data)
}
