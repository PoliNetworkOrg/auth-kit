# Adopting the shared contract in the IdP

**Status:** not started. To be done in `auth` once the Phase 1 work on `migration-phase1` has settled.

Today the IdP and auth-kit each define the snapshot and event format on their own, and only [`docs/contract.md`](./contract.md) plus the shared fixtures keep them in step. The IdP should instead import the format from `@polinetwork/auth-kit/contract`. Then a format change can only be made by changing the SDK first, and the compiler and tests catch any drift.

`@polinetwork/auth-kit/contract` contains only constants, zod schemas, types and one pure function. It has no network clients and no dependencies beyond `zod`, which the IdP already uses.

## What the contract entry provides

| Export                                                     | Kind      | Replaces in `auth`                                              |
| ---------------------------------------------------------- | --------- | --------------------------------------------------------------- |
| `SNAPSHOT_SCHEMA`                                          | constant  | `SCHEMA` in `src/auth/access-snapshot.ts`                       |
| `AccessSnapshotV1`, `AccessSourceV1`, `AccessSubjectV1`    | types     | `AccessSnapshot`, `AccessSource`, `AccessSubject` in the same file |
| `ACCESS_CHANGED_EVENT`                                     | constant  | `EVENT` in `src/auth/access-dispatcher.ts`                      |
| `accessChangedEventClaims()`                               | function  | The payload literal passed to `signJWT` in the dispatcher       |
| `TOKEN_TYPES.event`, `EVENT_CONTENT_TYPE`, `EVENT_LIFETIME_SEC` | constants | The `typ` header, `Content-Type` and `exp = iat + 60` in the dispatcher |
| `ACCESS_READ_SCOPE`, `SUBJECT_TYPE_CLAIM`, `TOKEN_TYPES.access` | constants | String literals in `src/auth/access-snapshot-token.ts` and `customAccessTokenClaims` |
| `SNAPSHOT_PATH`                                            | constant  | Checked by a test only (see step 4)                             |
| `accessSnapshotSchema`, `accessChangedEventSchema`         | schemas   | Nothing; used in contract tests                                 |

The `V1` types are the **producer** side: exactly what the IdP emits today, for example `health: "ok" | "degraded"`. The schemas are the **consumer** side and deliberately lenient. A test in this repository checks that every `AccessSnapshotV1` passes `accessSnapshotSchema`.

## Steps in `auth`

1. **Add the dependency:** `pnpm add @polinetwork/auth-kit`. Production code imports only from `@polinetwork/auth-kit/contract`.

2. **Snapshot builder** (`src/auth/access-snapshot.ts`):
   - replace `SCHEMA` with `SNAPSHOT_SCHEMA`;
   - delete the local `AccessSource`, `AccessSubject` and `AccessSnapshot` types and use the `V1` types. `projectBackendSubjects` returns `AccessSubjectV1[]`; `body` is typed `AccessSnapshotV1`.

3. **Dispatcher** (`src/auth/access-dispatcher.ts`): build the payload with `accessChangedEventClaims({ issuer, audience, jti: eventId, projection: "backend" })`, set the header to `{ typ: TOKEN_TYPES.event }` and the request's `Content-Type` to `EVENT_CONTENT_TYPE`.

4. **Snapshot route** (`src/routes/api/internal/access-snapshot.ts`): TanStack's file routes need a literal path, so keep it, and add a unit test asserting it equals `SNAPSHOT_PATH`.

5. **Contract tests:**
   - **Snapshot:** in `access-snapshot.integration.test.ts`, parse the output of `buildBackendSnapshot()` with `parseAccessSnapshot(body, "backend")` from `@polinetwork/auth-kit`. This is the same code the backend runs, so a format change the backend would reject fails here first.
   - **Event:** once `createAccessEventHandler` is implemented, deliver one event from `dispatchAccessChanges` to it in `access-dispatcher.integration.test.ts`, and assert `202`.
   - **Fixtures:** optionally, check that `projectBackendSubjects` reproduces `fixtures/snapshot-v1.json` from equivalent seed data. This pins the expansion rules (wildcard, implications, latest expiry) as well as the format.

6. **Remove** the "differs from RFC" notes in [`contract.md`](./contract.md) that the IdP code now enforces through types.

## Versioning rules after adoption

- **The IdP depends on `^0.N.x`,** like every other consumer. On `0.x` this stays within one minor version.
- **Changing the format goes SDK-first:**
  1. a PR here updates the schema or types, fixtures and `contract.md`, and is released;
  2. the IdP upgrades and changes its output;
  3. consumers upgrade at their own pace.
- **Additive changes are safe in any order,** because consumers parse leniently: a new field, source key, health value or error code.
- **A new major schema** (`…/v2`) is a breaking change. Consumers reject an unknown major version and fail closed once `MAX_STALE` passes. The IdP would have to serve both versions during the transition, which this contract does not yet provide for.
