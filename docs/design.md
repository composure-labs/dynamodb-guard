# Design

Why this package is shaped the way it is. The decisions that bind future work are recorded as [ADRs](adr/).

## Guards before deploy, never at runtime

DynamoDB interprets an expression only when a request arrives. CloudFormation never parses one, so `cdk synth` and `cdk deploy` accept any string, and so does a unit test with a mocked client. The first thing that reads the expression is the service, in production.

So every guard here runs earlier: in the editor, in lint, in unit tests, or at synth. Each one fails the build, never the request. Where an expression is written decides which guard can see it:

| Where the expression is written                  | Guard      | Sees it at      |
| ------------------------------------------------ | ---------- | --------------- |
| A literal in any code                            | `/eslint`  | Edit time, lint |
| Handler code, including names built at runtime   | `/testing` | Unit tests      |
| Step Functions definitions, `AwsCustomResource`s | `/cdk`     | `cdk synth`     |

A runtime check is out of scope by principle, however useful it looks: SDK middleware, a wrapped client, or an assertion in handler code. At runtime, DynamoDB already rejects a bad request, with a reason of its own. A second check there would add a dependency and a code path to production in order to repeat what the service says anyway, a moment later. For the same reason, there is no runtime expression builder here.

One gap is left on purpose: a handler that builds names at runtime, on a path no test runs. No guard can see that before deploy. Test coverage closes it, not a runtime check.

## Detection, not building

The guards check expressions people have already written. They don't offer a way to write them. Expression builders exist and are well served by libraries such as ElectroDB and dynamodb-toolbox, and code that uses one has no hand-written expressions to check. This package is for the code that does.

## Specified by DynamoDB

The checker's behaviour is specified by the service, not by the docs. [The conformance corpus](../test/corpus/) holds requests with at most one fault each, and what real DynamoDB said about each one. CI replays that recording, and the checker must agree with it. A new check ships with recorded cases, which is what lets [ADR-0001](adr/0001-versioning-and-stable-api.md) treat it as a minor change: it only reports requests DynamoDB already rejects.

## One checker, three guards

`/cdk`, `/testing` and `/eslint` all run the same checker, from the root entry point, so they agree on what DynamoDB rejects and say it the same way. Each guard only finds requests and reads what it can of them. The root and `/testing` load no peer dependency, so they work in a project with no CDK, no ESLint and any mocking library. `/cdk` and `/eslint` each load only their own peer.

## Not in this package's scope

- **PartiQL statements.** A different language, with its own parser and failure modes.
- **Checks that need the table's definition**, such as a key condition against the key schema, or an `IndexName` against the table's indexes. Only `/cdk` can see a table, and only for the few requests it checks. [#12](https://github.com/composure-labs/dynamodb-guard/issues/12) records why these wait for demand.

## History

The package was planned in [laazyj/composureCDK#627](https://github.com/laazyj/composureCDK/issues/627#issuecomment-6389317138), as a sibling of ComposureCDK rather than part of its core: ComposureCDK checks what CloudFormation will accept, and DynamoDB expressions are interpreted after that, by a different service. It depends on no ComposureCDK package and works in any CDK app or test suite. This page and the ADRs supersede the plan where they differ.
