# Contributing

Thanks for your interest. We work **issue-first**: open an issue before a large pull request, and we'll agree on fit and approach before anyone writes code. Every export, option and lint rule is a promise to consumers ([ADR-0001](docs/adr/0001-versioning-and-stable-api.md)), so it's cheaper to settle the shape of a change in an issue than in review. Small, obvious fixes (typos, broken links, one-line bugs) are welcome as direct pull requests. Security issues go through [SECURITY.md](SECURITY.md), never a public issue.

[docs/design.md](docs/design.md) explains why the package is shaped the way it is, and [docs/adr/](docs/adr/) records the decisions that bind future work.

## Development setup

Prerequisites: **Node.js >= 22** for development (consumers need it too), and **shellcheck** on your `PATH` if you change `.github/workflows/` (`brew install shellcheck`).

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

- **Guards run before deploy, never in production.** Every feature checks code at edit time, in lint, in unit tests or at synth, and fails the build rather than the request. A runtime check (SDK middleware, a wrapped client, an assertion in handler code) is out of scope by principle: DynamoDB already rejects a bad request at that point, with a reason of its own. [docs/design.md](docs/design.md#guards-before-deploy-never-at-runtime) has the reasoning.
- **Detection, not building.** No expression builder: that space is well served (ElectroDB, dynamodb-toolbox). The guards check expressions people have already written.
- **Each entry point loads only its own peers.** The root and `/testing` load none, so they work in projects with no CDK, no ESLint and any mocking library. `/cdk` and `/eslint` each load only theirs. Code they share lives in `src/core/`. The one table of entries and peers is [`scripts/entries.mjs`](scripts/entries.mjs): `eslint.config.mjs` derives its import bans from it, and `npm run check:entries` bundles every entry against it and fails on any other dependency, on a size over budget, or on a mismatch with `package.json`.
- **Every peer is optional and mirrored as a devDependency with the _identical_ range string.** Dependabot then widens a peer when its new major passes CI. `npm run check:peers` enforces the mirror; [`scripts/check-peer-mirror.mjs`](scripts/check-peer-mirror.mjs) explains why.
- **A peer floor is the lowest version the code actually works with** (ComposureCDK [ADR-0008](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0008-aws-cdk-lib-version-floors.md)). The README's [Compatibility](README.md#compatibility) table gives each floor's reason. CI's lowest-supported job proves every floor; raising one is a deliberate change.
- **What's API, and what each release can change, is [ADR-0001](docs/adr/0001-versioning-and-stable-api.md).** It refines ComposureCDK [ADR-0019](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0019-lint-rules-as-public-contract.md): a new check for a request DynamoDB rejects is a minor, backed by recorded corpus cases, and message wording isn't API. Anything that reports a request DynamoDB accepts, by default, is breaking.
- **Dual ESM/CJS, built by tshy.** No `import.meta` or top-level `await` in `src/`, and brand checks use `Symbol.for(...)`, not `instanceof`. `@composurecdk/eslint-plugin`'s `dualPublishing` preset enforces both.
- **Types resolve under `moduleResolution: node10`.** That's why `typesVersions` in `package.json` mirrors `exports`. A new entry point needs a line there, in `tshy.exports` and in `scripts/entries.mjs`; `check:entries` and `check:exports` fail until all three agree.
- **Double quotes** (Prettier `"singleQuote": false`).
- **Commits and PR titles** use [Conventional Commits](https://www.conventionalcommits.org/): `<type>(<scope>): <description>`.
- **No CHANGELOG file.** Releases use generated GitHub Release notes, so describe behaviour changes in the PR body.

## The conformance corpus

The checker is specified by DynamoDB itself. [`test/corpus/cases.mjs`](test/corpus/cases.mjs) lists requests with at most one fault each, and [`test/corpus/recorded.json`](test/corpus/recorded.json) is what real DynamoDB said about each one. CI only replays the recording, and `recording.test.mjs` fails if a case has no recording, has changed since it was recorded, or disagrees with its `fault`.

To add or change a case, edit `cases.mjs`, writing your best guess at the `fault` where the docs don't settle it. Then re-record against the sandbox account:

```sh
AWS_PROFILE=<profile> AWS_REGION=<region> npm run corpus:record
```

[`scripts/record-corpus.mjs`](scripts/record-corpus.mjs) creates a temporary on-demand table, runs every case and deletes the table. It costs well under a cent, and lists every case DynamoDB judged differently from its `fault`. Correct those faults, and commit `cases.mjs` and `recorded.json` together.

## Breaking changes

Propose a breaking change in an issue first, saying who it breaks and what they'd have to change. [ADR-0001](docs/adr/0001-versioning-and-stable-api.md) lists what counts. If the change is agreed:

- Mark it in the commit and PR title with `!` (`feat(eslint)!: …`), and add a `BREAKING CHANGE:` footer to the commit.
- Write a **Migration** section in the PR body: what changed, who it affects, and what to do, with a before-and-after example where one helps. The release notes are generated from the PR bodies, so this section is what consumers read.
- Merge it only when the next release is a major. Until then, keep it on a branch, or ship it opt-in and switch the default in the major.

## Releasing

Maintainers run the **Release** workflow by hand with the version to publish. It sets the version (`npm version`, whose `version` script also writes `src/core/version.ts`), runs `verify`, and publishes the tarball `verify` checked to npm through trusted publishing (OIDC), with provenance. It then publishes the GitHub Release, which creates the `v<version>` tag. The version lives in the tag and on npm; `package.json` on `main` stays at `0.0.0`. A prerelease, such as `1.1.0-rc.1`, is published under the `next` dist-tag, and its GitHub Release is marked as a prerelease, so neither becomes the latest.

Nothing approves a run after it starts, so the gate is who can run it: the `npm` environment deploys only from protected branches, and the package's trusted publisher on npmjs.com (GitHub, this repository, `release.yml`, environment `npm`) must allow `npm publish`.

A major release needs two more steps. Before running the workflow, check that every breaking PR since the last release has a **Migration** section. After the release is published, edit its notes to put those sections first, under a **Migrating from <previous major>** heading, ahead of the generated list. Publish a release candidate, such as `2.0.0-rc.1`, under `next` first, and give consumers time to try it.

If npm publishes and the GitHub Release step fails, don't run the workflow again: the version is already on npm. Create the release by hand, with the commit the run built: `gh release create v<version> --target <sha> --title v<version> --generate-notes`, adding `--prerelease` for a prerelease.

## License

[MIT](LICENSE). By contributing, you agree that your contributions are licensed under the same terms.
