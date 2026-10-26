import { Annotations, Aspects, CfnResource } from "aws-cdk-lib";
import type { IConstruct } from "constructs";
import { UNKNOWN } from "../core/check.js";
import { checkRequestsIn, type CheckedSite, formatSites } from "../core/requests.js";
import type { RequestSource } from "./source.js";
import { stateMachines } from "./stepfunctions/state-machine.js";

/** Each kind of resource the policy reads. */
const SOURCES: readonly RequestSource[] = [stateMachines];

/**
 * The id `warn` mode annotates with. Pass it to
 * `Annotations.of(scope).acknowledgeWarning(...)` to silence a known case.
 */
export const DYNAMODB_EXPRESSION_WARNING = "@composure-labs/dynamodb-guard:expression";

/**
 * What the policy does with a request DynamoDB would reject.
 *
 * - `throw`: fail synth, listing every violation in the resource.
 * - `warn`: annotate each resource's violations and carry on. Run this to
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
  /**
   * Add an info annotation to each resource listing what the policy couldn't
   * check: values not known at synth, and definitions it can't read.
   * @default false
   */
  reportUnchecked?: boolean;
}

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
 * checked. Set `reportUnchecked` to list them. The README lists what the
 * policy can't see.
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
  const { onViolation = "throw", reportUnchecked = false } = config;
  const visitor = {
    visit(node: IConstruct): void {
      if (!CfnResource.isCfnResource(node)) return;
      const source = SOURCES.find((candidate) => candidate.matches(node));
      if (source === undefined) return;
      const where = node.node.path;

      const payloads = source.read(node);
      if (!Array.isArray(payloads)) {
        if (reportUnchecked) {
          Annotations.of(node).addInfo(
            `${where}: DynamoDB expressions not checked; ${payloads.unreadable}.`,
          );
        }
        return;
      }

      const sites: (CheckedSite & { label: string })[] = [];
      const unchecked: string[] = [];
      for (const { label, operation, value } of payloads) {
        if (value === UNKNOWN) {
          unchecked.push(label);
          continue;
        }
        for (const site of checkRequestsIn(value, operation)) {
          const at = site.path === "" ? label : `${label}.${site.path}`;
          unchecked.push(...site.unknown.map((field) => `${at} ${field}`));
          sites.push({ ...site, label: at });
        }
      }
      const report = formatSites(sites);

      if (reportUnchecked && unchecked.length > 0) {
        Annotations.of(node).addInfo(
          `${where}: ${String(unchecked.length)} DynamoDB field(s) aren't known at synth and were not checked: ${unchecked.join("; ")}.`,
        );
      }
      if (report === "") return;
      const message = `${where}: DynamoDB would reject a request this ${source.noun} sends.\n${report}`;
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
