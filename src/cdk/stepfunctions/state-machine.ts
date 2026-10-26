import { Stack } from "aws-cdk-lib";
import type { CfnStateMachine } from "aws-cdk-lib/aws-stepfunctions";
import type { RequestSource } from "../source.js";
import { dynamoTasks, parseDefinition, type Unreadable } from "./definition.js";

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

/**
 * Each DynamoDB task in a state machine's definition, through either the
 * optimised integration or the SDK one, in JSONPath (`Parameters`) or JSONata
 * (`Arguments`).
 */
export const stateMachines: RequestSource = {
  matches: (resource) => resource.cfnResourceType === "AWS::StepFunctions::StateMachine",
  noun: "state machine",
  read(resource) {
    const machine = resource as CfnStateMachine;
    const stack = Stack.of(machine);
    const read = definitionOf(machine, stack);
    if (typeof read === "string") return { unreadable: UNREADABLE[read] };
    const substitutions = Object.keys(
      (stack.resolve(machine.definitionSubstitutions) ?? {}) as object,
    );
    return dynamoTasks(read.definition, substitutions).map((task) => ({
      label: `state "${task.state}" (dynamodb:${task.action}) ${task.field}`,
      operation: task.action,
      value: task.payload,
    }));
  },
};
