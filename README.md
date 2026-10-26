# @composure-labs/dynamodb-guard

[![npm version](https://img.shields.io/npm/v/@composure-labs/dynamodb-guard)](https://www.npmjs.com/package/@composure-labs/dynamodb-guard)
[![npm downloads](https://img.shields.io/npm/dm/@composure-labs/dynamodb-guard)](https://www.npmjs.com/package/@composure-labs/dynamodb-guard)
[![CI](https://github.com/composure-labs/dynamodb-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/composure-labs/dynamodb-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f0d0c)](LICENSE)

**Catch DynamoDB expression mistakes before deploy.**

> [!WARNING]
> **Pre-release.** The checker and all three guards are in place, but the API may still change before 1.0. The design and the plan live in [laazyj/composureCDK#627](https://github.com/laazyj/composureCDK/issues/627#issuecomment-6389317138).

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

## Step Functions, at synth (`/cdk`)

```ts
import { dynamodbExpressionPolicy } from "@composure-labs/dynamodb-guard/cdk";

const app = new App();
// ...stacks...
dynamodbExpressionPolicy(app);
```

The policy installs a CDK Aspect that reads every `AWS::StepFunctions::StateMachine` definition after synth and checks each DynamoDB task in it. It covers the optimised integrations (`DynamoUpdateItem`, `DynamoGetItem`, …) and the SDK ones (`CallAwsService`, `arn:aws:states:::aws-sdk:dynamodb:*`), in JSONPath `Parameters` and in JSONata `Arguments`. It looks at every state, including `Parallel` branches and inline or distributed `Map`s, and at each item of a transaction. Because it runs on the synthesised definition, an attribute name interpolated from a variable is checked like any other:

```
Error: Stack/Machine/Resource: DynamoDB would reject a request this state machine sends.
state "Complete" (dynamodb:updateItem) Parameters:
  UpdateExpression: "metrics" is a reserved word; alias it: ExpressionAttributeNames { "#metrics": "metrics" }.
    SET metrics = :m
        ^^^^^^^
    See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html
```

`onViolation` chooses what happens:

- **`throw`** (the default) fails synth, listing every violation in the state machine. It throws, not `Annotations.addError`, because only the CDK CLI acts on an error annotation: `app.synth()` and `Template.fromStack()` in a unit test would carry on.
- **`warn`** adds a warning to each state machine instead, with the id `DYNAMODB_EXPRESSION_WARNING`, which `Annotations.of(scope).acknowledgeWarning(...)` accepts. To adopt the policy on an existing estate, run `warn`, fix the list, then switch to `throw`.

`reportUnchecked: true` adds an info annotation to each state machine, listing what the policy couldn't check (see below). It is off by default, because in a large app every dynamic field adds a line to `cdk synth`.

On `aws-cdk-lib` releases that have `AspectPriority`, the policy runs after any Aspect that changes a definition. Older releases run Aspects in the order they were added, so call the policy last.

### What it can't see

A value whose text isn't known at synth is skipped, never guessed at. With `reportUnchecked`, each state machine lists what it skipped, and any definition it couldn't read, in an info annotation:

- a JSONPath `.$` field (`"UpdateExpression.$": "States.Format(...)"`), a JSONata `{% %}` value, a CDK token, and a `DefinitionSubstitutions` placeholder. When an expression is skipped, the request's unused entries aren't reported, because the skipped expression may use them. When a map is skipped, undefined placeholders aren't reported, because the map may define them;
- a definition in S3 (`definitionS3Location`), or one that is a CloudFormation intrinsic other than `Fn::Join`;
- a definition changed with `addPropertyOverride`, which the policy doesn't read;
- expressions in Lambda code (use `/testing`), `AwsCustomResource` calls, AppSync resolvers and PartiQL statements.

## Handler code, in unit tests (`/testing`)

Unit tests with a mocked client accept any string, so a handler that sends DynamoDB a bad expression passes its tests and fails on its first real call. `/testing` checks every request the mock recorded. Because it reads what was actually sent, a name built at runtime is checked like a literal one.

```ts
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { assertValidDynamoRequests } from "@composure-labs/dynamodb-guard/testing";

const ddb = mockClient(DynamoDBDocumentClient);

// In a setup file, this guards every test, so nobody has to remember to.
afterEach(() => {
  assertValidDynamoRequests(ddb);
  ddb.reset();
});
```

```
Error: DynamoDB would reject a request:
call 0 (UpdateCommand):
  UpdateExpression: "metrics" is a reserved word; alias it: ExpressionAttributeNames { "#metrics": "metrics" }.
    SET #status = :completed, metrics = :metrics
                              ^^^^^^^
    See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html
```

It has no peer dependencies, and it doesn't import a mocking library. It reads the source by shape:

- an [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock) stub, or anything whose `calls()` returns `{ args }` records;
- a Vitest or Jest mock function, such as `vi.spyOn(client, "send")`. Clear it after each check (`mockClear()`, or `clearMocks: true`), as `ddb.reset()` does above, or each test re-checks every call before it;
- an array of SDK commands, or of their inputs.

Requests are found by shape too, so `DynamoDBClient`, `DynamoDBDocumentClient` and wrappers that keep the SDK's input shape all work. That includes each item of a transaction and each table of a `BatchGetItem`. A `GetItem`'s `ExpressionAttributeValues` is ignored, because the SDK drops it without sending it.

The guard comes in three forms:

- `assertValidDynamoRequests(source)` throws, listing every rejected request.
- `rejectedDynamoRequests(source)` returns them, each with its call number, command name, path and violations.
- `dynamodbGuardMatchers` is for `expect.extend`, and gives `expect(ddb).toHaveOnlyValidDynamoRequests()`. The matcher's type is yours to declare:

  ```ts
  expect.extend(dynamodbGuardMatchers);
  declare module "vitest" {
    interface Matchers {
      toHaveOnlyValidDynamoRequests(): void;
    }
  }
  ```

It can't see code paths no test runs, clients that aren't mocked, or PartiQL statements. A test against real DynamoDB or DynamoDB Local doesn't need a guard, because the service rejects the request itself.

## Lint (`/eslint`)

```js
// eslint.config.js
import dynamodbGuard from "@composure-labs/dynamodb-guard/eslint";

export default [
  // ...your config...
  dynamodbGuard.configs.recommended,
];
```

The rule `dynamodb-guard/valid-expressions` runs the same checker over every DynamoDB request written as an object literal, and reports each violation at the token:

```
4:48  error  "metrics" is a reserved word; alias it: ExpressionAttributeNames { "#metrics": "metrics" }.  dynamodb-guard/valid-expressions
```

An object counts as a DynamoDB request when it has a request field and something else that says DynamoDB. `ConditionExpression`, `FilterExpression` and `ProjectionExpression` exist in other AWS APIs, so on their own they aren't enough. The rule recognises:

- an object with `UpdateExpression` or `KeyConditionExpression`;
- an object with any expression and a sibling `TableName` or `ExpressionAttribute*`;
- an argument to `new …Command(…)` or a CDK `Dynamo*` task, including the camelCase props (`updateExpression`, `expressionAttributeNames`);
- a transaction item's `Update`, `ConditionCheck`, `Put`, `Delete` or `Get`;
- a table of a `BatchGetItem`'s `RequestItems`, under a literal or computed key.

How it treats each kind of value:

- **Expressions and maps written as literals** are checked together, as a request.
- **A value the rule can't read** (a variable, a computed key, a spread that may hold the maps) is left unchecked, and so is anything it could affect.
- **`ExpressionAttributeValues` on a `GetItem` or a `BatchGetItem` table** is ignored, because the SDK drops it.

Options:

| Option          | Default | Effect                                                                                                                                                                                              |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reportDynamic` | `true`  | Reports an expression assembled with `${}` or `+`, whose names can't be checked. The fix is one string, with each name that varies as a `#placeholder`. Turn it off to accept assembled expressions |
| `aliasAll`      | `false` | Reports every attribute name not written as a `#placeholder`, reserved or not, so the bug can't be written at all. It needs no word list                                                            |

The rule can't see a name that arrives through a variable. `/testing` checks those, using what the code actually sent. The rule's name, its messages and its default severity are public API: tightening any of them is a breaking change.

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
