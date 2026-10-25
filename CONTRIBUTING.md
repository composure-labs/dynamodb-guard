# Contributing

Thanks for your interest. This package is **pre-release (0.x)** and its API is not settled yet, so we work **issue-first**: open an issue before a large pull request, and we'll agree on fit and approach before anyone writes code. Small, obvious fixes (typos, broken links, one-line bugs) are welcome as direct pull requests. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

The design and the plan for this package live in [laazyj/composureCDK#627](https://github.com/laazyj/composureCDK/issues/627#issuecomment-6389317138).

## Development setup

Prerequisites: **Node.js >= 22** for development (consumers need only Node >= 20), and **shellcheck** on your `PATH` if you change `.github/workflows/` (`brew install shellcheck`).

```sh
git clone https://github.com/composure-labs/dynamodb-guard.git
cd dynamodb-guard
npm ci
```

This is a single npm package, so `package.json` scripts are the task runner; there is no nx. Keep each script a plain command.

## Before you open a pull request

```sh
npm run verify          # every gate; the pre-push hook and CI's Verify job run it
npm run check:consumer  # pack, install as a consumer would, with and without peers
npx actionlint          # only if you changed .github/workflows/
```

Auto-fix with `npm run format` and `npx eslint . --fix`. If you change `.github/workflows/` or `dependabot.yml`, CI also runs [zizmor](https://docs.zizmor.sh); fix its findings, or suppress one with a reason.

**Keep `verify` fast.** There is no task cache here, so the pre-push hook re-runs every gate on every push. It prints how long it took. If it grows past about 30 seconds, move the slow gates to CI only rather than training people to `--no-verify`.

## Project rules

- **Guards run before deploy, never in production.** Every feature checks code at edit time, in lint, in unit tests or at synth, and fails the build rather than the request. A runtime check (SDK middleware, a wrapped client, an assertion in handler code) is out of scope by principle: DynamoDB already rejects a bad request at that point, with a reason of its own. The [plan](https://github.com/laazyj/composureCDK/issues/627#issuecomment-6389317138) (§1) has the reasoning.
- **Detection, not building.** No expression builder: that space is well served (ElectroDB, dynamodb-toolbox). The guards check expressions people have already written.
- **Each entry point loads only its own peers.** The root and `/testing` load none, so they work in projects with no CDK, no ESLint and any mocking library. `/cdk` and `/eslint` each load only theirs. Code they share lives in `src/core/`. The one table of entries and peers is [`scripts/entries.mjs`](scripts/entries.mjs): `eslint.config.mjs` derives its import bans from it, and `npm run check:entries` bundles every entry against it and fails on any other dependency, on a size over budget, or on a mismatch with `package.json`.
- **Every peer is optional and mirrored as a devDependency with the _identical_ range string.** Dependabot then widens a peer when its new major passes CI. `npm run check:peers` enforces the mirror; [`scripts/check-peer-mirror.mjs`](scripts/check-peer-mirror.mjs) explains why.
- **A peer floor is the lowest version the code actually works with** (composureCDK [ADR-0008](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0008-aws-cdk-lib-version-floors.md)). The README's [Compatibility](README.md#compatibility) table gives each floor's reason. CI's lowest-supported job proves every floor; raising one is a deliberate change.
- **Lint rules are public API** (composureCDK [ADR-0019](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0019-lint-rules-as-public-contract.md)). A rule's name, messages and default severity are semver surface. Tightening a rule is breaking; adding an option is not, as long as its default keeps today's behaviour.
- **Dual ESM/CJS, built by tshy.** No `import.meta` or top-level `await` in `src/`, and brand checks use `Symbol.for(...)`, not `instanceof`. `@composurecdk/eslint-plugin`'s `dualPublishing` preset enforces both.
- **Types resolve under `moduleResolution: node10`.** That's why `typesVersions` in `package.json` mirrors `exports`. A new entry point needs a line there, in `tshy.exports` and in `scripts/entries.mjs`; `check:entries` and `check:exports` fail until all three agree.
- **Double quotes** (Prettier `"singleQuote": false`).
- **Commits and PR titles** use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`.
- **No CHANGELOG file.** Releases use generated GitHub Release notes, so describe behaviour changes in the PR body.

## Releasing

Maintainers run the **Release** workflow by hand with the version to publish. It runs `verify`, then submits the version to npm with [staged publishing](https://docs.npmjs.com/staged-publishing/) through trusted publishing (OIDC), and drafts the GitHub Release. Nothing is public yet. To finish the release:

1. Check the staged tarball (`npm stage list @composure-labs/dynamodb-guard`, then `npm stage download <stage-id>`) and approve it with 2FA: `npm stage approve <stage-id>`, or **Approve** under _Staged Packages_ on npmjs.com.
2. Publish the draft GitHub Release, which creates the `v<version>` tag.

The trusted publisher allows only `npm stage publish`, so CI can never publish on its own. The version lives in the tag and on npm; `package.json` on `main` stays at `0.0.0`.

## License

[MIT](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
