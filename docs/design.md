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

A runtime check is out of scope by principle, however useful it looks: SDK middleware, a wrapped client, or an assertion in handler code.

- **It fails when DynamoDB would, with no more to say.** Once a request reaches DynamoDB, the service rejects it with a reason of its own. A check in front of it adds latency to every request and moves the failure nowhere.
- **It doesn't run where the bug hides.** `aws-sdk-client-mock` stubs `Client#send()`, which bypasses the SDK's middleware stack. So a middleware never sees the requests a mocked unit test sends, and those are the tests that accept any string today. `/testing` reads what the mock recorded instead.

There is no runtime expression builder either, for the reason in [Detection, not building](#detection-not-building).

One gap is left on purpose: a handler that builds names at runtime, on a path no test runs. No guard can see that before deploy, so the answer is test coverage, not a runtime check. Lint still covers the literals in that code.

## Detection, not building

The guards check expressions people have already written. They don't offer a way to write them. Builders that alias names for you are a crowded field (ElectroDB, dynamodb-toolbox, dynamoose and others), and code that uses one has no hand-written expressions to check. Before this package, nothing checked the hand-written ones: not in the SDK, not in CDK or the IaC linters, not in ESLint. This package is for the code that writes them. For raw SDK code that wants prevention rather than detection, the lint rule's `aliasAll` option bans bare names outright.

The name says the same: a `-guard` package checks before deploy and ships nothing that runs in production.

## Specified by DynamoDB

The checker's behaviour is specified by the service, not by the docs. [The conformance corpus](../test/corpus/) holds requests with at most one fault each, since DynamoDB reports only the first error it finds, and what real DynamoDB said about each one. CI replays that recording offline, and the checker must agree with it. DynamoDB Local isn't used, because its parser and messages can drift from the service's.

A new check ships with recorded cases, which is what lets [ADR-0001](adr/0001-versioning-and-stable-api.md) treat it as a minor change: it only reports requests DynamoDB already rejects. A false positive is fixed the same way, starting with a case that records DynamoDB accepting the request.

## One checker, three guards

`/cdk`, `/testing` and `/eslint` all run the same checker, from the root entry point, so they agree on what DynamoDB rejects and say it the same way. Each guard only finds requests and reads what it can of them. The root and `/testing` load no peer dependency, so they work in a project with no CDK, no ESLint and any mocking library. `/cdk` and `/eslint` each load only their own peer.

## Not in this package's scope

- **PartiQL statements.** A different language, with its own parser and failure modes.
- **Checks that need the table's definition**, such as a key condition against the key schema, or an `IndexName` against the table's indexes. Only `/cdk` can see a table, and only for the few requests it checks. [#12](https://github.com/composure-labs/dynamodb-guard/issues/12) records why these wait for demand.

## History

The package was planned in [laazyj/composureCDK#627](https://github.com/laazyj/composureCDK/issues/627#issuecomment-6389317138), as a sibling of ComposureCDK rather than part of its core. ComposureCDK's checks stop at values CloudFormation or a resource provider interprets at deploy. DynamoDB interprets an expression at request time, even one written inside a Step Functions definition, which makes it application logic. The package depends on no ComposureCDK package, and works in plain CDK, other IaC tools, or projects whose only DynamoDB code is handlers tested with mocked clients. This page and the ADRs supersede the plan where they differ.
