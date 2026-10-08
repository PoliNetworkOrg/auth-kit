# RFC: Unifying Telegram infrastructure authorization under the PoliNetwork IdP

**Status:** Phase 0 contract frozen, revision 3 (8 October 2026). No production configuration or migration has changed.
**Scope:** `auth` (IdP), `backend`, `telegram` (bot), `admin` (dashboard), `web` (public site), `polinetwork-cd` (deployment). Also the reference for every future service that integrates with the IdP.

> **About the examples.** All hostnames, Service DNS names, client IDs, key IDs, token values, user IDs, Telegram IDs, TTLs, intervals and sizes in this document are **illustrative**. They show the shape of the solution. Production values are chosen during implementation and recorded in the deployment repository, not here.

---

## 0. Revision history and Phase 0 closure

Revision 3 incorporates the Phase 0 OAuth observations (§7.4), the owner's Q1–Q8 decisions (§16), and the resulting frozen permission catalog, runtime role policy and enforcement table (§§4, 8). It remains a migration design; no production IdP, backend or deployment setting was changed during Phase 0. Revision 1 was reviewed on 6 October 2026 (19 findings, F01–F19); revision 2 addressed them as follows.

| Finding                                                     | Disposition                                                                                                                                                                                                         | Where           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| F01 No per-operation authorization plan; Entra group writes | **Addressed.** Full enforcement table, deny-by-default. The dashboard exposes only the dedicated create-socio workflow; no general Entra group writes.                                                              | §4, §8, §9.1    |
| F02 Automatic bot actions have no person                    | **Addressed.** Three actor kinds; service-only operations have their own scopes.                                                                                                                                    | §6.1, §6.2, §8  |
| F03 Grant migration reactivates interrupted grants          | **Not applicable.** Grants are not migrated: the table is recreated empty and any grants are re-entered by hand. The new grant schema stores interruption separately anyway.                                        | §9.3, §13       |
| F04 OAuth setup can't produce the described tokens          | **Addressed.** Exact provisioning recipe that matches `@better-auth/oauth-provider` 1.7.2 behaviour, and a Phase 0 spike that produces real decoded tokens.                                                         | §7, §13 Phase 0 |
| F05 Migration order; no dashboard bridge                    | **Addressed.** Plan reordered. Per-caller cutover: token-bearing requests are enforced under the new model, anonymous ones fall back to legacy until the final switch. `interruptedById` added to the removal list. | §13             |
| F06 Native-admin actions can't be audited                   | **Addressed.** Service-authorized `tg.auditLog.record`, with an explicit `basis` and a bot-side retry outbox.                                                                                                       | §9.2, §10       |
| F07 `ctx.api` overwritten in the example                    | **Example corrected.** Uses `ctx.backend` plus a separate service client.                                                                                                                                           | §10.1           |
| F08 JWKS cache doesn't survive an IdP outage                | **Addressed.** Last-known-good key policy, persisted, with a bounded age.                                                                                                                                           | §6.5            |
| F09 Verifier accepts tokens without required claims         | **Addressed.** `requiredClaims`, algorithm allowlist, clock tolerance, explicit subject type.                                                                                                                       | §6.4            |
| F10 "Compromised bot can't create grants" is wrong          | **Corrected.** Explicit trust model. Escalating writes accept only dashboard user tokens.                                                                                                                           | §6.3            |
| F11 Snapshot has no expiry fields                           | **Addressed.** Versioned schema, `validUntil` per permission.                                                                                                                                                       | §5.3            |
| F12 "Max age" undefined                                     | **Addressed.** `builtAt`, per-source `observedAt`/health, 200/304 rules, cold-start rules.                                                                                                                          | §5.4            |
| F13 Versions, ETags, parallel pulls                         | **Addressed.** Single-flight refresh, atomic swap, content-hash ETag; generation is informational only.                                                                                                             | §5.5            |
| F14 Outbox misses link/unlink                               | **Addressed.** Database triggers on every table that feeds the snapshot; push is best-effort and polling is authoritative.                                                                                          | §5.6            |
| F15 Queued ban-all ignores revocation                       | **Out of scope by decision.** A ban-all is authorized once, when it is queued, and a started ban-all runs to completion. The queue will move to the backend in later work.                                          | §10.3           |
| F16 URLs, NetworkPolicy, replicas                           | **Examples marked illustrative** (box above). Factual claims corrected: no NetworkPolicy exists today, and everything runs on a single node.                                                                        | §2.1, §12       |
| F17 Dashboard session lifecycle                             | **Addressed.** Full session contract.                                                                                                                                                                               | §11             |
| F18 Snapshot filtering undefined                            | **Addressed.** Admin-controlled projection registry, keyed by the calling client.                                                                                                                                   | §5.2            |
| F19 polinet.cc lag contradiction                            | **Corrected.**                                                                                                                                                                                                      | §14.2           |

Other corrections found while re-checking the code:

- **The IdP has no unique index on the numeric Telegram ID.** Uniqueness is only on `(issuer, account_id)` of the Telegram account. Fixed in §7.6.
- **Bounded delegated role administration already exists** in the IdP (`rbac-delegation.ts`). Phase 0 additionally separates role assignment from definition editing (§4.2, Q2).
- **IdP access tokens are opaque unless `resource=` is requested.** The design relies on JWT access tokens, so every backend-bound request must carry `resource`. See §7.
- **The IdP signs with EdDSA (Ed25519),** not ES256. Examples updated.
- **Secrets live in Azure Key Vault** through the Secrets Store CSI driver, not in sealed secrets.

---

## 1. Summary

The IdP in `auth` becomes the single source of truth for identity and permissions. The Telegram moderation stack (bot, backend, admin dashboard) and the public website stop using their own identity, roles and linking.

After the migration:

- **People** log in to everything through the IdP. They link Telegram **once, in the IdP**, through Telegram's official login.
- **Permissions** are assigned only in the IdP, as roles that bundle permissions. Assigning someone a role is all it takes to grant bot powers. The dashboard is not involved.
- **Services** authenticate to each other with OAuth 2.0 JWT access tokens issued by the IdP. The backend rejects every request that has no valid token, and never takes "who is acting" from a request body.
- **The backend** keeps a local, always-current copy of the relevant permissions, called the _access snapshot_. The IdP sends a change notification after every relevant database write, and the backend also polls. In normal operation, revocation takes about a second.
- **Every backend operation has an entry in an enforcement table**: allowed actor kinds, required scope, required permission. Operations missing from the table are denied.
- **The bot keeps one shortcut, which lives entirely inside it:** some commands may also be used by native Telegram chat administrators without any IdP permission.

---

## 2. Current state

### 2.1 Components

| Repo             | Role today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`           | OIDC provider built on better-auth 1.7.2 and `@better-auth/oauth-provider` 1.7.2.<br>• **RBAC:** global, with roles, permissions, inheritance and implications, an append-only audit log, and bounded delegated administration. Managed roles (`socio`, `direttivo`, `student`, `master-admin`) are derived from Entra groups, Polimi email verification and an Entra admin group.<br>• **Telegram:** linked through Telegram's official OIDC flow; the numeric ID is stored in `identity_evidence.telegram_id`.<br>• **Custom claims:** emitted under the `polinetwork:identity` scope.<br>• **OAuth:** only `authorization_code` and `refresh_token` are enabled, and resource administration is disabled.<br>• **Integrations:** has no service API. Already used by `polinet.cc`. |
| `backend`        | Bun + Hono + tRPC on Postgres.<br>• **Hosts:** the current better-auth server (email OTP, passkeys, custom Telegram link), `tg_permissions`, `tg_group_admins`, grants, the audit log, Azure/Entra administration through Microsoft Graph, website content, and a socket.io channel to the bot.<br>• **Package:** router types are published as `@polinetwork/backend`.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `telegram`       | grammY bot (long polling).<br>• **Backend calls:** about 20 tRPC procedures, through a module-level singleton client.<br>• **Role checks:** per command (`allowedRoles` / `excludedRoles` / `allowGroupAdmins`).<br>• **Background work:** a BullMQ ban-all queue and automatic moderation (campaign spam, link mute, multi-chat spam).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `admin`          | TanStack Start dashboard.<br>• **Authentication:** proxies `/api/auth/*` to the backend's better-auth and forwards only the cookie to tRPC.<br>• **Authorization:** in its own server functions, with `tg.permissions.getRoles(session.user.telegramId)` and `ADMIN_ROLES` / `WRITE_ADMIN_ROLES`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `web`            | Public website. Calls `web.*` reads and `tg.groups.search` server-side, anonymously.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `polinetwork-cd` | ArgoCD-managed manifests.<br>• **Topology:** one replica per app, on a single node.<br>• **Network:** no NetworkPolicy; public exposure goes through a Cloudflare tunnel managed outside git.<br>• **Secrets:** from Azure Key Vault through the CSI driver.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 2.2 Findings that shape this design

1. **The backend authenticates nobody.**
   - All 83 tRPC procedures are `publicProcedure`, and no procedure reads `ctx`.
   - The actor is taken from request fields (`adderId`, `removerId`, `interruptedById`, `performerId`, `adminId`, `createdBy`, `modifiedBy`, `updatedBy`).
   - The socket.io handshake trusts `query.type === "telegram"`.
   - The backend has a public URL (`PUBLIC_URL=https://api.polinetwork.org`, with CORS for `/api/auth`). Whether the tunnel routes tRPC is not visible in git. This design does **not** assume network isolation.
2. **Authorization logic is duplicated in three places, and is incomplete.**
   - **Backend:** `CAN_ASSIGN`, `CAN_SELF_ASSIGN`, `CAN_ADD_BOT`, `CAN_MANAGE_GRANTS`.
   - **Bot:** per-command role lists, `BYPASS_ROLES`, `NETWORK_PRIVILEGED_ROLES`, message trust.
   - **Dashboard:** `ADMIN_ROLES`, `WRITE_ADMIN_ROLES`, web/group write roles.
   - **Unchecked entry points:** most writes, all Azure operations, decrypted message reads, the bot's report-menu buttons (including **Start BAN ALL**), `/getroles`, and `/userid`.
3. **The bot checks permissions very often.**
   - It looks up roles on almost every update, with no cache.
   - It also checks _targets_: ban-all immunity, campaign-spam exemption, message trust.
4. **Some bot actions have no human actor.**
   - Message and user ingestion.
   - Automatic moderation: link mute, campaign quarantine, campaign local ban and campaign ban-all. These act as `ctx.me`.
   - Group sync on `my_chat_member`.
   - Actions done in Telegram's own UI and observed through `chat_member`. Here the actor is a Telegram admin who may have no account anywhere.
5. **Group-admin status has two sources:** native Telegram status, or a `tg_group_admins` row.
6. **The current Telegram linking is weak.** It relies on a 6-digit code and a username match, with no attempt limit, and completes through a tRPC _query_ that writes. The IdP's link verifies Telegram's signed ID token.
7. **The IdP is close to what we need, but not configured for it.**
   - **OAuth plugin capabilities:**
     - client credentials (via a per-client `clientCredentialsScopes`);
     - `private_key_jwt`;
     - RFC 8707 resources (TTL caps, scope intersection, client linking);
     - JWT access tokens (`typ: at+jwt`), issued **only when a `resource` is requested**;
     - introspection, revocation, end-session, back-channel logout;
     - refresh-token rotation with family invalidation on reuse.
   - **Not supported:** RFC 8693 token exchange.
   - **Not enabled today:** client credentials (`grantTypes`) and resource administration (`resourcePrivileges: () => false`).
8. **Delegated role administration already exists.** A writer with `idp:roles:write` can only change roles whose effective permissions the writer already holds. They cannot touch managed roles such as `master-admin`, and cannot escalate themselves.
9. **`master-admin` implicitly holds every permission,** including permissions created later. It is granted through the Entra group `PN_ENTRA_OIDC_ADMIN_GROUP_ID` or a break-glass allowlist.
10. **Some IdP writes leave no audit trail:**
    - Telegram link and unlink;
    - OIDC client changes;
    - student verification.

    User deletion runs directly through Drizzle, so the provider's session hooks (and back-channel logout) don't run.

11. **polinet.cc freezes a user's role at login** in a 7-day encrypted cookie. It has no refresh and no re-check.

---

## 3. Key issues to solve

| #   | Issue                                                                                                                    | Why it matters                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | **People acting through the bot have no tokens.** An actor is just a Telegram ID inside an update.                       | The backend must resolve _Telegram ID → IdP user → permissions_ itself. That needs an authenticated IdP→backend channel.                                                |
| I2  | **Freshness vs. availability.**                                                                                          | Revocation must apply within seconds. The bot can't call the IdP synchronously on every message, and moderation must survive an IdP or Graph outage for a bounded time. |
| I3  | **Not every permission change is a database write.** Examples: Entra group membership, student-verification expiry.      | Change events alone can't be the whole solution. Polling and time-based expiry are required.                                                                            |
| I4  | **Old semantics the IdP can't express.** Examples: deny rules (`creator`), the single president, the direttivo 3–9 rule. | These are remodelled (§4), not ported.                                                                                                                                  |
| I5  | **Delegated administration.**                                                                                            | Some people must be able to grant Telegram roles without being IdP administrators.                                                                                      |
| I6  | **More than one place can write permissions.**                                                                           | Every write path outside the IdP has to go.                                                                                                                             |
| I7  | **Calls without authentication, and actors taken from the request.**                                                     | IdP permissions are pointless while anything can call `addRole({ adderId: <owner> })`.                                                                                  |
| I8  | **Calls with no human behind them.**                                                                                     | Automatic moderation and ingestion must keep working without a blanket bypass.                                                                                          |
| I9  | **Claims frozen in the dashboard.**                                                                                      | Permissions read once at login would stay valid long after revocation.                                                                                                  |
| I10 | **Five deployables use one API at different SDK versions.**                                                              | The cutover has to be incremental and reversible per caller.                                                                                                            |

---

## 4. Decisions and semantic changes

These are agreed. Reviewers should check their consequences, not reopen them.

1. **The IdP is the only source of global permissions.** The following are removed:
   - the tables `tg_permissions` and `tg_group_admins`;
   - the bot's `/addrole` and `/delrole`;
   - the backend's `addRole`, `removeRole`, `addGroup` and `removeGroup`;
   - role management in the dashboard.
2. **The bot keeps one shortcut: native Telegram admins.**
   - Selected commands may _also_ be used by a native administrator of that chat.
   - The logic lives **only in the bot**: nothing is stored, and no other system is involved.
   - The set is today's `allowGroupAdmins` commands (§10.2).
3. **Linking Telegram in the IdP plus holding the right IdP role is all it takes** to get bot permissions.
4. **Services check permissions, never roles.** Roles exist only inside the IdP, as bundles of permissions.
5. **Old role semantics are remodelled:**
   - **`creator` deny rule:** those people simply don't get the relevant permission.
   - **`BYPASS_ROLES` and `NETWORK_PRIVILEGED_ROLES`:** become `tg:immune`.
   - **Single-president and direttivo 3–9 rules:** dropped. Direttivo membership is managed in Entra.
   - **`tg_group_admins`:** replaced by decision 2.
6. **Grants stay a backend concept.** A grant is temporary trust for an arbitrary Telegram user, often someone with no IdP account, so it is data about Telegram users, not an IdP permission.
   - Creating and interrupting grants requires an IdP permission.
   - Existing grants are **not migrated**. The table is recreated, and any needed grants are re-entered by hand after cutover.
7. **Delegated administration separates editing from assignment.** `idp:roles:write` edits role definitions; `idp:roles:assign` assigns or revokes roles. Neither implies the other. Both use the IdP's bounded-delegation rules: no managed-role assignment, no assignment beyond the actor's effective permissions, and no self-escalation. The current combined endpoint checks must be split during implementation.
8. **Ban-all is authorized once, when it is queued.** A started ban-all runs to completion, and revocation does not stop it. Queue redesign is out of scope; the queue will move to the backend later.
9. **The dashboard has one Azure capability: create a socio.** A dedicated permission authorizes a backend workflow that creates an Entra user and adds only that newly created user to the fixed Soci group. The dashboard cannot browse or edit Entra users or groups through this migration, and cannot choose a group ID or existing user ID for this workflow. There is no `AZURE_WRITABLE_GROUPS` dashboard policy.
10. **Master Admin holds the entire permission catalog.** This includes all current and future Telegram permissions, with no namespace exclusion or scoped variant.
11. **Role grants are runtime configuration.** Administrators choose and change which permissions each role grants in the IdP. No service authorizes by role name. The migration does not prescribe Web Team or HR Telegram grants.

### 4.1 Permission catalog

Permissions follow the convention `<namespace>:<object>[:<action>]`. This is the frozen migration catalog; grants to roles remain configurable at runtime (§4.2).

| Permission             | Meaning                                                                                                                                                 | Replaces                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `admin:access`         | Can open the dashboard                                                                                                                                  | `ADMIN_ROLES`                                 |
| `tg:moderate`          | ban/tban/kick/mute/tmute/unban/unmute in any network chat; report-menu Kick/Ban                                                                         | owner/direttivo moderation                    |
| `tg:moderate:global`   | `/ban_all`, `/unban_all`, report-menu "Start BAN ALL", campaign review Confirm/Release                                                                  | owner/direttivo                               |
| `tg:messages:delete`   | `/del`, report-menu Del                                                                                                                                 | `admin`, owner, direttivo                     |
| `tg:messages:pin`      | `/pin`, `/unpin`                                                                                                                                        | direttivo, owner                              |
| `tg:immune`            | Ban-all target immunity; campaign-spam exemption. **Implies `tg:trusted`.**                                                                             | `BYPASS_ROLES`, `NETWORK_PRIVILEGED_ROLES`    |
| `tg:trusted`           | Message trust (auto-moderation whitelist), hashtag-rule exemption                                                                                       | "has any role" checks                         |
| `tg:audit:read`        | `/audit`, audit history in the dashboard                                                                                                                | hr, owner, direttivo                          |
| `tg:users:read`        | Telegram user list and details, `/userid`                                                                                                               | `ADMIN_ROLES`                                 |
| `tg:messages:read`     | Read stored (decrypted) messages in the dashboard                                                                                                       | `ADMIN_ROLES` (today, unchecked)              |
| `tg:groups:manage`     | `/updategroup`, `/regenerate_group_links`, hide or leave a group                                                                                        | owner, direttivo, `web` (group write)         |
| `tg:bot:add`           | May add the bot to a group                                                                                                                              | `CAN_ADD_BOT`                                 |
| `tg:grants:read`       | View grants                                                                                                                                             | `ADMIN_ROLES`                                 |
| `tg:grants:manage`     | Create and interrupt grants                                                                                                                             | `CAN_MANAGE_GRANTS`                           |
| `wa:groups:manage`     | WhatsApp group CRUD                                                                                                                                     | group write roles                             |
| `groups:labels:write`  | Group label CRUD and tagging                                                                                                                            | web write roles                               |
| `web:content:write`    | Associations, FAQs, projects, freshman guides                                                                                                           | web write roles                               |
| `web:reports:manage`   | Resolve or dismiss group-link reports                                                                                                                   | group write roles                             |
| `azure:members:create` | Create a new socio through the backend's fixed Entra workflow. Includes adding only the newly created user to Soci; no arbitrary group or user editing. | New dedicated capability                      |
| `idp:roles:assign`     | Assign or revoke an unmanaged role within bounded delegation; independent of `idp:roles:write`                                                          | Assignment half of existing `idp:roles:write` |

Existing IdP permissions remain in the catalog: `membership:read`, `student:verified`, `idp:people:read`, `idp:users:read`, `idp:users:delete`, `idp:permissions:read`, `idp:permissions:write`, `idp:roles:read`, `idp:roles:write`, `idp:applications:read` and `idp:applications:write`. `idp:roles:write` now authorizes role-definition changes only. `idp:roles:assign` implies `idp:roles:read` and `idp:people:read` so its holder can identify the role and person, but does not imply `idp:roles:write`; write does not imply assign. Review existing role writers before cutover and grant assignment separately where intended. `azure:members:read`, `azure:members:write` and `azure:groups:write` are excluded from this migration catalog.

### 4.2 Runtime role policy and migration of old holders

The migration freezes **how roles work**, not a role-to-permission grant matrix. The IdP is the sole source of global permissions. Administrators may edit grants at runtime, and the backend, bot and dashboard check permission keys rather than role names. Master Admin retains its existing catalog-wide wildcard. Membership in the managed roles `socio`, `direttivo` and `student` continues to come from trusted evidence; those roles' grants remain editable in the IdP. Unmanaged roles may be created and assigned with bounded delegation. No role inherits Master Admin.

The legacy names `owner`, `president`, `direttivo`, `hr`, `admin`, `web` and `creator` are **migration inventory**, not automatic IdP assignments. Export their holders in Phase 2, have each person link Telegram in the IdP, then choose and review grants and assignments there. _Telegram Owners_, _HR_, _Telegram Helpers_, _Web Team_ and _Telegram Moderators_ are possible role names, not required bundles. In particular, this RFC does not decide whether Web Team receives `tg:groups:manage` or HR receives `tg:bot:add`. The `creator` deny rule becomes absence of a relevant permission (§4 decision 5). Before switching a caller, compare each legacy holder's effective decisions with the configured IdP snapshot and resolve differences by hand.

---

## 5. Getting permissions from the IdP to the backend

### 5.1 Options considered

**A. On-demand lookups with a cache.** The backend asks the IdP per Telegram ID and caches the answer for 30–60 s.

- ✅ Simplest.
- ❌ Revocation lag equals the cache TTL.
- ❌ Hard dependency on the IdP whenever the cache misses.
- ❌ Every unknown sender misses the cache.

**B. Per-user events into a local copy.**

- ✅ Fast local reads.
- ❌ Changing a role's permissions fans out to every holder.
- ❌ Entra and expiry changes produce no events, so reconciliation is needed anyway.

**C. Full snapshot replication, nudged by events (chosen).** The number of people holding backend-relevant permissions is tiny (tens to hundreds), so the backend copies the **whole** relevant list.

- ✅ Lookups are memory reads. This covers actor checks, target checks and per-message trust.
- ✅ No fan-out problem.
- ✅ Events carry no data, so losing, duplicating or reordering them is harmless.
- ✅ Survives an IdP outage for a bounded time.
- ❌ Doesn't scale to "everyone has permissions". That isn't our situation.

**D. Tokens only (rejected).** Every Telegram admin would log in through the bot, and the bot would store their refresh tokens.

- ❌ Poor UX.
- ❌ Stores per-person secrets.
- ❌ Doesn't cover checks on targets.

### 5.2 Projections: which data a service may read

A **projection** is a named, admin-controlled view of the access data. It is defined in the IdP as configuration (reviewed by pull request), and lists:

- which **clients** may pull it;
- which **permission prefixes** it contains;
- which **identity fields** it includes (for example, the Telegram ID).

```ts
// auth: access projection registry (illustrative)
export const ACCESS_PROJECTIONS = {
  backend: {
    clients: ["backend"],
    prefixes: ["admin:", "tg:", "wa:", "groups:", "web:", "azure:"],
    fields: ["telegramId"],
  },
} as const;
```

- The snapshot endpoint selects the projection from the **authenticated `client_id`** of the bearer token. It never uses a request parameter.
- A client that isn't listed gets `403`.
- A subject is included only if it holds at least one permission in the projection.

### 5.3 Snapshot schema (v1)

```http
GET /api/internal/access-snapshot           (auth, in-cluster)
Authorization: Bearer <backend's client-credentials token, aud=<IdP internal resource>, scope=idp:access:read>
If-None-Match: "sha256-9f1c…"
```

```json
{
  "schema": "polinetwork.access-snapshot/v1",
  "projection": "backend",
  "generation": 4813,
  "builtAt": "2026-10-07T10:15:02Z",
  "sources": {
    "rbac": { "health": "ok", "observedAt": "2026-10-07T10:15:02Z" },
    "entra:direttivo": { "health": "ok", "observedAt": "2026-10-07T10:14:31Z" },
    "entra:soci": {
      "health": "degraded",
      "observedAt": "2026-10-07T09:52:10Z",
      "error": "graph_timeout"
    },
    "polimi-email": { "health": "ok", "observedAt": "2026-10-07T10:15:02Z" }
  },
  "subjects": [
    {
      "sub": "usr_8f2a",
      "telegramId": "123456789",
      "permissions": {
        "tg:moderate": { "validUntil": null },
        "tg:moderate:global": { "validUntil": "2026-10-07T11:14:31Z" }
      }
    },
    {
      "sub": "usr_luca",
      "telegramId": null,
      "permissions": {
        "admin:access": { "validUntil": null },
        "tg:grants:manage": { "validUntil": null }
      }
    }
  ]
}
```

**Each permission carries its own `validUntil`.**

- One person can hold the same permission through several paths. The IdP computes a validity for each path and publishes the **latest** one, where `null` means it does not expire.

| Path                                                   | Path validity                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Manual role assignment (`user_role`)                   | `null`. Assignments have no expiry.                                                                                                                                                  |
| Student verification (`identity_evidence.valid_until`) | That timestamp                                                                                                                                                                       |
| Entra-derived managed role (`socio`, `direttivo`)      | `observedAt` of that group's membership + `ENTRA_GRACE` (1 h)                                                                                                                        |
| `master-admin`                                         | Configured break-glass user ID: `null`; Entra administrators group: that group's membership `observedAt` + `ENTRA_GRACE` (1 h). The catalog-wide wildcard includes every permission. |

- The backend drops a permission locally when `now ≥ validUntil`, even if no new snapshot arrives. This one mechanism handles both student expiry and Entra staleness. A permanent right is never removed because an unrelated path expired.

**`telegramId` comes from the linked Telegram account,** not from the evidence row's validity.

- The evidence row's `valid_until` is the Telegram ID token's `exp`. It must not make the link expire.
- The IdP reads the Telegram ID only through an existing `account` row.

**The schema is versioned** through `schema`. A consumer rejects a major version it doesn't know. Adding fields is backward-compatible.

### 5.4 Freshness, health and outages

**On the IdP side, Entra membership** is read per group when the snapshot is built.

- Each successful read is stored with its `observedAt` in a small table, `entra_group_observation`.
- **If Graph fails:**
  - the IdP uses the last stored membership for that group;
  - it does **not** move `observedAt` forward;
  - it marks the source `degraded`.

  A failed read never becomes an empty group. Those paths then expire naturally through `ENTRA_GRACE`.

- **Cold start:** if a group has never been observed, its paths are absent. That fails closed for those permissions only.

This is a deliberate difference from the IdP's interactive login path, where a Graph failure grants nothing. For moderation we prefer bounded last-known-good data over a sudden revocation of everyone.

**On the backend side,** the snapshot client records `lastSyncAt`: the time of the last `200` or `304` from the IdP.

- **Privileged decisions** are allowed only while `now − lastSyncAt ≤ MAX_STALE` (1 h). Past that, every permission check fails closed.
- **Unaffected by staleness:**
  - the bot's native-admin shortcut, which never touches the backend;
  - service-only operations such as ingestion, which depend only on a valid service token.
- **Per-permission `validUntil`** is always enforced, whatever the sync state.
- **Persistence:** the backend stores the last good snapshot and `lastSyncAt` in its own Postgres. After a restart during an IdP outage it resumes from that copy, and the same staleness rule applies.
- **Cold start with no stored snapshot:** every permission check fails closed until the first successful pull.

**200 vs 304:**

- The ETag is a hash of the **entire** response body, including `generation`, `builtAt` and source timestamps.
- `304` is returned only for a byte-identical body. A fresh Graph observation therefore yields a `200`, so stale data can never look fresh.
- The body is a few kilobytes, so frequent `200`s cost nothing meaningful.

### 5.5 Refresh discipline

- **Single-flight.** The backend runs at most one pull at a time. A trigger that arrives during a pull sets a "pull again" flag, so the backend never applies an older response after a newer one.
- **Atomic swap.** Each response is parsed into one immutable object containing the `sub → subject` and `telegramId → subject` indexes. The object is validated, then swapped in with a single reference assignment. Readers never see a half-applied snapshot.
- **Validation before swap:**
  - the schema version is known;
  - no duplicate `sub`;
  - no duplicate `telegramId`.

  If validation fails, the backend keeps the old snapshot and raises an alert.

- **`generation`** is a monotonic counter in the IdP. It increments whenever a projection's content hash changes. It is used **only** for logs and metrics, never to accept or reject data. A database restore that resets it can therefore never cause updates to be ignored; the backend logs the regression and accepts the IdP's state.
- **Polling interval:** 30 s (illustrative).

### 5.6 Change notifications (push)

**Outbox through database triggers.** In the IdP's database, a trigger on every table that feeds the snapshot inserts one row into `access_outbox` in the same transaction as the change. Triggers catch every write path, including direct Drizzle writes such as user deletion.

| Table                                    | Changes covered                                               |
| ---------------------------------------- | ------------------------------------------------------------- |
| `user_role`                              | assign, unassign                                              |
| `role`, `role_parent`, `role_permission` | role definitions, inheritance                                 |
| `permission`, `permission_implication`   | catalog, implications                                         |
| `account` (provider `telegram`)          | Telegram link and unlink                                      |
| `identity_evidence`                      | student verification, evidence changes                        |
| `user`                                   | user deletion                                                 |
| `entra_group_observation`                | a changed Entra membership (only when the member set differs) |

- Time-driven changes (expiry) need no event: the backend enforces `validUntil` locally.
- **Dispatcher.** A loop in the IdP coalesces pending outbox rows and sends one Security Event Token (RFC 8417, push delivery per RFC 8935) to each projection's endpoint.

```http
POST http://backend-service.backend.svc:3000/internal/events      (illustrative address)
Content-Type: application/secevent+jwt

eyJ0eXAiOiJzZWNldmVudCtqd3QiLCJhbGciOiJFZERTQSIsImtpZCI6Ii4uLiJ9…
  → { "iss": "https://auth.polinetwork.org/api/auth",
      "aud": "https://backend.internal.polinetwork.org",
      "jti": "evt_01J…", "iat": 1791200130,
      "events": { "https://schemas.polinetwork.org/events/access-changed": { "projection": "backend" } } }
```

- **Receiving the event.** The backend:
  1. verifies the SET with the IdP's keys, requiring `typ: secevent+jwt`;
  2. runs (or joins) a single-flight pull;
  3. replies `202` only after the pull completes, with a short timeout;
  4. on failure, replies `5xx`, and the dispatcher retries with backoff.
- **Push is best-effort; polling is authoritative.** A lost event delays a change by at most one poll interval.
- **Revocation lag:**

| Change                                                | Expected lag                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Change made in the IdP (role, link, unlink, deletion) | About 1 s                                                         |
| Entra membership change                               | Up to one Graph read cycle + one poll interval                    |
| Student verification expiry                           | None (local `validUntil`)                                         |
| IdP down                                              | Last good data, until `MAX_STALE`, then privileged checks deny    |
| Dashboard users                                       | Same as above. The backend checks the snapshot, not token claims. |

---

## 6. Service authentication

### 6.1 Model

Each component has one or more standard OAuth roles:

| Component         | Authorization server | Client                  | Resource server     |
| ----------------- | -------------------- | ----------------------- | ------------------- |
| `auth`            | ✅                   |                         | ✅ (internal API)   |
| `backend`         |                      | ✅ (pulls the snapshot) | ✅                  |
| `telegram` bot    |                      | ✅                      |                     |
| `admin` dashboard |                      | ✅ (logs users in; BFF) |                     |
| `web`             |                      | ✅                      |                     |
| future service    |                      | ✅                      | ✅ if it has an API |

**Actor kinds.** Every backend request resolves to exactly one actor:

```ts
type Actor =
  | { kind: "service"; client: string } // automatic work, no person
  | { kind: "telegram"; client: string; telegramId: string; sub: string | null } // bot acting for a Telegram user
  | { kind: "user"; client: string; sub: string; telegramId: string | null }; // dashboard user (OIDC)
```

**Rule 1: scopes limit the application; permissions limit the person.**

- Every operation lists the actor kinds it accepts.
- `service` operations are authorized by **scope alone**. Ingestion and group sync are examples.
- `telegram` and `user` operations require the scope **and** the person's permission in the snapshot. A `telegram` actor with no linked IdP account (`sub: null`) holds no permissions.

**Rule 2: tokens say who is calling; the backend decides.** The backend reads current permissions from the snapshot, never from claims inside a token.

**Recorded fields are kept separate.** Audit and state tables store each of these on its own:

- the **executing client** (`client`);
- the **human actor** (`sub` and/or `telegramId`, either nullable);
- the **basis** of the decision;
- the **target**.

### 6.2 Scopes

| Scope                    | Meaning                                                                                          | Granted to                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| `backend:admin`          | User-delegated dashboard calls                                                                   | `admin-dashboard` (user tokens) |
| `backend:public:read`    | Public website data                                                                              | `website`                       |
| `backend:tg:read`        | Lookups the bot needs: groups, users, messages for moderation, `tg.access.resolve`, grant status | `telegram-bot`                  |
| `backend:tg:ingest`      | Store messages and users                                                                         | `telegram-bot`                  |
| `backend:tg:groups:sync` | Upsert or delete group rows                                                                      | `telegram-bot`                  |
| `backend:tg:audit`       | Record moderation events                                                                         | `telegram-bot`                  |
| `backend:tg:act-as`      | May assert a Telegram actor (`X-PN-Actor`)                                                       | `telegram-bot`                  |
| `backend:tg:events`      | Connect to the socket.io channel                                                                 | `telegram-bot`                  |
| `idp:access:read`        | Pull the access snapshot                                                                         | `backend`                       |

### 6.3 The bot acting for a Telegram user: trust model

Only the bot knows who sent a Telegram update. The bot asserts the actor with a header, and only a token with `backend:tg:act-as` may do so:

```http
POST http://backend-service.backend.svc:3000/api/trpc/tg.access.resolve     (illustrative)
Authorization: Bearer <bot's service token>
X-PN-Actor: telegram:123456789

{ "telegramIds": ["123456789", "987654321"] }
```

```json
{
  "123456789": {
    "sub": "usr_8f2a",
    "permissions": ["tg:moderate", "tg:moderate:global"],
    "grant": null
  },
  "987654321": { "sub": null, "permissions": [], "grant": { "validUntil": "2026-10-20T00:00:00Z" } }
}
```

**This is the trusted-subsystem model. It does not protect against a compromised bot.**

- A compromised bot can assert any Telegram ID, including a grant manager's.
- It already controls every group through its bot token.
- The backend's checks on `telegram` actors stop an **honest** bot from acting for an unauthorized person. They don't stop a malicious one.

Containment therefore comes from **limiting what the bot's scopes can reach at all**:

- **Allowed through act-as or service scopes:** moderation-related records, lookups, and _de-escalating_ writes (interrupting a grant).
- **User token only** (`kind: "user"`). A stolen bot key cannot do these:
  - creating grants;
  - any Azure/Entra operation;
  - website content;
  - group visibility and leave;
  - reading stored messages for arbitrary users through dashboard procedures.

Section 8 marks each operation accordingly.

**Why a header instead of RFC 8693 token exchange:**

- The plugin doesn't support token exchange.
- It would add an IdP round trip per actor.
- It covers only the actor, not targets.

It can be added later without changing `ctx.actor`.

### 6.4 Token verification in the backend

```ts
// backend: request context (illustrative)
const claims = await jwtVerify(token, keyStore.getKey, {
  issuer: ISSUER, // "https://auth.polinetwork.org/api/auth"
  audience: BACKEND_RESOURCE, // membership check: aud may be an array (see §7.2)
  typ: "at+jwt",
  algorithms: ["EdDSA"],
  requiredClaims: ["exp", "iat", "sub", "client_id", "scope", "jti", "pn_subject_type"],
  clockTolerance: 30,
  maxTokenAge: "2h",
});

const scopes = new Set(claims.scope.split(" "));
let actor: Actor;
switch (
  claims.pn_subject_type // explicit claim emitted by the IdP (§7.4)
) {
  case "client":
    if (claims.sub !== claims.client_id) throw UNAUTHORIZED;
    actor = { kind: "service", client: claims.client_id };
    break;
  case "user":
    if (claims.sub === claims.client_id) throw UNAUTHORIZED;
    actor = {
      kind: "user",
      client: claims.client_id,
      sub: claims.sub,
      telegramId: snapshot.bySub(claims.sub)?.telegramId ?? null,
    };
    break;
  default:
    throw UNAUTHORIZED;
}

const asserted = req.header("X-PN-Actor"); // "telegram:123456789"
if (asserted) {
  if (actor.kind !== "service" || !scopes.has("backend:tg:act-as")) throw FORBIDDEN;
  const telegramId = parseTelegramActor(asserted); // strict: /^telegram:\d{1,20}$/
  actor = {
    kind: "telegram",
    client: actor.client,
    telegramId,
    sub: snapshot.byTelegram(telegramId)?.sub ?? null,
  };
}
return { actor, scopes, can: (perm) => snapshot.has(actor, perm) }; // false when stale or no sub
```

**Token-type separation:**

- bearer tokens must be `typ: at+jwt`;
- the events endpoint accepts only `typ: secevent+jwt`;
- back-channel logout tokens (if used) are `logout+jwt`.

None can be replayed as another.

### 6.5 Signing keys: last-known-good policy

`jose`'s `createRemoteJWKSet` reloads the key set once its cache expires (10 min by default). It then fails if the IdP is unreachable, even for a known `kid`. We use a small custom key store instead (part of `auth-kit`, §14.1):

- **Background refresh:** every 10 min (illustrative). A successful fetch replaces the key set and is persisted to the backend's database together with `fetchedAt`.
- **Refresh failure:** the store keeps serving the last good key set while `now − fetchedAt ≤ KEYS_MAX_AGE` (proposed 24 h). Past that, verification fails closed.
- **Unknown `kid`:** triggers one immediate fetch, rate-limited to once per 30 s. If the `kid` is still unknown, or the fetch fails, the token is rejected. **An unknown `kid` always fails closed.**
- **Cold start:** the store loads the persisted key set. If there is none and the IdP is unreachable, every authenticated request fails until the first fetch succeeds.
- **Key rotation in the IdP:**
  1. Configure rotation on the IdP's `jwt` plugin; today keys never rotate.
  2. Publish each new key before signing with it.
  3. Keep the old key until every token it signed has expired (at least the longest token TTL).

### 6.6 How long services survive an IdP outage

| Component                  | Survives                    | Limited by                                        |
| -------------------------- | --------------------------- | ------------------------------------------------- |
| Bot → backend              | 30–60 min                   | Service token lifetime (1 h, refreshed at 50%)    |
| Backend permission checks  | Up to `MAX_STALE` (1 h)     | Snapshot staleness rule                           |
| Backend token verification | Up to `KEYS_MAX_AGE` (24 h) | Key store                                         |
| Dashboard                  | About 5 min                 | User access-token lifetime: refresh needs the IdP |
| Native-admin shortcut      | Indefinitely                | Never touches the backend                         |

The bot's limit can be raised by lengthening `m2mAccessTokenExpiresIn`, at the cost of a longer window for a stolen service token.

---

## 7. IdP provisioning recipe

This recipe targets `@better-auth/oauth-provider` 1.7.2. Phase 0 (§13) exercised the OAuth behavior in a local Better Auth instance using the repository schema and a disposable database; decoded results and limits are in §7.4.

### 7.1 Plugin options

```ts
oauthProvider({
  // existing options unchanged…
  scopes: [
    "openid",
    "profile",
    "email",
    "offline_access",
    "polinetwork:identity",
    "backend:admin",
    "backend:public:read",
    "backend:tg:read",
    "backend:tg:ingest",
    "backend:tg:groups:sync",
    "backend:tg:audit",
    "backend:tg:act-as",
    "backend:tg:events",
    "idp:access:read",
  ], // client-credentials scopes must be listed here too
  grantTypes: ["authorization_code", "refresh_token", "client_credentials"],
  accessTokenExpiresIn: 300, // user tokens: unchanged
  m2mAccessTokenExpiresIn: 3600, // service tokens
  refreshTokenReuseInterval: 10, // sequential replay window; concurrent refresh still needs a BFF lock (§11)
  resources: [/* §7.2, seeded from config */],
  resourceSeedMode: "overwrite", // config is the source of truth, confirmed in Phase 0
  resourcePrivileges: ({ action, user }) =>
    ["read", "list", "link", "unlink"].includes(action) && isMasterAdmin(user),
  customAccessTokenClaims: async ({ user, scopes }) => ({
    pn_subject_type: user ? "user" : "client",
    ...(user ? await getOidcClaims(user.id, scopes) : {}),
  }),
});
```

### 7.2 Resources

| Identifier (`aud`)                          | `accessTokenTtl` | `refreshTokenTtl` | `allowedScopes`                                                                          |
| ------------------------------------------- | ---------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `https://backend.internal.polinetwork.org`  | 3600             | 604800            | `openid profile email offline_access backend:*` (all scopes in §6.2 starting `backend:`) |
| `https://auth.polinetwork.org/api/internal` | 300              | —                 | `idp:access:read`                                                                        |

The identifiers are names; they don't need to resolve. Rules this table follows, all taken from the plugin's behaviour:

- **Effective lifetime is a minimum.** It is `min(global-or-m2m TTL, scope TTL, resource TTL)`.
  - The resource TTL must be **at least** the M2M TTL, or it caps service tokens.
  - A resource TTL cannot _raise_ the 300 s user-token TTL.
- **`allowedScopes` filters the whole request.** The backend resource must therefore include `openid profile email offline_access`. Otherwise the dashboard loses its ID token and refresh token.
- **A JWT access token is issued only when `resource=` is present.** Without it the token is opaque and can't be verified offline. Every backend-bound authorization, refresh and client-credentials request must send `resource`.
- **With `openid`, `aud` becomes an array:** `[backend, …/oauth2/userinfo]`. The backend checks _membership_, which `jose` does for an array `aud`.
- **Client linking is enforced** (`enforcePerClientResources` defaults to true). Each client must be linked to the resources it uses.

### 7.3 Clients

| Client            | Type, authentication                                                | Grants                            | `clientCredentialsScopes` / requested scopes                                                                    | Linked resources |
| ----------------- | ------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `telegram-bot`    | confidential, `private_key_jwt`                                     | client_credentials                | `backend:tg:read backend:tg:ingest backend:tg:groups:sync backend:tg:audit backend:tg:act-as backend:tg:events` | backend          |
| `website`         | confidential, `private_key_jwt`                                     | client_credentials                | `backend:public:read`                                                                                           | backend          |
| `admin-dashboard` | confidential, `private_key_jwt` (or `client_secret_basic` at first) | authorization_code, refresh_token | `openid profile email offline_access backend:admin`; `enableEndSession: true`                                   | backend          |
| `backend`         | confidential, `private_key_jwt`                                     | client_credentials                | `idp:access:read`                                                                                               | IdP internal     |
| `polinet-cc`      | public, PKCE                                                        | unchanged                         | unchanged                                                                                                       | none             |

- **Scope rules:**
  - `clientCredentialsScopes` may not contain `openid`, `profile`, `email` or `offline_access`.
  - Setting `clientCredentialsScopes` requires the `clientPrivileges` action `configure-client-credentials-scopes`. Restrict that action to master-admin.
- **Client authentication:**
  - Clients authenticate with assertions signed with their own key (EdDSA or ES256), and the IdP stores only their public JWKS. The private key stays in that service's Key Vault secret.
  - Rotation: add the new public key to the client's JWKS, roll the service, then remove the old key.
- **Subject identifiers stay `public`.** No pairwise secret is configured. The dashboard's `sub` must equal the snapshot's `sub`.

### 7.4 Decoded Phase 0 tokens and observed behavior

These claims were issued on 8 October 2026 by `scripts/phase0-oauth-spike.ts`, running Better Auth and `@better-auth/oauth-provider` 1.7.2 with the repository's schema on a migrated, disposable local PostgreSQL database. The probe mirrors §7's grants, resources, TTLs, per-client links and token claim options. Its local issuer is not the production issuer. Client and user IDs are redacted; `kid`, `jti` and `sid` are omitted. It uses test-only email/password sign-in and skipped first-party consent, so real Entra login, interactive consent and deployed IdP configuration are outside this probe. The test clients share one ephemeral public key for convenience; production clients need distinct keys.

**Bot client credentials (`private_key_jwt`):**

```json
{
  "header": { "alg": "EdDSA", "typ": "at+jwt" },
  "claims": {
    "iss": "http://localhost:35440/api/auth",
    "sub": "<bot-client-id>",
    "client_id": "<bot-client-id>",
    "azp": "<bot-client-id>",
    "aud": "https://backend.internal.polinetwork.org",
    "scope": "backend:tg:read backend:tg:ingest backend:tg:groups:sync backend:tg:audit backend:tg:act-as backend:tg:events",
    "pn_subject_type": "client",
    "iat": 1791469087,
    "exp": 1791472687
  }
}
```

**Backend snapshot-pull client credentials (`private_key_jwt`):**

```json
{
  "header": { "alg": "EdDSA", "typ": "at+jwt" },
  "claims": {
    "iss": "http://localhost:35440/api/auth",
    "sub": "<backend-client-id>",
    "client_id": "<backend-client-id>",
    "azp": "<backend-client-id>",
    "aud": "https://auth.polinetwork.org/api/internal",
    "scope": "idp:access:read",
    "pn_subject_type": "client",
    "iat": 1791469087,
    "exp": 1791469387
  }
}
```

**Dashboard authorization code with PKCE and `resource` (`client_secret_basic` test client):**

```json
{
  "header": { "alg": "EdDSA", "typ": "at+jwt" },
  "claims": {
    "iss": "http://localhost:35440/api/auth",
    "sub": "<test-user-id>",
    "client_id": "<dashboard-client-id>",
    "azp": "<dashboard-client-id>",
    "aud": [
      "https://backend.internal.polinetwork.org",
      "http://localhost:35440/api/auth/oauth2/userinfo"
    ],
    "scope": "openid profile email offline_access backend:admin",
    "pn_subject_type": "user",
    "iat": 1791469087,
    "exp": 1791469387
  }
}
```

Observed access-token TTLs were **3600 / 300 / 300 seconds** for bot / dashboard / snapshot-pull. The dashboard refresh-token TTL was **604800 seconds** in persisted rows. The first refresh issued another access token with the same audience, scope and subject type and a new refresh token. Sequential reuse within 10 seconds returned the same successor refresh token. Reuse after 11 seconds returned `invalid_grant`, and the successor then also returned `invalid_grant`, consistent with family invalidation. **Concurrent refresh was unsafe:** this run returned `[400, 200]`; earlier runs also produced `[200, 200]` with different successor refresh tokens. The BFF needs a per-session, cross-replica single-flight lock (§11.2), and this behavior needs an integration test before the dashboard cutover.

Other checks: requesting an extra bot scope returned `invalid_scope`; a test client allowed both `backend:public:read` and `idp:access:read`, but the backend resource issued only `backend:public:read`; omitting `resource` returned an opaque token; and restarting the provider with `resourceSeedMode: "overwrite"` restored configured scopes after a local database edit. No bearer token, refresh token, secret or private key is recorded here.

### 7.5 New IdP endpoints and components

- **`GET /api/internal/access-snapshot`:**
  - bearer authentication: the IdP verifies its own JWT, with `aud` = the internal resource and scope `idp:access:read`;
  - projection chosen by `client_id` (§5.2);
  - schema §5.3; ETag per §5.4.
- **The `entra_group_observation` table** and its refresh, which reuses the existing paginated group listing.
- **The `access_outbox` table, its triggers and the SET dispatcher** (§5.6), signed with the IdP's key.
- **Client registry UI extensions:**
  - `private_key_jwt` with a JWKS;
  - client-credentials scopes;
  - resource links;
  - end-session flag.

  The current UI only creates `client_secret_basic` or public clients.

- **Projection registry:** configuration in the `auth` repository.

### 7.6 Other IdP fixes required by this design

- **The numeric Telegram ID must be unique across linked accounts.**
  1. `disconnectAccount` deletes the matching `identity_evidence` row when a Telegram account is unlinked; today it is left orphaned.
  2. Linking first removes orphaned evidence for that Telegram ID.
  3. A unique partial index is added on `identity_evidence(telegram_id) WHERE telegram_id IS NOT NULL`.
  4. As defense in depth, the snapshot builder excludes any duplicated Telegram ID and raises an alert.
- **Audit rows** (`rbac_audit_event`) for Telegram link/unlink, OIDC client changes and student verification. This is for traceability; the outbox does not depend on it.
- **User deletion:** additionally revokes the user's sessions through better-auth's adapter, so the provider's hooks and back-channel logout run. Authorization does not depend on this: the user disappears from the snapshot within about a second.
- **Documentation:** update the IdP README. It currently states that backend Telegram roles stay authoritative.

---

## 8. Backend enforcement table

Every tRPC procedure, HTTP route and socket event is listed. **Anything not listed is denied.**

**How deny-by-default is implemented:**

- Procedures are built only from a `policy({ actors, scope, permission })` builder that attaches metadata. The bare `t.procedure` is not exported.
- A test walks the router and fails if any procedure lacks a policy.
- At runtime, a middleware rejects any call whose procedure has no policy.

**Legend:**

- Actor kinds: **S** = service, **T** = Telegram actor via act-as, **U** = dashboard user.
- "—" in the Permission column means "scope only" (service operations).
- _Remove_ marks a procedure that disappears in Phase 5.

### 8.1 Telegram

| Procedure                                                                                                      | Actor       | Scope                                                       | Permission                                               | Notes                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `tg.access.resolve` _(new)_                                                                                    | S, T        | `backend:tg:read`                                           | —                                                        | Returns `{sub, permissions, grant}` per Telegram ID. Used for actor and target checks.        |
| `tg.permissions.*` (getRoles, getDirettivo, addRole, removeRole, checkGroup, addGroup, removeGroup, canAddBot) | —           | —                                                           | —                                                        | _Remove._ Replaced by `tg.access.resolve`, `me.access` and IdP role management.               |
| `tg.link.link`                                                                                                 | —           | —                                                           | —                                                        | _Remove._                                                                                     |
| `tg.grants.checkUser`                                                                                          | S / U       | `backend:tg:read` / `backend:admin`                         | — / `tg:grants:read`                                     |                                                                                               |
| `tg.grants.getOngoing`, `getScheduled`                                                                         | U           | `backend:admin`                                             | `tg:grants:read`                                         |                                                                                               |
| `tg.grants.create`                                                                                             | **U only**  | `backend:admin`                                             | `tg:grants:manage`                                       | Escalating write; act-as is not accepted. Actor comes from `ctx`.                             |
| `tg.grants.interrupt`                                                                                          | T, U        | `backend:tg:act-as` / `backend:admin`                       | `tg:grants:manage`                                       | De-escalating write; the bot's 🛑 button. Actor comes from `ctx`.                             |
| `tg.auditLog.record` _(replaces `create`)_                                                                     | S           | `backend:tg:audit`                                          | —                                                        | Records what already happened (§9.2). No permission re-check.                                 |
| `tg.auditLog.getById`                                                                                          | S, T / U    | `backend:tg:read` / `backend:admin`                         | — (S, automatic campaign check) · `tg:audit:read` (T, U) |                                                                                               |
| `tg.messages.add`                                                                                              | S           | `backend:tg:ingest`                                         | —                                                        |                                                                                               |
| `tg.messages.get`, `getLastByUser`                                                                             | S / U       | `backend:tg:read` / `backend:admin`                         | — / `tg:messages:read`                                   | S: auto-moderation and ban cleanup.                                                           |
| `tg.users.add`                                                                                                 | S           | `backend:tg:ingest`                                         | —                                                        |                                                                                               |
| `tg.users.get`, `getByUsername`                                                                                | S / U       | `backend:tg:read` / `backend:admin`                         | — / `tg:users:read`                                      |                                                                                               |
| `tg.users.getAll`                                                                                              | U           | `backend:admin`                                             | `tg:users:read`                                          |                                                                                               |
| `tg.groups.getAll`, `getById`, `getByInviteLink`, `getByTag`                                                   | S / U       | `backend:tg:read` / `backend:admin`                         | — / `admin:access`                                       |                                                                                               |
| `tg.groups.search`                                                                                             | S / U / web | `backend:tg:read` / `backend:admin` / `backend:public:read` | — / `admin:access` / —                                   | `showHidden` is forced to false unless the actor is U.                                        |
| `tg.groups.create` (upsert)                                                                                    | S           | `backend:tg:groups:sync`                                    | —                                                        | `my_chat_member` sync, `/updategroup`, link regeneration. The human check happens in the bot. |
| `tg.groups.delete`                                                                                             | S           | `backend:tg:groups:sync`                                    | —                                                        | Bot removed or demoted.                                                                       |
| `tg.groups.setHide`                                                                                            | U           | `backend:admin`                                             | `tg:groups:manage`                                       |                                                                                               |
| `tg.groups.leaveChat`                                                                                          | U           | `backend:admin`                                             | `tg:groups:manage`                                       | Performer comes from `ctx`.                                                                   |
| `tg.groupLabels.*`                                                                                             | —           | —                                                           | —                                                        | _Remove_ this duplicate mount; use `groups.labels.*`.                                         |

### 8.2 Groups, WhatsApp, web, Azure, misc

| Procedure                                                                                                                            | Actor   | Scope                                   | Permission             | Notes                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------- | --------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `groups.labels.getAll`                                                                                                               | U       | `backend:admin`                         | `admin:access`         |                                                                                                                                                                                                                                                                                         |
| `groups.labels.create`, `modify`, `delete`, `tagGroup`, `untagGroup`                                                                 | U       | `backend:admin`                         | `groups:labels:write`  | `createdBy` / `updatedBy` come from `ctx`.                                                                                                                                                                                                                                              |
| `groups.search.getAll`, `search`, `getById`, `getByInviteLink`                                                                       | U       | `backend:admin`                         | `admin:access`         |                                                                                                                                                                                                                                                                                         |
| `wa.groups.getAll`, `getById`, `getByInviteLink`                                                                                     | U       | `backend:admin`                         | `admin:access`         |                                                                                                                                                                                                                                                                                         |
| `wa.groups.add`, `modify`, `delete`, `setHide`                                                                                       | U       | `backend:admin`                         | `wa:groups:manage`     |                                                                                                                                                                                                                                                                                         |
| `web.*.getAll*`, `web.guides_matricole.getLatestGuide`                                                                               | web / U | `backend:public:read` / `backend:admin` | — / `admin:access`     |                                                                                                                                                                                                                                                                                         |
| `web.associations.*`, `web.faqs.*`, `web.projects.*`, `web.guides_matricole.*` (writes)                                              | U       | `backend:admin`                         | `web:content:write`    | `createdBy` / `modifiedBy` come from `ctx`.                                                                                                                                                                                                                                             |
| `web.reports.create`                                                                                                                 | web     | `backend:public:read`                   | —                      | Public form; add rate limiting. No current caller was found.                                                                                                                                                                                                                            |
| `web.reports.list`, `resolve`, `dismiss`                                                                                             | U       | `backend:admin`                         | `web:reports:manage`   |                                                                                                                                                                                                                                                                                         |
| `azure.members.create`                                                                                                               | U       | `backend:admin`                         | `azure:members:create` | Backend creates the Entra user, sets the profile and membership number, adds only that newly created user to the fixed Soci group and assigns licenses. Validate inputs, bind the group addition to the new user and audit the operation. No caller-supplied group or existing user ID. |
| `azure.members.getAll`, `azure.groups.getAll`, `azure.members.setAssocNumber`, `azure.groups.addMember`, `azure.groups.removeMember` | —       | —                                       | —                      | _Remove from the migrated dashboard._ These legacy paths get no dashboard permission in the new model; deny them after the caller cutover.                                                                                                                                              |
| `me.access` _(new)_                                                                                                                  | U       | `backend:admin`                         | —                      | The caller's own permissions, from the snapshot. Drives the dashboard UI.                                                                                                                                                                                                               |
| `auth.updateProfilePic`                                                                                                              | —       | —                                       | —                      | _Remove._ Profiles live in the IdP.                                                                                                                                                                                                                                                     |
| `test.dbQuery`, `test.dbInsert`                                                                                                      | —       | —                                       | —                      | _Remove_ (or mount only when `NODE_ENV !== "production"`).                                                                                                                                                                                                                              |

### 8.3 HTTP routes and socket.io

| Route / event                                                | Authentication                                                           | Notes                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `ALL /api/trpc/*`                                            | Bearer token (§6.4)                                                      | During migration, anonymous calls fall back to legacy behaviour (§13).                           |
| `POST /internal/events` _(new)_                              | SET signed by the IdP (`typ: secevent+jwt`, `aud` = backend)             |                                                                                                  |
| `GET /` (health)                                             | none                                                                     |                                                                                                  |
| `/api/auth/*` (better-auth)                                  | —                                                                        | _Remove_ in Phase 6.                                                                             |
| `/test/*`                                                    | —                                                                        | _Remove._                                                                                        |
| `ALL /ws/` handshake                                         | Bearer in `auth.token`; client `telegram-bot`; scope `backend:tg:events` | The backend disconnects the socket at token `exp`, and the bot reconnects with a fresh token.    |
| socket `logGrantCreate`, `logGrantInterrupt` (backend → bot) | —                                                                        | Payload actor becomes `{ sub, telegramId \| null, displayName }` instead of a numeric `adminId`. |
| socket `leaveChat` (backend → bot)                           | —                                                                        | `performer` gets the same actor shape.                                                           |
| socket `ban` (backend → bot)                                 | —                                                                        | _Remove_ (unused).                                                                               |
| All emits with ack                                           | —                                                                        | Add an ack timeout. Today a missing ack hangs the request forever.                               |

---

## 9. Backend changes

### 9.1 Authentication and context

- **Token verification:** the §6.4 verifier with the §6.5 key store, through `auth-kit`.
- **Snapshot client:** poll, events, persistence, validation and atomic swap (§5).
- **`ctx.actor` and `ctx.can()`;** every procedure goes through `policy()` (§8).
- **Actor fields removed from every input:** `adderId`, `removerId`, `interruptedById`, `performerId`, `adminId`, `createdBy`, `modifiedBy`, `updatedBy`, and the self `userId` of `auth.updateProfilePic`.
- **Azure creation boundary:** expose only `azure.members.create` to the migrated dashboard. The backend uses a fixed Soci group ID internally and adds only the user it just created. There is no dashboard group-write allowlist or arbitrary group-member API in the new model. During the compatibility phase, legacy anonymous callers stay on the logged legacy path until their cutover (§13).

### 9.2 Audit log

`tg_audit_log` gains these columns:

| Column            | Content                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `actor_sub`       | Nullable                                                                          |
| `actor_tg_id`     | Nullable; replaces `admin_id`                                                     |
| `client`          | The executing client, e.g. `telegram-bot`                                         |
| `basis`           | `idp_permission` · `telegram_chat_admin` · `automatic` · `telegram_ui` · `legacy` |
| `idempotency_key` | Unique                                                                            |

- Existing rows are kept with `basis = legacy` and `actor_tg_id = admin_id`.
- `tg.auditLog.record` is a service operation. It **records what has already happened** on Telegram, so it does not re-check the actor's permission. Rejecting it would only lose history.
- **Consistency check:** when `basis = idp_permission`, the backend resolves `actor_tg_id` against the snapshot and stores the resulting `actor_sub`. A mismatch (no such permission) is stored and flagged for review, not rejected.
- `idempotency_key` makes bot retries safe (§10.2).

### 9.3 Grants

- The new `tg_grants` table is created empty. The old one is archived and dropped in Phase 6 (decision 6).
- **Columns:**
  - `telegram_user_id`, `valid_since`, `valid_until`, `reason`;
  - `granted_by_sub` (not null), `granted_via_client`;
  - `interrupted_at` (nullable), `interrupted_by_sub`, `interrupted_by_tg_id`;
  - a CHECK that `valid_since < valid_until`.
- **"Active"** means `valid_since ≤ now < valid_until AND interrupted_at IS NULL`. Who interrupted is never used to decide whether the grant is active.

### 9.4 Other

- **Foreign keys that point to `tg_permissions.user_id`** must be converted before that table is dropped:
  - `web_*` `created_by_id` / `modified_by_id`;
  - `common_group_labels` `granted_by_id` / `modified_by_id`.

  Each becomes a plain `*_sub` text column, with the old Telegram ID kept in a `legacy_*_tg_id` column for history.

- **Cleanup (Phase 6):** remove better-auth (`src/auth`), the `auth_*` tables, `tg_link`, `tg_permissions`, `tg_group_admins` and the old grants table, after a backup.

---

## 10. Bot changes

### 10.1 Backend clients

```ts
// telegram/src/backend.ts (illustrative)
const tokens = serviceTokenSource({
  clientId: "telegram-bot",
  key: env.BOT_CLIENT_KEY,
  resource: BACKEND_RESOURCE,
  scopes: BOT_SCOPES,
});

export const serviceBackend = createBackendClient({ tokens }); // no actor
export const backendAs = (telegramId: number) =>
  createBackendClient({ tokens, actor: `telegram:${telegramId}` });

// grammY middleware: one actor-bound client per update. Never touch ctx.api (grammY's Telegram API).
bot.use(async (ctx, next) => {
  ctx.backend = ctx.from && !ctx.from.is_bot ? backendAs(ctx.from.id) : serviceBackend;
  await next();
});
```

- **Request-driven code** uses `ctx.backend`: commands, conversations, callback menus.
- **Helpers** (e.g. `Moderation`, `GroupManagement`) take a client **as a parameter**, instead of importing the module-level `api` singleton.
- **Background and buffered work** always uses `serviceBackend`:
  - the message/user storage flush;
  - the ban-all executor;
  - cron jobs;
  - startup checks.
- Because there is one client per update and batching stays inside that client, a batch never mixes actors.
- The socket.io client authenticates with the service token and reconnects on expiry.

### 10.2 Permission checks and auditing

- **Commands move to `requiredPermissions`.** They drop `allowedRoles` / `excludedRoles` and gain an optional `allowTelegramChatAdmins` flag (decision 2).
  - The check calls `ctx.backend.tg.access.resolve` for the actor, and for the target where relevant.
  - **Confirmed set** for `allowTelegramChatAdmins`: today's `allowGroupAdmins` commands, `/ban /tban /unban /kick /mute /tmute /unmute /del /pin /unpin`. This is a chat-local shortcut only.
- **Callback menus get the same checks** (none have them today):

| Menu / button                     | Requirement                           |
| --------------------------------- | ------------------------------------- |
| Report menu: Del                  | `tg:messages:delete`                  |
| Report menu: Kick, Ban            | `tg:moderate`                         |
| Report menu: Start BAN ALL        | `tg:moderate:global`                  |
| Campaign review: Confirm, Release | `tg:moderate:global`                  |
| Grants menu: interrupt            | `tg:grants:manage` (backend-enforced) |
| Grants menu: delete log message   | `tg:grants:manage`                    |

- **Target checks:**

| Check                   | Passes when the target has…                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| Ban-all immunity        | `tg:immune` (applies to _every_ ban-all entry point, not only `/ban_all`) |
| Campaign-spam exemption | `tg:immune` or an active grant                                            |
| Message trust           | native chat admin, `tg:trusted`, or an active grant                       |
| Hashtag-rule exemption  | `tg:trusted` or native chat admin                                         |

- **Bot permission changes:**
  - Adding the bot to a group requires the adder (`my_chat_member.from`) to have `tg:bot:add`; otherwise the bot leaves.
  - `/getroles` and `/userid` require `tg:users:read`.
- **Audit `basis` per case:**

| Case                                              | `basis`               |
| ------------------------------------------------- | --------------------- |
| Command passed through the IdP permission         | `idp_permission`      |
| Command passed through the native-admin shortcut  | `telegram_chat_admin` |
| Automatic moderation (`ctx.me`)                   | `automatic`           |
| `chat_member` observer (actions in Telegram's UI) | `telegram_ui`         |

- **Audit delivery:** each audit record goes to a bot-side outbox in the bot's Redis (AOF on). It carries an idempotency key and is retried with backoff until the backend accepts it. A backend outage delays audit entries but loses none.

### 10.3 Ban-all

- The permission check (`tg:moderate:global`, plus `tg:immune` on the target) runs **once, at enqueue**. The enqueue writes one audit record (`ban_all`) with the reporter's actor fields and basis. For campaign auto-ban-all, that is `automatic`.
- Executor jobs run as `serviceBackend` and are not re-checked. A started ban-all runs to completion (decision 8).

### 10.4 Removed

- **Commands:** `/addrole`, `/delrole`, `/link`.
- **Unused code:** the `api.test.dbQuery` startup check (replaced by a health call) and the unregistered test commands.

---

## 11. Dashboard changes (OIDC, backend-for-frontend)

The dashboard's server is a confidential OAuth client. Tokens **never reach the browser** (the BFF pattern from the IETF's guidance for browser-based apps).

### 11.1 Login

1. An unauthenticated request is redirected (`302`) to `/api/auth/oauth2/authorize` with:
   - `client_id=admin-dashboard`, `response_type=code`;
   - `scope=openid profile email offline_access backend:admin`;
   - `resource=<backend>`;
   - PKCE (S256), `state` and `nonce`.

   `state`, `nonce` and the PKCE verifier are stored in a short-lived (10 min), encrypted, `HttpOnly`, `SameSite=Lax` cookie scoped to the callback path. No server storage is needed before login.

2. The callback validates `state`, exchanges the code (with `resource`), and validates the ID token and `nonce`.
3. It creates a server-side session: tokens, ID-token `sid`, `sub`, display name, created-at and last-seen.
4. It sets an opaque session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, host-only, `__Host-` prefix.

### 11.2 Session contract

| Item                            | Proposed value                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session store                   | A dedicated small Redis in the `admin` namespace: 1 replica, `maxmemory-policy volatile-ttl`, all keys with a TTL. **Not** the shared `redis` instance, which is `noeviction` and also used by other services.                                                                                                                                                           |
| Absolute session lifetime       | 7 days (equal to the backend resource's `refreshTokenTtl`)                                                                                                                                                                                                                                                                                                               |
| Idle timeout                    | 24 h                                                                                                                                                                                                                                                                                                                                                                     |
| Access token                    | 5 min. Refreshed when it has less than 60 s left.                                                                                                                                                                                                                                                                                                                        |
| Refresh concurrency             | Per-session single-flight lock (`SET NX PX` in Redis, so it also works with more than one replica). Other requests wait for the result. The 10-second reuse interval replayed a completed refresh in Phase 0, but concurrent calls sometimes diverged or returned `invalid_grant`; it is not a concurrency guarantee. Test refresh races and crash/retry before cutover. |
| CSRF                            | All mutations are POST server functions. Require `Origin` = the dashboard origin (the same rule as the IdP's `api-guard`), plus `SameSite=Lax`.                                                                                                                                                                                                                          |
| Refresh fails (`invalid_grant`) | Destroy the session; redirect to login                                                                                                                                                                                                                                                                                                                                   |
| Redis down                      | Dashboard returns 503 (fails closed)                                                                                                                                                                                                                                                                                                                                     |
| IdP down                        | Existing sessions work until their access token expires (≤ 5 min), then return 503 until the IdP is back                                                                                                                                                                                                                                                                 |
| Logout                          | Delete the session, call `/oauth2/revoke` on the refresh token, redirect to `/oauth2/end-session` (client has `enableEndSession`)                                                                                                                                                                                                                                        |
| Disabled or deleted user        | Takes effect immediately for authorization: the user leaves the snapshot within about a second, and every backend call returns 403. The dashboard session object is cleaned up at the next refresh (≤ 5 min), because the IdP has deleted the tokens. Back-channel logout (§7.6) is optional.                                                                            |

### 11.3 Authorization in the UI

- The dashboard calls `me.access` once per request, or caches it for a few seconds per session. It hides what the user can't use.
- Enforcement is **always** in the backend. The dashboard's role constants and middlewares (`ADMIN_ROLES`, `writeAdminMiddleware`, …) become thin checks on `me.access` permissions.
- The ID token's claims are used only for display (name, email).

### 11.4 Removed

- The better-auth proxy (`/api/auth/*`) and the login page with email OTP and passkeys.
- The onboarding and link pages; a "link Telegram" button points to the IdP instead.
- The role and group-admin management dialogs.
- The account page's passkey and session management, which moves to the IdP.
- The profile-picture upload.

---

## 12. Operations and deployment

- **Addresses.** Services call each other through in-cluster Service DNS (e.g. `http://auth-service.auth.svc.cluster.local:3000`, `http://backend-service.backend.svc.cluster.local:3000`; illustrative).
  - Tokens are still validated against the **public** issuer `https://auth.polinetwork.org/api/auth`.
  - `private_key_jwt` assertions use the public token endpoint URL as `aud`.
  - All of these are configuration values, never derived from the request's `Host`.
- **Secrets.** Each client's private key is a separate Azure Key Vault secret, mounted only into that service through its `SecretProviderClass`. No secret is shared between services.
- **Network.** No NetworkPolicy exists today, although Calico is enabled on the cluster. This design does not depend on network isolation.
  - **Recommended hardening (Phase 6):** allow ingress to `backend` only from `admin`, `web`, `bot-ts` and `auth`, and to `auth`'s internal path only from `backend`.
  - Separately, remove any public tunnel route to the backend's tRPC and better-auth paths once they are no longer needed.
- **Availability.** Everything runs as one replica on a single node, so extra replicas would add no node-level failover. The outage limits in §6.6 are the real protection: the bot keeps moderating on cached keys, its cached token and the last snapshot.
- **Releases.** `@polinetwork/backend` is consumed by `telegram`, `admin` and `web` at different versions.
  - Phases 3–4 publish only **additive** SDK versions, so each caller upgrades independently.
  - Phase 5 is the one breaking release. All callers must be on the token-sending version first.
  - A release matrix (backend image, SDK version per caller) is kept in the migration tracking issue and pinned during Phase 5.
- **Monitoring and alerts:**

| Signal                                              | Alert when           |
| --------------------------------------------------- | -------------------- |
| Snapshot age (`now − lastSyncAt`)                   | > 5 min              |
| Snapshot validation failures                        | Any                  |
| Source health per Entra group                       | `degraded` > 15 min  |
| SET dispatch failures                               | Any sustained        |
| Key-store age                                       | > 1 h                |
| Legacy anonymous calls (by procedure)               | (tracked until zero) |
| Authorization denials (by procedure and permission) | Spike                |
| Audit records flagged `basis` mismatch              | Any                  |

---

## 13. Migration plan

The principle: **each caller moves independently, and each step can be rolled back by redeploying the previous image.**

- The backend enforces the new model on every request that carries a token.
- Requests without a token fall back to legacy behaviour while `LEGACY_ANONYMOUS=allow`. Each fallback is logged with its procedure name.
- When that log has been empty for a week, the fallback is switched off.

**Phase 0: spike and decisions (no production impact).**

- Run the IdP locally with the §7 configuration. Obtain:
  - a bot client-credentials token;
  - a dashboard code-flow token with `resource`;
  - a refresh, a parallel refresh, and a refresh after the reuse interval;
  - a snapshot-pull token.
- Attach the decoded tokens to this RFC.
- Confirm:
  - effective TTLs;
  - `aud` shapes;
  - scope intersection;
  - resource seeding mode;
  - family invalidation behaviour.
- Record Q1–Q8 in §16. Freeze the permission catalog (§4.1), the runtime role policy (§4.2) and the complete enforcement table (§8). Initial role grants remain administrator-chosen runtime configuration.

**Phase 1: IdP foundation (deployable; nothing uses it yet).**

- §7.1–§7.5: OAuth configuration, resources, scopes, the four new clients and their keys in Key Vault, the snapshot endpoint, the projection registry, Entra observation, outbox triggers and dispatcher.
  - The dispatcher retries harmlessly until the backend endpoint exists.
- §7.6 fixes:
  - Telegram ID uniqueness;
  - audit rows;
  - user-deletion revocation;
  - key rotation.

**Phase 2: people and roles in the IdP (can run in parallel with Phase 3).**

1. Create the permissions from §4.1, including `idp:roles:assign` and `azure:members:create`; implement the IdP's split role checks before assigning delegates. Review current `idp:roles:write` holders and grant `idp:roles:assign` separately where assignment should continue. Create whichever unmanaged roles administrators choose. No predefined role grant matrix is required.
2. Export the current `tg_permissions` and `tg_group_admins` holders.
3. Each holder logs into the IdP and links Telegram through the official login. **Old links are never imported.**
4. Configure grants and assign roles by hand under §4.2's runtime policy. Conflicts are reviewed by hand.
5. Reconciliation report: for every old role holder, compare the old role-based decision with the snapshot. This report drives the remaining re-linking.

**Phase 3: backend, compatible release.**

- Ship everything that is additive:
  - verifier, key store, snapshot client, `ctx.actor`, `policy()` on every procedure;
  - the new procedures (`tg.access.resolve`, `me.access`, `tg.auditLog.record`);
  - the new audit columns, the new grants table and the `/internal/events` endpoint;
  - socket token authentication, accepted when present;
  - the dedicated `azure.members.create` policy and denial of other Azure dashboard operations for token-bearing callers.
- Requests with a token are fully enforced, with actor fields ignored. Anonymous requests take the legacy path and are logged.
- Publish the additive SDK.

**Phase 4: move callers, one at a time.**

- **4a `web`:** service token. This is the smallest change and proves the M2M path in production.
- **4b `telegram`:**
  1. Service client, `ctx.backend`, socket authentication, audit outbox.
  2. For about one week, command and menu checks run in **shadow**: compute both the old and the IdP decision, act on the old one, log differences. Never act on the union.
  3. Then switch to IdP decisions.
  4. Remove `/addrole`, `/delrole`, `/link`.
- **4c `admin`:** OIDC with the BFF session, `me.access`, removed screens (§11). Its backend calls are now user tokens and fully enforced. This needs Phase 2 to be complete for dashboard users.

**Phase 5: enforce (one coordinated release).**

1. Set `LEGACY_ANONYMOUS=deny`.
2. Remove:
   - the actor fields from all inputs (`adderId`, `removerId`, `interruptedById`, `performerId`, `adminId`, `createdBy`, `modifiedBy`, `updatedBy`);
   - `tg.permissions.*`, `tg.link.*`, `tg.groupLabels.*`, `auth.*`, `test.*`, `/test/*`;
   - the socket's query-type identification.
3. Publish the breaking SDK.

**Rollback:** set `LEGACY_ANONYMOUS=allow` and redeploy the previous backend image.

**Phase 6: cleanup.**

- Back up, then convert the `tg_permissions` foreign keys (§9.4).
- Drop `auth_*`, `tg_link`, `tg_permissions`, `tg_group_admins` and the old grants table, and remove better-auth from the backend.
- Remove public tunnel routes the backend no longer needs, and add the NetworkPolicy.
- Publish the integration guide (§14).

---

## 14. Making this easy to extend

### 14.1 Shared library: `@polinetwork/auth-kit`

| Function                                                  | What it does                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `serviceTokenSource({ clientId, key, resource, scopes })` | Client credentials via `private_key_jwt`, with caching and refresh at 50% of the lifetime                                            |
| `createKeyStore({ issuer, persist })`                     | Last-known-good JWKS (§6.5)                                                                                                          |
| `verifyAccessToken(token, { audience, keyStore })`        | The §6.4 checks; returns `{ actor, scopes }`                                                                                         |
| `accessSnapshot({ projection, … })`                       | Polling, ETag, single-flight, validation, atomic swap, persistence, SET receiver, `has(actor, perm)` with `validUntil` and staleness |

### 14.2 Two integration levels

| Level                                | Example    | What you do                                                                                                                         | Revocation lag                                                                                                                                                                                       |
| ------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Simple app**                    | polinet.cc | Register a client. Request `polinetwork:identity`. Read `polinetwork_permissions` from the ID token or userinfo.                    | **Equal to the app's session lifetime**, unless the app re-reads userinfo or refreshes. polinet.cc today: up to 7 days. Recommended: re-check userinfo at least every 5 min, or keep sessions short. |
| **2. Service with a privileged API** | backend    | Register a client **and** a resource. Add a projection entry in the IdP config. Verify tokens and use the snapshot with `auth-kit`. | About 1 s (§5.6)                                                                                                                                                                                     |

### 14.3 Checklist for a new service (example: a room-booking app)

1. **Config pull request to `auth`:**
   - add the resource (`https://rooms.internal.polinetwork.org`), its scopes and TTLs;
   - add the scopes to the provider list;
   - add a projection (`prefixes: ["rooms:"]`) if it is a level-2 service.

   Review the pull request like any other change to authorization rules.

2. **In the IdP UI:**
   - create the permissions (`rooms:book`, `rooms:manage`) and attach them to roles;
   - register the client (`private_key_jwt` for servers, public with PKCE for single-page and native apps) and link it to the resource.
3. **Store the client's key** in Key Vault and mount it into the service.
4. **Add `auth-kit`** and write the service's enforcement table: deny-by-default, with a policy per operation.

Beyond step 1's configuration, the IdP needs no code changes.

---

## 15. Walkthrough: Giulia becomes a moderator, then loses it

1. **Giulia links Telegram.** She signs in at `auth.polinetwork.org` with Entra and links Telegram through the official login. A Telegram `account` row and an evidence row with `telegram_id = 555` are created. The trigger writes an outbox row, but she holds no permissions yet, so the snapshot doesn't change.
2. **She gets the role.** A delegated administrator holding `idp:roles:assign` and every permission currently granted by the chosen moderator role assigns it to her. The role's grants were configured in the IdP; its name is not an authorization check.
   1. The `user_role` trigger writes an outbox row, and the dispatcher sends `access-changed`.
   2. The backend pulls generation 4900.
   3. Within about a second, `555 → usr_g1` has `tg:moderate`, `tg:messages:delete`, `tg:messages:pin` and `tg:trusted`.
3. **She bans someone.** She runs `/ban` in a group where she isn't a Telegram admin.
   1. The bot calls `ctx.backend.tg.access.resolve(["555", target])`. The check passes and the target isn't a chat admin, so the bot bans.
   2. The bot records `tg.auditLog.record({ type: "ban", basis: "idp_permission", actorTgId: 555, … })`. The backend stores `actor_sub = usr_g1` and `client = telegram-bot`.

   Nothing happened in the dashboard.

4. **The role is removed.** Months later the `user_role` row is deleted, and the trigger, event and pull follow. Her next `/ban` is refused. If she had a dashboard tab open, her still-valid 5-minute token gets `403` on the next call, because the backend reads the snapshot.
5. **She unlinks Telegram.** This deletes the `account` row and its evidence row. The trigger fires, and `555` disappears from the snapshot. Only native-admin shortcut commands still work for her, in chats where she is a Telegram admin; those are recorded with `basis = telegram_chat_admin`.

---

## 16. Phase 0 decisions (Q1–Q8)

The owner confirmed these decisions on 8 October 2026. They settle the migration contract; role grants themselves remain runtime configuration.

| Question              | Decision                                                                                                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 — Master Admin     | The existing catalog-wide wildcard includes all current and future `tg:*` permissions. No scoped Master Admin or namespace exception.                                                                                                                 |
| Q2 — Delegation       | Separate `idp:roles:assign` from `idp:roles:write`. Assignment/revocation and definition editing remain independently grantable and bounded by effective authority.                                                                                   |
| Q3 — Freshness        | `MAX_STALE = 1 h` and `ENTRA_GRACE = 1 h`.                                                                                                                                                                                                            |
| Q4 — Native admins    | Keep precisely the current `allowGroupAdmins` command set as the bot's chat-local shortcut (§10.2).                                                                                                                                                   |
| Q5 — Service identity | Use IdP client credentials for service API calls, including backend → IdP snapshot pulls. IdP → backend change notices use IdP-signed security-event tokens (§5.6). Neither path uses Kubernetes ServiceAccount tokens as application authentication. |
| Q6 — Bot lookups      | The bot obtains access decisions through the backend. No direct IdP permission lookup or bot-side permission cache.                                                                                                                                   |
| Q7 — Azure            | The dashboard may create a socio through one dedicated backend operation and permission. The backend's fixed workflow adds the newly created user to Soci. No dashboard Azure browsing, existing-user editing or arbitrary group membership changes.  |
| Q8 — Role grants      | Administrators choose and change role permissions at runtime. The RFC does not hardcode Web Team, HR or other role grant lists.                                                                                                                       |

---

## 17. Adjacent findings (out of scope, reported for awareness)

- **ArgoCD allows anonymous access with `role:admin` as the default policy** (`terraform/modules/argocd/values/argo_cd.tftpl`). Anyone who can reach it can deploy arbitrary workloads, which would bypass everything in this RFC.
- **`azure.members.create` emails the generated initial password to any caller-supplied address.**
- **The bot's local `node_modules` is stale.** It has grammY 1.37 installed against a 1.46 lockfile. Not a production issue, but it affects local testing of Phase 4b.

---

## 18. Standards referenced

- RFC 6749: OAuth 2.0 (authorization code, client credentials, refresh)
- RFC 7636: PKCE
- RFC 7523: JWT client authentication (`private_key_jwt`)
- RFC 8707: Resource indicators (`resource=`, `aud`)
- RFC 9068: JWT profile for OAuth 2.0 access tokens (`typ: at+jwt`)
- RFC 8417: Security Event Token (SET)
- RFC 8935: Push-based delivery of SETs
- RFC 7009: Token revocation
- RFC 8693: Token exchange (future option, §6.3)
- OpenID Connect Core 1.0, RP-initiated logout, back-channel logout
- IETF draft: OAuth 2.0 for browser-based applications (BFF pattern)
