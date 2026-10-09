# auth-kit

SDK for integrating new projects with PoliNetwork's identity provider (auth.polinetwork.org).

`@polinetwork/auth-kit` is the shared library from [the IdP migration RFC](./docs/idp-telegram-integration-rfc-v3.md) (§14.1). It runs on Node ≥ 20.19 and Bun. ESM only.

- [docs/contract.md](./docs/contract.md): the IdP behavior the SDK relies on.
- [docs/idp-adoption.md](./docs/idp-adoption.md): how the IdP can import the shared contract.
- [docs/releasing.md](./docs/releasing.md): automated releases and commit conventions.

| Export                                         | For                       | What it does                                                                          | Status      |
| ---------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- | ----------- |
| `idpEndpoints`, contract constants             | everyone                  | IdP URLs and the values fixed in the IdP's code                                       | ✅          |
| `@polinetwork/auth-kit/contract`               | the IdP                   | Constants, schemas, producer types and event claims only; no network clients         | ✅          |
| `serviceTokenSource`                           | bot, website, backend     | Client credentials with `private_key_jwt`, cached and renewed at 50% of the lifetime  | ✅          |
| `createKeyStore`                               | resource servers          | JWKS cache that keeps its last good key set during an IdP outage                      | ✅          |
| `verifyAccessToken`, `resolveActor`            | resource servers          | RFC §6.4 token checks, then the request's `Actor` (including `X-PN-Actor`)            | ✅          |
| `accessSnapshot`                               | resource servers          | Local copy of a projection: polling, ETag, single-flight, persistence, `MAX_STALE`    | ✅          |
| `createAccessEventHandler`                     | resource servers          | Fetch API receiver for the IdP's access-changed events                                | ✅          |
| `parseAccessSnapshot`, `AccessIndex`           | resource servers          | Validates a snapshot and answers lookups, enforcing `validUntil`                      | ✅          |
| `formatTelegramActor`, `parseTelegramActor`    | bot, backend              | The `X-PN-Actor: telegram:<id>` header                                                | ✅          |
| `Persistence`, `memoryPersistence`             | resource servers          | Storage interface for the last good key set and snapshot                              | ✅          |

## Development

```sh
pnpm install
pnpm test        # Vitest on Node
pnpm test:bun    # the same tests under Bun
pnpm typecheck
pnpm check       # Biome
pnpm build
```

`fixtures/` holds sample snapshots, valid and invalid, that follow [docs/contract.md](./docs/contract.md). They are published with the package so the IdP can test against the same files.
