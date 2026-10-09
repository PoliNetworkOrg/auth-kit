# Releasing

Every push to `main` runs [`release.yaml`](../.github/workflows/release.yaml). It checks the code, works out the next version from the commit messages with [semantic-release](https://semantic-release.gitbook.io), publishes to npm through trusted publishing, and creates a GitHub release. Nobody publishes by hand, and no npm token is stored.

This follows the `backend` repository's setup, with three differences:

| Difference                                | Why                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Breaking changes bump the minor version   | The package stays on `0.x` until the contract is tested against the deployed IdP (see below)          |
| Typecheck, tests and lint run before release | A red `main` never publishes                                                                       |
| Full git history is checked out           | semantic-release needs every tag and commit since the last release                                    |

## Commit messages

Versions come from [Conventional Commits](https://www.conventionalcommits.org) on `main`. With squash merges, the PR title is the commit message.

| Commit                                                  | Release while on `0.x` | Release from `1.0.0` |
| ------------------------------------------------------- | ---------------------- | -------------------- |
| `fix: …`                                                | patch                  | patch                |
| `feat: …`                                               | minor                  | minor                |
| `feat!: …` or a `BREAKING CHANGE:` footer               | minor                  | major                |
| `docs:`, `test:`, `chore:`, `ci:`, `refactor:`, …       | none                   | none                 |

Consumers depend on `^0.N.x`. For `0.x`, npm's caret already stays within one minor version, so a breaking minor release never reaches them without a dependency bump.

## One-time setup

Do these in order: pushing `main` starts a release immediately.

1. **Configure trusted publishing on npm** for `@polinetwork/auth-kit`: GitHub Actions, organization `PoliNetworkOrg`, repository `auth-kit`, workflow `release.yaml`, no environment. npm may only offer this setting for a package that already exists. In that case, publish a placeholder once by hand (`npm publish --access public` at version `0.0.0`), then add the trusted publisher, then disallow token-based publishing for the package.

2. **Check that the workflow may write to the repository.** It requests `contents: write` to push tags and create releases. This works unless the organization's Actions policy restricts workflow permissions.

3. **Push the baseline tag together with `main`.** Without a tag, semantic-release's first release is always `1.0.0`. The local tag `v0.0.0` marks the commit before the scaffold, so the first release becomes `0.1.0`:

   ```sh
   git push --atomic origin main v0.0.0
   ```

   If `main` is pushed without the tag, the release job publishes `1.0.0`.

A failed release does no harm: fix the setup and rerun the job.

## Going to 1.0.0

When the contract has been tested against the deployed IdP:

1. Remove the `releaseRules` entry from [`release.config.mjs`](../release.config.mjs).
2. Merge a commit with a `BREAKING CHANGE:` footer (it may be the same commit). semantic-release then publishes `1.0.0`.
