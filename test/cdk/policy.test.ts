import * as cdk from "aws-cdk-lib";
import { App, Aspects, CfnParameter, Fn, Stack } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import { AttributeType, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  CfnStateMachine,
  type CfnStateMachineProps,
  DefinitionBody,
  type IChainable,
  JsonPath,
  Map as MapState,
  Parallel,
  StateMachine,
} from "aws-cdk-lib/aws-stepfunctions";
import {
  CallAwsService,
  DynamoAttributeValue,
  DynamoDeleteItem,
  DynamoGetItem,
  DynamoProjectionExpression,
  DynamoUpdateItem,
  type DynamoUpdateItemProps,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { describe, expect, it } from "vitest";
import { DYNAMODB_EXPRESSION_WARNING, dynamodbExpressionPolicy } from "../../src/cdk.js";

function fixture() {
  const app = new App();
  const stack = new Stack(app, "Stack");
  const table = new Table(stack, "Table", {
    partitionKey: { name: "pk", type: AttributeType.STRING },
  });
  const key = { pk: DynamoAttributeValue.fromString(JsonPath.stringAt("$.id")) };
  return { app, stack, table, key };
}

const synth = (app: App) => () => app.synth();

const machine = (stack: Stack, chain: IChainable) =>
  new StateMachine(stack, "Machine", { definitionBody: DefinitionBody.fromChainable(chain) });

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

/** A Task state calling `dynamodb:updateItem` with `parameters`, over a value `:v`. */
const updateTask = (parameters: Record<string, unknown>) => ({
  Resource: "arn:aws:states:::dynamodb:updateItem",
  Parameters: { TableName: "t", ExpressionAttributeValues: { ":v": { S: "v" } }, ...parameters },
});

const definition = (state: Record<string, unknown>) => ({
  StartAt: "Task",
  States: { Task: { Type: "Task", End: true, ...state } },
});

/** An L1 state machine named "Raw" whose one state is `state`, for shapes CDK's L2s don't emit. */
const rawMachine = (
  stack: Stack,
  state: Record<string, unknown>,
  props: Partial<CfnStateMachineProps> = {},
) =>
  new CfnStateMachine(stack, "Raw", {
    roleArn: "arn:aws:iam::123456789012:role/r",
    definition: definition(state),
    ...props,
  });

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

  it("checks SDK integrations, and each item of a transaction", () => {
    const { app, stack, table } = fixture();
    machine(
      stack,
      new CallAwsService(stack, "Write", {
        service: "dynamodb",
        action: "transactWriteItems",
        iamResources: ["*"],
        parameters: {
          TransactItems: [
            { Put: { TableName: table.tableName, Item: {} } },
            {
              Update: {
                TableName: table.tableName,
                Key: { pk: { S: "p" } },
                UpdateExpression: "SET a = :a",
                ExpressionAttributeValues: { ":a": { S: "a" }, ":b": { S: "b" } },
              },
            },
          ],
        },
      }),
    );
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(
      /state "Write" \(dynamodb:transactWriteItems\) Parameters\.TransactItems\[1\]\.Update:\n {2}ExpressionAttributeValues: :b is in/,
    );
  });

  it("finds tasks inside Parallel branches and Map iterators", () => {
    const { app, stack, table, key } = fixture();
    const get = new DynamoGetItem(stack, "Get", {
      table,
      key,
      projectionExpression: [new DynamoProjectionExpression().withAttribute("data")],
    });
    const del = new DynamoDeleteItem(stack, "Delete", {
      table,
      key,
      conditionExpression: "attribute_exists(size)",
    });
    machine(
      stack,
      new Parallel(stack, "Both")
        .branch(get)
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- itemProcessor postdates the aws-cdk-lib floor
        .branch(new MapState(stack, "Each").iterator(del)),
    );
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(
      /state "Get" \(dynamodb:getItem\) Parameters:\n {2}ProjectionExpression: "data" is a reserved word[\s\S]*state "Delete" \(dynamodb:deleteItem\) Parameters:\n {2}ConditionExpression: "size" is a reserved word/,
    );
  });

  it("reads a distributed Map's ItemProcessor, JSONata Arguments, and a partition token", () => {
    const { app, stack } = fixture();
    rawMachine(stack, {
      Type: "Map",
      ItemProcessor: {
        ProcessorConfig: { Mode: "DISTRIBUTED", ExecutionType: "STANDARD" },
        StartAt: "Query",
        States: {
          Query: {
            Type: "Task",
            End: true,
            QueryLanguage: "JSONata",
            Resource: `arn:${stack.partition}:states:::aws-sdk:dynamodb:query`,
            Arguments: {
              TableName: "t",
              KeyConditionExpression: "pk = :p",
              FilterExpression: "status = :s",
              ExpressionAttributeValues: {
                ":p": { S: "{% $states.input.id %}" },
                ":s": { S: "a" },
              },
            },
          },
        },
      },
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(
      /state "Query" \(dynamodb:query\) Arguments:\n {2}FilterExpression: "status" is a reserved word/,
    );
  });

  it("reads a DefinitionString with a token outside any JSON string", () => {
    const { app, stack } = fixture();
    // CDK leaves a number token unquoted in the rendered definition.
    const timeout = new CfnParameter(stack, "Timeout", { type: "Number" }).valueAsNumber;
    rawMachine(
      stack,
      {},
      {
        definition: undefined,
        definitionString: stack.toJsonString(
          definition({
            Comment: 'An escaped \\" quote, then a "quoted" word',
            TimeoutSeconds: timeout,
            ...updateTask({ UpdateExpression: "SET count = :v" }),
          }),
        ),
      },
    );
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(/"count" is a reserved word/);
  });

  describe("values not known at synth", () => {
    it("skips a JSONPath .$ expression, without reporting the entries it may use", () => {
      const { app, stack } = fixture();
      rawMachine(
        stack,
        updateTask({
          "UpdateExpression.$": "States.Format('SET {} = :v', $.attribute)",
          ConditionExpression: "attribute_exists(pk)",
        }),
      );
      dynamodbExpressionPolicy(app);

      expect(synth(app)).not.toThrow();
      Annotations.fromStack(stack).hasInfo(
        "/Stack/Raw",
        Match.stringLikeRegexp(
          /1 DynamoDB field\(s\) are dynamic.*: state "Task" \(dynamodb:updateItem\) Parameters UpdateExpression\./
            .source,
        ),
      );
    });

    it("skips a JSONata {% %} expression, and a whole JSONata payload", () => {
      const { app, stack } = fixture();
      const getItem = (name: string, Arguments: unknown) => ({
        StartAt: name,
        States: {
          [name]: {
            Type: "Task",
            End: true,
            Resource: "arn:aws:states:::dynamodb:getItem",
            Arguments,
          },
        },
      });
      rawMachine(stack, {
        Type: "Parallel",
        Branches: [
          getItem("A", { TableName: "t", ProjectionExpression: "{% $states.input.fields %}" }),
          getItem("B", "{% $states.input.request %}"),
        ],
      });
      dynamodbExpressionPolicy(app);

      expect(synth(app)).not.toThrow();
      Annotations.fromStack(stack).hasInfo(
        "/Stack/Raw",
        Match.stringLikeRegexp(/2 DynamoDB field\(s\) are dynamic/.source),
      );
    });

    it("skips an expression built from a token, but still checks the rest", () => {
      const { app, stack, table, key } = fixture();
      machine(
        stack,
        new DynamoUpdateItem(stack, "Complete", {
          table,
          key,
          updateExpression: `SET ${table.tableName} = :m`,
          conditionExpression: "attribute_exists(#missing)",
          expressionAttributeValues: { ":m": DynamoAttributeValue.fromNumber(1) },
        }),
      );
      dynamodbExpressionPolicy(app);

      expect(synth(app)).toThrow(/#missing is used but not defined/);
    });

    it("can't judge undefined names when the names map is dynamic", () => {
      const { app, stack } = fixture();
      rawMachine(
        stack,
        updateTask({ UpdateExpression: "SET #a = :v", "ExpressionAttributeNames.$": "$.names" }),
      );
      dynamodbExpressionPolicy(app);

      expect(synth(app)).not.toThrow();
    });

    it("compares a dynamic name only with itself", () => {
      const { app, stack } = fixture();
      rawMachine(
        stack,
        updateTask({
          UpdateExpression: "SET #a = :v, #b = :v, #a = :v",
          ExpressionAttributeNames: { "#a.$": "$.first", "#b.$": "$.second" },
        }),
      );
      dynamodbExpressionPolicy(app);

      expect(synth(app)).toThrow(/"#a" is updated twice/);
    });

    it("skips a DefinitionSubstitutions placeholder", () => {
      const { app, stack } = fixture();
      rawMachine(stack, updateTask({ UpdateExpression: "SET ${Attribute} = :v" }), {
        definitionSubstitutions: { Attribute: "metrics" },
      });
      dynamodbExpressionPolicy(app);

      expect(synth(app)).not.toThrow();
    });

    it("reports a definition it can't read", () => {
      const { app, stack } = fixture();
      const roleArn = "arn:aws:iam::123456789012:role/r";
      new CfnStateMachine(stack, "InS3", {
        roleArn,
        definitionS3Location: { bucket: "b", key: "k" },
      });
      new CfnStateMachine(stack, "NotJson", { roleArn, definitionString: "{" });
      new CfnStateMachine(stack, "Sub", {
        roleArn,
        definitionString: Fn.sub('{"StartAt":"${AWS::Region}"}'),
      });
      dynamodbExpressionPolicy(app);

      expect(synth(app)).not.toThrow();
      const annotations = Annotations.fromStack(stack);
      annotations.hasInfo("/Stack/InS3", Match.stringLikeRegexp("definition is in S3"));
      annotations.hasInfo("/Stack/NotJson", Match.stringLikeRegexp("isn't valid JSON"));
      annotations.hasInfo("/Stack/Sub", Match.stringLikeRegexp("is a CloudFormation intrinsic"));
    });
  });

  it("ignores a GetItem's ExpressionAttributeValues, which the SDK never sends", () => {
    const { app, stack } = fixture();
    rawMachine(stack, {
      Resource: "arn:aws:states:::dynamodb:getItem",
      Parameters: {
        TableName: "t",
        ProjectionExpression: "a",
        ExpressionAttributeValues: { ":v": { S: "v" } },
      },
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).not.toThrow();
  });

  it("ignores tasks that don't call DynamoDB", () => {
    const { app, stack } = fixture();
    rawMachine(stack, {
      ...updateTask({ UpdateExpression: "SET status = :v" }),
      Resource: "arn:aws:states:::aws-sdk:s3:getObject",
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).not.toThrow();
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
