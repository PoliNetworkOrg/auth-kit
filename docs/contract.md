# IdP contract consumed by auth-kit

**Status:** confirmed with the Phase 1 team on 9 October 2026, against `auth` branch `migration-phase1`.
**Relation to the RFC:** this file records how the IdP actually behaves where it is more precise than, or differs from, [the RFC](./idp-telegram-integration-rfc-v3.md). Where the two disagree, this file and the IdP code win. Each difference is marked **(differs from RFC)**.

The executable form of this contract is the `@polinetwork/auth-kit/contract` entry point (constants, schemas, producer types) and the fixtures in [`fixtures/`](../fixtures), which ship as `@polinetwork/auth-kit/fixtures/*`. [idp-adoption.md](./idp-adoption.md) describes how the IdP can import both.

---

## 1. Fixed vs. configured

**Fixed in the IdP code.** Changing any of these needs a coordinated IdP and SDK change. They are exported from `src/contract/`.

| Item                     | Value                                                                |
| ------------------------ | -------------------------------------------------------------------- |
| Snapshot endpoint        | `GET /api/internal/access-snapshot`                                  |
| Snapshot schema          | `polinetwork.access-snapshot/v1`                                     |
| Projection name          | `backend` (the only projection today)                                |
| ETag format              | `"sha256-<64 hex>"`, treated as opaque by the SDK                    |
| Event URI                | `https://schemas.polinetwork.org/events/access-changed`              |
| Snapshot scope           | `idp:access:read`                                                    |
| Subject-type claim       | `pn_subject_type`: `user` or `client`                                |
| Signing algorithm        | `EdDSA` (Ed25519)                                                    |
| Access-token TTLs        | 3600 s for the backend resource, 300 s for the internal resource     |
| Event sender timeout     | 8 s; only an exact `202` counts as delivered                         |

**Configuration, from env or the deployment:** the IdP base URL (`BETTER_AUTH_URL`), both resource identifiers, the backend client ID, the event receiver URL, hostnames and the poll interval. `idpEndpoints()` derives the rest:

| Derived value                   | From                                    |
| ------------------------------- | --------------------------------------- |
| Issuer                          | `<public URL>/api/auth`                 |
| JWKS                            | `<public or internal URL>/api/auth/jwks` |
| Token endpoint (request target) | `<public or internal URL>/api/auth/oauth2/token` |
| Client-assertion `aud`          | `<public URL>/api/auth/oauth2/token`, always public (RFC §12) |

---

## 2. Access snapshot

### 2.1 Content

- **Permissions are fully expanded.** Roles are resolved up through their parents and permissions down through their implications, transitively, in the IdP. The SDK only ever does a key lookup and repeats no role logic.
- **Master Admin is written out, never `*`.** Its entry lists every catalog key under the projection's prefixes. Break-glass admins get `validUntil: null`; members of the Entra admin group get that group's `observedAt` + 1 h.
- **Validity per key:** an implied key inherits the validity of the path that granted it. When several paths grant a key, the latest expiry wins and `null` beats any date.
- **Keys outside the projection's prefixes never appear,** even when implied by a key that does.
- **Absent means no permissions.** People without a projected permission are omitted, including people who linked Telegram. An unknown `sub` or Telegram ID is not an error.
- **`telegramId` may be `null` for someone who linked Telegram,** when the link is ambiguous (one person with several IDs, or one ID shared by several people). Duplicates therefore cannot appear; the SDK still rejects them as a backstop.
- **`telegramId` is a decimal string** matching `^[1-9]\d*$`.
- **Until Phase 2** creates the `tg:*` permissions, the production snapshot is nearly empty. Test against a local IdP with seeded permissions.

### 2.2 Format details **(differs from RFC)**

- **Sources are an open set.** Possible keys today: `rbac`, `entra:soci`, `entra:direttivo`, `entra:admins`, `polimi-email`. `entra:direttivo` and `entra:admins` appear only when their groups are configured. The parser accepts missing and unknown keys.
- **The only error code is `graph_unavailable`** (the RFC example says `graph_timeout`). The parser accepts any string.
- **Timestamps carry milliseconds** (`…T11:14:31.000Z`). The parser accepts any ISO 8601 precision and offset.
- **`builtAt` can be old on a healthy IdP.** When nothing changed, the IdP returns the stored body unchanged, including `builtAt` and the `rbac` / `polimi-email` `observedAt`. Without Entra configured this can be days old.
- **`generation` and the ETag change on almost every pull when Entra is configured,** because each observation moves `observedAt` and the derived `validUntil` values. `generation` is informational only.

### 2.3 Responses

| Status | Meaning                                                         | SDK reaction                                           |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------ |
| `200`  | Body follows                                                    | Validate, swap in, persist, set `lastSyncAt`           |
| `304`  | Body identical to the sent ETag                                 | Set `lastSyncAt`                                       |
| `401`  | Bad token, scope or audience (`{ "error": … }`)                 | Drop the cached token, fetch a new one, retry once     |
| `403`  | Valid token from a client without a projection                  | Configuration alert; no fast retry                     |
| `503`  | Endpoint not configured, or the build failed                    | Back off; keep the last good snapshot                  |

- **`If-None-Match: *` always returns `304`.** The SDK sends only an ETag the IdP returned.
- **The snapshot-pull token must carry exactly one `resource`.** The IdP requires `aud` to be a string equal to the internal resource.

---

## 3. Change events

| Field        | Value                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Header       | `typ: secevent+jwt`, `alg: EdDSA`, `kid` of the IdP's current key                              |
| `iss`        | `<public URL>/api/auth`                                                                        |
| `aud`        | The backend resource identifier                                                                |
| `iat`, `exp` | `exp = iat + 60 s`; every attempt is signed anew **(differs from RFC)**                         |
| `jti`        | `access-<lowest outbox id in the batch>`, reused on retries **(differs from RFC)**              |
| `events`     | `{ "<event URI>": { "projection": "backend" } }`; no `sub`                                     |
| Transport    | `POST`, `Content-Type: application/secevent+jwt`, the bare JWT as body                         |

- **Never deduplicate by `jti`.** A retry reuses it and may also cover changes made after the first attempt. Every valid event means "pull now".
- **Duplicates are expected.** After a timeout or a crashed sender, the same `jti` arrives again after up to 30 s.
- **Retries** back off from 2 s up to 60 s after any non-`202` answer or no answer within 8 s.
- **Receiver budget: about 6 s.** A pull triggered by an event usually reads Graph again (the IdP reuses observations only for 15 s, and reads time out after 5 s). The receiver answers `202` after the pull completes, or `503` past the budget while the pull keeps running.

---

## 4. Signing keys

- **Rotation:** every 7 days, with old keys still published for 30 days. `KEYS_MAX_AGE = 24 h` is well inside that.
- **A new key is used as soon as it is created** **(differs from RFC §6.5, step 2).** better-auth creates the key on demand and signs with it immediately. The key is published at the same moment, because the JWKS is served from the database, but a client cannot have fetched it in advance.
- **SDK rule for an unknown `kid`:** refetch immediately when the token's `iat` is later than the last fetch (one fetch at a time, with a short minimum gap); otherwise at most once per 30 s. An unknown `kid` still fails closed after the fetch.

---

## 5. Staleness

- `MAX_STALE` is measured **only** from `lastSyncAt`, the time of the last `200` or `304`. `builtAt` and `observedAt` are never used for freshness (§2.2).
- Per-key `validUntil` is enforced locally at every check, whatever the sync state.

---

## 6. Open items with the Phase 1 team

- **Event signing after key expiry (unverified).** The dispatcher passes `signingAlgorithm: "EdDSA"` to `signJWT`. In better-auth 1.7.2 an explicit algorithm makes `signJWT` throw instead of creating a key when the current one has expired (`plugins/jwt/sign.mjs:57-58`). If so, events fail after each weekly expiry until another issuance creates the key. Polling covers the gap.
- **RFC update.** §5.3 and §5.6 should take the differences marked above.
