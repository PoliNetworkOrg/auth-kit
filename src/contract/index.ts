/**
 * `@polinetwork/auth-kit/contract`: the wire format shared by the IdP and its consumers.
 * Constants, schemas and types only; no network clients.
 */
export {
  ACCESS_CHANGED_EVENT,
  ACCESS_READ_SCOPE,
  CLIENT_ASSERTION_TYPE,
  EVENT_CONTENT_TYPE,
  EVENT_LIFETIME_SEC,
  IDP_EVENT_TIMEOUT_MS,
  type IdpEndpoints,
  idpEndpoints,
  SIGNING_ALGORITHMS,
  SNAPSHOT_PATH,
  SNAPSHOT_SCHEMA,
  SUBJECT_TYPE_CLAIM,
  TOKEN_TYPES,
} from "./constants"
export { type AccessChangedEventClaims, accessChangedEventClaims, accessChangedEventSchema } from "./event"
export {
  type AccessSnapshotBody,
  type AccessSnapshotV1,
  type AccessSourceV1,
  type AccessSubjectV1,
  accessSnapshotSchema,
} from "./snapshot"
