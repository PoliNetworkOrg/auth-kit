/**
 * Releases from `main` on every push, from Conventional Commit messages. See docs/releasing.md.
 * @type {import("semantic-release").GlobalConfig}
 */
export default {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        // 0.x: a breaking change bumps the minor version, never 1.0.0. Remove this rule to
        // release 1.0.0 with the next breaking change.
        releaseRules: [{ breaking: true, release: "minor" }],
      },
    ],
    "@semantic-release/release-notes-generator",
    "@semantic-release/npm",
    [
      "@semantic-release/github",
      {
        successComment: false,
        failCommentCondition: false,
        addReleases: "top",
      },
    ],
  ],
}
