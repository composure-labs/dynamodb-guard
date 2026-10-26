import { App, Stack } from "aws-cdk-lib";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  CfnStateMachine,
  type CfnStateMachineProps,
  DefinitionBody,
  type IChainable,
  JsonPath,
  StateMachine,
} from "aws-cdk-lib/aws-stepfunctions";
import { DynamoAttributeValue } from "aws-cdk-lib/aws-stepfunctions-tasks";

export function fixture() {
  const app = new App();
  const stack = new Stack(app, "Stack");
  const table = new Table(stack, "Table", {
    partitionKey: { name: "pk", type: AttributeType.STRING },
  });
  const key = { pk: DynamoAttributeValue.fromString(JsonPath.stringAt("$.id")) };
  return { app, stack, table, key };
}

export const synth = (app: App) => () => app.synth();

export const machine = (stack: Stack, chain: IChainable) =>
  new StateMachine(stack, "Machine", { definitionBody: DefinitionBody.fromChainable(chain) });

export const ROLE_ARN = "arn:aws:iam::123456789012:role/r";

/** A Task state calling `dynamodb:updateItem` with `parameters`, over a value `:v`. */
export const updateTask = (parameters: Record<string, unknown>) => ({
  Resource: "arn:aws:states:::dynamodb:updateItem",
  Parameters: { TableName: "t", ExpressionAttributeValues: { ":v": { S: "v" } }, ...parameters },
});

export const definition = (state: Record<string, unknown>) => ({
  StartAt: "Task",
  States: { Task: { Type: "Task", End: true, ...state } },
});

/** An L1 state machine named "Raw" whose one state is `state`, for shapes CDK's L2s don't emit. */
export const rawMachine = (
  stack: Stack,
  state: Record<string, unknown>,
  props: Partial<CfnStateMachineProps> = {},
) =>
  new CfnStateMachine(stack, "Raw", {
    roleArn: ROLE_ARN,
    definition: definition(state),
    ...props,
  });
