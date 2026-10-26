import * as cdk from "aws-cdk-lib";
import { Aspects } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import {
  DynamoAttributeValue,
  DynamoUpdateItem,
  type DynamoUpdateItemProps,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { describe, expect, it } from "vitest";
import { DYNAMODB_EXPRESSION_WARNING, dynamodbExpressionPolicy } from "../../src/cdk.js";
import { definition, fixture, rawMachine, synth, machine, updateTask } from "./fixtures.js";

/** A state machine whose one state is a `DynamoUpdateItem` named "Complete". */
function updateItemMachine(
  expression: string,
  props: Partial<DynamoUpdateItemProps> = {},
): ReturnType<typeof fixture> {
  const fx = fixture();
  machine(
    fx.stack,
    new DynamoUpdateItem(fx.stack, "Complete", {
      table: fx.table,
      key: fx.key,
      updateExpression: expression,
      expressionAttributeValues: { ":m": DynamoAttributeValue.fromNumber(1) },
      ...props,
    }),
  );
  return fx;
}

describe("dynamodbExpressionPolicy", () => {
  it("catches #627: a reserved word interpolated into a DynamoUpdateItem expression", () => {
    const attribute = "metrics";
    const { app } = updateItemMachine(`SET ${attribute} = :m`);
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(
      [
        "Stack/Machine/Resource: DynamoDB would reject a request this state machine sends.",
        'state "Complete" (dynamodb:updateItem) Parameters:',
        '  UpdateExpression: "metrics" is a reserved word; alias it: ExpressionAttributeNames { "#metrics": "metrics" }.',
        "    SET metrics = :m",
        "        ^^^^^^^",
        "    See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html",
      ].join("\n"),
    );
  });

  it("passes a state machine whose requests DynamoDB accepts", () => {
    const { app } = updateItemMachine("SET #metrics = :m", {
      expressionAttributeNames: { "#metrics": "metrics" },
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).not.toThrow();
  });

  it("annotates what it couldn't check only when asked", () => {
    const unchecked = (config: { reportUnchecked?: boolean }) => {
      const { app, stack } = fixture();
      rawMachine(stack, updateTask({ "UpdateExpression.$": "$.expression" }));
      dynamodbExpressionPolicy(app, config);
      app.synth();
      return Annotations.fromStack(stack).findInfo("/Stack/Raw", Match.anyValue()).length;
    };

    expect([unchecked({}), unchecked({ reportUnchecked: true })]).toEqual([0, 1]);
  });

  it("warns instead, with an id that can be acknowledged", () => {
    const { app, stack } = updateItemMachine("SET metrics = :m");
    dynamodbExpressionPolicy(app, { onViolation: "warn" });

    expect(synth(app)).not.toThrow();
    Annotations.fromStack(stack).hasWarning(
      "/Stack/Machine/Resource",
      Match.stringLikeRegexp(
        `"metrics" is a reserved word[\\s\\S]*\\[ack: ${DYNAMODB_EXPRESSION_WARNING}\\]`,
      ),
    );
  });

  // Before AspectPriority, Aspects run in the order they were added.
  it.runIf("AspectPriority" in cdk)("runs after Aspects that change the definition", () => {
    const { app, stack } = fixture();
    const raw = rawMachine(stack, updateTask({ UpdateExpression: "SET a = :v" }));
    dynamodbExpressionPolicy(app);
    Aspects.of(app).add({
      visit(node) {
        if (node === raw)
          raw.definition = definition(updateTask({ UpdateExpression: "SET name = :v" }));
      },
    });

    expect(synth(app)).toThrow(/"name" is a reserved word/);
  });
});
