# ADR 0001: Versioning and the stable API

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Up to 0.x, the only written promise about what stays stable was ComposureCDK [ADR-0019](https://github.com/laazyj/composureCDK/blob/main/docs/adr/0019-lint-rules-as-public-contract.md), which this package adopted for its ESLint rules. It says a rule's name, messages and default severity are public API, and that tightening a rule is breaking. It says nothing about the checker, `/cdk` or `/testing`, which all report the same violations as `valid-expressions`.

Applied as written, ADR-0019 would freeze the checker. Every check added since 0.1 (argument counts, overlapping projection paths, `ReturnValues`) makes `valid-expressions` report where it didn't before, so each would wait for a major. Each also turns a passing `cdk synth` or test suite red, in the same way.

But this package differs from a style linter in one way that matters. Every violation it reports is a request DynamoDB rejects, and [the conformance corpus](../../test/corpus/) proves it: a case is recorded against the real service, and the checker is tested against the recording. A new violation therefore fires only on code that already fails whenever it runs. It moves an existing failure to before deploy; it doesn't create one.

1.0 also freezes some things by accident unless they are named. `ViolationKind` is an exported union, so adding a member breaks an exhaustive `switch`. And every message the checker writes is also a lint message, so freezing messages would freeze all of the checker's wording.

## Decision

### What is public API

- **The entry points and what they export.** The root, `/cdk`, `/testing` and `/eslint`, as `exports` in `package.json` lists them. Anything not exported from an entry point isn't API, whatever `dist/` contains.
- **The data of each violation:** `kind`, `field`, `token` and `offset`. `DynamoExpressionError`'s `name` and `violations`. `RejectedRequest`'s fields.
- **`DYNAMODB_EXPRESSION_WARNING`**, the `/cdk` policy's options and their defaults, the `/testing` functions and the matcher name `toHaveOnlyValidDynamoRequests`.
- **For each lint rule:** its name, its message IDs, its options and their defaults, and which presets it is in, at which severity.

**Not API:** the wording of any message, the caret layout, the text of a thrown error or an annotation beyond the fields above, and the reserved-word list's contents as such. A consumer that needs to tell violations apart reads `kind`, not the message.

### What each release can change

| Release   | Changes                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Patch** | A fix that makes a guard report less, where it reported a request DynamoDB accepts (a false positive). Wording, layout and docs.                                                                                                                                                                        |
| **Minor** | A new check for a request DynamoDB rejects, backed by recorded corpus cases. A new `ViolationKind`. A reserved word AWS adds. A new export, option (whose default keeps today's behaviour), or rule that joins no preset. Dropping a Node.js release line past its upstream end of life.                |
| **Major** | Removing or renaming an export, a rule, an option or a message ID. Changing a default. Reporting, by default, a request DynamoDB accepts. Adding a rule to a preset, raising its severity, or moving it between presets. Raising a peer floor. Dropping a Node.js release line upstream still supports. |

**A new check for a request DynamoDB rejects is a minor, even in `valid-expressions`.** This refines ADR-0019's "tightening a rule is breaking" for that one rule, and for the checker, `/cdk` and `/testing` with it. The check needs corpus cases recorded against DynamoDB; without them it isn't a rejection the package can claim, and it can only ship opt-in.

**Everything else in ADR-0019 still applies.** A check for something DynamoDB accepts, such as `ambiguous-subtraction`, follows it as written: a new rule joins a preset only in a major, and tightening it is breaking. Its message IDs are API, but, as for every rule here, its wording isn't.

**Adding a `ViolationKind` is a minor.** Consumers that branch on `kind` should handle a kind they don't know, with a `default` branch. The README says so.

## Consequences

- Upgrading within a major can turn a green build red, but only on a request that DynamoDB would reject. The release notes name each new check, and `/cdk`'s `onViolation: "warn"` lets a team adopt it without blocking synth. A team that wants no new checks at all can pin with `~` instead of `^`.
- A request in a code path that never runs is reported like any other. That's accepted: the request is still wrong, and the fix is to correct or delete it.
- A false positive is a bug, fixed in a patch, never a reason to wait for a major. The corpus makes one rare, because a check ships only with recorded cases.
- Message wording can be improved freely. Tests and tooling that match message text are relying on something this ADR doesn't promise.
- The corpus is the line between a minor and a major. When DynamoDB's own behaviour changes, a re-recording shows it. Following that change is a minor if the guards report less, and needs a decision here if they would report more.

## Alternatives considered

- **ADR-0019 as written: any stricter check is a major.** Rejected. It would hold every fixed false negative for the next major, while the code it would report is already failing.
- **New checks opt-in until a major.** Rejected for checks DynamoDB rejects, because almost nobody turns on an opt-in check, so they would protect no one until the major. It remains the path for checks DynamoDB accepts.
- **Making the wording API.** Rejected. It would make every clearer message a major, and the data a program needs is already in the violation's fields.
