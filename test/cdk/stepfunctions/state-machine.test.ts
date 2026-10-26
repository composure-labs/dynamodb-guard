import { CfnParameter, Fn } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import { CfnStateMachine, Map as MapState, Parallel } from "aws-cdk-lib/aws-stepfunctions";
import {
  CallAwsService,
  DynamoAttributeValue,
  DynamoDeleteItem,
  DynamoGetItem,
  DynamoProjectionExpression,
  DynamoUpdateItem,
} from "aws-cdk-lib/aws-stepfunctions-tasks";
import { describe, expect, it } from "vitest";
import { dynamodbExpressionPolicy } from "../../../src/cdk.js";
import {
  definition,
  fixture,
  machine,
  rawMachine,
  ROLE_ARN,
  synth,
  updateTask,
} from "../fixtures.js";

describe("state machines", () => {
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
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      Annotations.fromStack(stack).hasInfo(
        "/Stack/Raw",
        Match.stringLikeRegexp(
          /1 DynamoDB field\(s\) aren't known at synth.*: state "Task" \(dynamodb:updateItem\) Parameters UpdateExpression\./
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
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      Annotations.fromStack(stack).hasInfo(
        "/Stack/Raw",
        Match.stringLikeRegexp(/2 DynamoDB field\(s\) aren't known at synth/.source),
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
      const roleArn = ROLE_ARN;
      new CfnStateMachine(stack, "InS3", {
        roleArn,
        definitionS3Location: { bucket: "b", key: "k" },
      });
      new CfnStateMachine(stack, "NotJson", { roleArn, definitionString: "{" });
      new CfnStateMachine(stack, "Sub", {
        roleArn,
        definitionString: Fn.sub('{"StartAt":"${AWS::Region}"}'),
      });
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

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
});
