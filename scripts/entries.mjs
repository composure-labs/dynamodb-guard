/**
 * The one table of entry points: where each one's source lives, and which
 * peers it may load. eslint.config.mjs derives its import bans from it,
 * check-entries.mjs bundles every entry against it, and consumer-smoke.mjs
 * loads the peerless entries with no peers installed.
 *
 * Keys are `exports` subpaths. check-entries.mjs fails if they stop matching
 * `tshy.exports` or `typesVersions` in package.json.
 *
 * `src` must cover every file an entry owns. The root owns `src/core/`, the
 * code every entry may share.
 */
export const ENTRIES = {
  ".": { src: ["src/index.ts", "src/core/**/*.ts"], peers: [] },
  "./testing": { src: ["src/testing.ts", "src/testing/**/*.ts"], peers: [] },
  "./cdk": { src: ["src/cdk.ts", "src/cdk/**/*.ts"], peers: ["aws-cdk-lib", "constructs"] },
  "./eslint": { src: ["src/eslint.ts", "src/eslint/**/*.ts"], peers: ["eslint"] },
};

/** A peer and its subpaths, as `no-restricted-imports` patterns or esbuild externals. */
export const withSubpaths = (peers) => peers.flatMap((peer) => [peer, `${peer}/*`]);
