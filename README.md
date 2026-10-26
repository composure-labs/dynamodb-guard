# @composure-labs/dynamodb-guard

[![npm version](https://img.shields.io/npm/v/@composure-labs/dynamodb-guard)](https://www.npmjs.com/package/@composure-labs/dynamodb-guard)
[![npm downloads](https://img.shields.io/npm/dm/@composure-labs/dynamodb-guard)](https://www.npmjs.com/package/@composure-labs/dynamodb-guard)
[![CI](https://github.com/composure-labs/dynamodb-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/composure-labs/dynamodb-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f0d0c)](LICENSE)

**Catch DynamoDB expression mistakes before deploy.**

> [!WARNING]
> **Pre-release.** The checker the guards build on is in place; the guards themselves (`/cdk`, `/testing`, `/eslint`) are not yet. The design and the plan live in [laazyj/composureCDK#627](https://github.com/laazyj/composureCDK/issues/627#issuecomment-6389317138).

DynamoDB rejects a request whose expression names a [reserved word](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html) (`status`, `metrics`, `name`, `data` and about 570 more) without an `ExpressionAttributeNames` alias:

```
ValidationException: Invalid UpdateExpression: Attribute name is a reserved keyword; reserved keyword: metrics
```

Nothing catches this before the first real call. `cdk synth` accepts it, and unit tests with mocked clients accept any string. The same is true of names that must be aliased for other reasons, `#aliases` with no definition, and definitions that nothing uses.

## Guards, not runtime checks

Every guard here runs **before deploy**: in the editor, in lint, in unit tests or at synth. Nothing in this package runs in production. Once a request reaches DynamoDB, DynamoDB reports the mistake itself. A guard's job is to move that report to before deploy.

| Where the expression is written                | Guard      | Fails at             |
| ---------------------------------------------- | ---------- | -------------------- |
| Step Functions definitions                     | `/cdk`     | `cdk synth` (CI)     |
| Handler code, including names built at runtime | `/testing` | Unit tests (CI)      |
| A literal in any code                          | `/eslint`  | The editor, and lint |

The root entry point is the checker all three build on. It has no dependencies. `/testing` has none either, so neither needs CDK or ESLint installed. The `/cdk` and `/eslint` entry points need their optional peers.

## The checker

Every guard runs the same checker, which you can also call directly. It is specified by DynamoDB itself: [`test/corpus/`](test/corpus/) records what the real service accepts and rejects, and the checker is tested against that recording.

```ts
import { assertRequest, checkRequest } from "@composure-labs/dynamodb-guard";

assertRequest({
  UpdateExpression: "SET #status = :completed, metrics = :metrics",
  ExpressionAttributeNames: { "#status": "status" },
  ExpressionAttributeValues: { ":completed": "done", ":metrics": {} },
});
// DynamoExpressionError: DynamoDB would reject this request:
// UpdateExpression: "metrics" is a reserved word; alias it: ExpressionAttributeNames { "#metrics": "metrics" }.
//   SET #status = :completed, metrics = :metrics
//                             ^^^^^^^
//   See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html
```

`checkRequest` returns the violations instead of throwing. It reads only the expression fields and the two attribute maps, so an SDK command's input can be passed as it is. It reports:

| Kind                                                     | DynamoDB rejects                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `reserved-word`                                          | an unaliased [reserved word](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html), in any letter case |
| `must-alias`                                             | an unaliased name that isn't an ASCII letter followed by letters, digits or `_` (`1abc`, `my-attr`, `_u`, `café`)                     |
| `undefined-alias` / `unused-alias`                       | a placeholder with no map entry, or a map entry no expression in the request uses                                                     |
| `names-without-expression` / `values-without-expression` | either map on a request with no expression                                                                                            |
| `kind-grammar`                                           | syntax valid elsewhere but not here: `OR` in a key condition, `if_not_exists()` in a condition                                        |
| `overlapping-paths`                                      | two update actions on overlapping paths (`a` and `a.b`)                                                                               |
| `limit`                                                  | over 4 KB, 300 operators, 100 `IN` operands or a 255-byte placeholder                                                                 |
| `syntax`                                                 | anything else it can't parse; like DynamoDB, it stops at the first                                                                    |

Not yet checked: a function's number of arguments, and repeated paths in a projection.

## Where this sits in the ecosystem

This is a **composure-labs** package: first-party to [composureCDK](https://github.com/laazyj/composureCDK), but released on its own schedule. It depends on no composureCDK package, and works in any CDK app or test suite. Inside the `@composure-labs` scope, the name's prefix says what a package builds on:

| Prefix          | Builds on                                      |
| --------------- | ---------------------------------------------- |
| `composurecdk-` | composureCDK's builders (and so `aws-cdk-lib`) |
| `cdk-`          | plain `aws-cdk-lib`                            |
| _(none)_        | nothing IaC-specific                           |

This one has no prefix: its root entry point needs nothing IaC-specific. It is not related to [AWS CloudFormation Guard](https://github.com/aws-cloudformation/cloudformation-guard).

## Compatibility

| Peer          | Range                 | Needed by                                                      |
| ------------- | --------------------- | -------------------------------------------------------------- |
| `aws-cdk-lib` | `^2.93.0`             | `/cdk` only. The first release with `Annotations.addWarningV2` |
| `constructs`  | `^10.0.0`             | `/cdk` only                                                    |
| `eslint`      | `^9.0.0 \|\| ^10.0.0` | `/eslint` only. Flat config, which ESLint 9 made the default   |
| Node.js       | `>=20`                |                                                                |

Every peer is optional, but npm still checks the range of a peer you already have: a project on ESLint 9 can install this package for `/testing` alone only because the range admits 9. CI installs the package with none of them and loads the root and `/testing` entry points, then tests every entry point at the oldest version each range admits.

Ships ESM and CommonJS from one source, built by [tshy](https://github.com/isaacs/tshy). Types resolve under every `moduleResolution`, including `node10`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, the gates, the project rules and how releases work.

## License

[MIT](LICENSE)
