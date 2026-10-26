import { Annotations, Aspects, CfnResource, Stack } from "aws-cdk-lib";
import type { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import type { IConstruct } from "constructs";
import { checkPartialRequest, formatViolations, UNKNOWN } from "../core/check.js";
import { findRequests } from "../core/requests.js";
import { dynamoTasks, type DynamoTask, parseDefinition, type Unreadable } from "./definition.js";

/**
 * The id `warn` mode annotates with. Pass it to
 * `Annotations.of(scope).acknowledgeWarning(...)` to silence a known case.
 */
export const DYNAMODB_EXPRESSION_WARNING = "@composure-labs/dynamodb-guard:expression";

/**
 * What the policy does with a request DynamoDB would reject.
 *
 * - `throw`: fail synth, listing every violation in the state machine.
 * - `warn`: annotate each state machine's violations and carry on. Run this to
 *   list everything on an existing estate, fix the list, then switch to `throw`.
 */
export type DynamodbExpressionViolationMode = "throw" | "warn";

/** Configuration for {@link dynamodbExpressionPolicy}. */
export interface DynamodbExpressionPolicyConfig {
  /**
   * How to handle a violation.
   * @default "throw"
   */
  onViolation?: DynamodbExpressionViolationMode;
}

/**
 * The definition as JSON, or why it can't be read. An L1 `definition` object
 * is rendered as `DefinitionString` would be, so a token in it, such as the
 * partition in a task's `Resource`, reads the same in both.
 */
function definitionOf(
  machine: CfnStateMachine,
  stack: Stack,
): { definition: unknown } | Unreadable {
  if (machine.definitionS3Location !== undefined) return "s3";
  const text =
    machine.definition === undefined
      ? machine.definitionString
      : stack.toJsonString(machine.definition);
  return parseDefinition(stack.resolve(text));
}

const UNREADABLE: Readonly<Record<Unreadable, string>> = {
  s3: "its definition is in S3 (definitionS3Location)",
  intrinsic: "its definition is a CloudFormation intrinsic, not JSON text",
  json: "its definition isn't valid JSON",
};

const label = (task: DynamoTask, path: string): string =>
  `state "${task.state}" (dynamodb:${task.action}) ${task.field}${path === "" ? "" : `.${path}`}`;

/**
 * Fails synth when a Step Functions state machine sends DynamoDB a request it
 * would reject: a reserved word used as a name, a name that must be aliased, a
 * placeholder with no definition, a definition nothing uses, and every other
 * {@link https://github.com/composure-labs/dynamodb-guard#what-it-checks | check}
 * the checker makes.
 *
 * Installs a CDK Aspect that reads each `AWS::StepFunctions::StateMachine`
 * definition and checks every DynamoDB task in it, through either the
 * optimised integration or the SDK one, in JSONPath (`Parameters`) or JSONata
 * (`Arguments`). Call it once on any scope before synth; constructs added
 * afterwards are still covered.
 *
 * Values not known at synth (a `.$` key, a `{% %}` value, a CDK token) aren't
 * checked. Each state machine with any reports them as an info annotation, so
 * the gap is never silent. The README lists what the policy can't see.
 *
 * @param scope - Any construct; the policy applies to its whole subtree.
 * @param config - What to do with a violation.
 *
 * @example
 * ```ts
 * dynamodbExpressionPolicy(app);
 *
 * // Adopting on an existing estate: list everything first.
 * dynamodbExpressionPolicy(app, { onViolation: "warn" });
 * ```
 */
export function dynamodbExpressionPolicy(
  scope: IConstruct,
  config: DynamodbExpressionPolicyConfig = {},
): void {
  const { onViolation = "throw" } = config;
  const visitor = {
    visit(node: IConstruct): void {
      if (!CfnResource.isCfnResource(node)) return;
      if (node.cfnResourceType !== "AWS::StepFunctions::StateMachine") return;
      const machine = node as CfnStateMachine;
      const where = node.node.path;
      const stack = Stack.of(node);

      const read = definitionOf(machine, stack);
      if (typeof read === "string") {
        Annotations.of(node).addInfo(
          `${where}: DynamoDB expressions not checked; ${UNREADABLE[read]}.`,
        );
        return;
      }

      const substitutions = Object.keys(
        (stack.resolve(machine.definitionSubstitutions) ?? {}) as object,
      );
      const reports: string[] = [];
      const skipped: string[] = [];
      for (const task of dynamoTasks(read.definition, substitutions)) {
        if (task.payload === UNKNOWN) {
          skipped.push(label(task, ""));
          continue;
        }
        for (const { path, request } of findRequests(task.payload, task.action)) {
          const { violations, unknown } = checkPartialRequest(request);
          for (const field of unknown) skipped.push(`${label(task, path)} ${field}`);
          if (violations.length === 0) continue;
          reports.push(
            `${label(task, path)}:\n${formatViolations(request, violations).replaceAll(/^/gm, "  ")}`,
          );
        }
      }

      if (skipped.length > 0) {
        Annotations.of(node).addInfo(
          `${where}: ${String(skipped.length)} DynamoDB field(s) are dynamic (a ".$" key, a JSONata "{% %}" value or a CDK token) and were not checked: ${skipped.join("; ")}.`,
        );
      }
      if (reports.length === 0) return;
      const message = `${where}: DynamoDB would reject a request this state machine sends.\n${reports.join("\n")}`;
      // Annotations.addError would be ignored by app.synth() and
      // Template.fromStack(); only the CDK CLI acts on it. Throwing fails everywhere.
      if (onViolation === "throw") throw new Error(message);
      Annotations.of(node).addWarningV2(DYNAMODB_EXPRESSION_WARNING, message);
    },
  };
  // Last, after any Aspect that mutates the definition: AspectPriority.READONLY
  // is 1000. A literal, because AspectPriority and this second argument arrived
  // after the aws-cdk-lib floor, and an older Aspects.add ignores it.
  const aspects = Aspects.of(scope) as unknown as {
    add(aspect: typeof visitor, options: { priority: number }): void;
  };
  aspects.add(visitor, { priority: 1000 });
}
