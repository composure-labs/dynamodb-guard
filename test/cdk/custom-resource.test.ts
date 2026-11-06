import { type App, CfnResource, CustomResource, Fn, Lazy, type Stack } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  type AwsCustomResourceProps,
  type AwsSdkCall,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from "aws-cdk-lib/custom-resources";
import { describe, expect, it } from "vitest";
import { DYNAMODB_EXPRESSION_WARNING, dynamodbExpressionPolicy } from "../../src/cdk.js";
import { fixture, synth } from "./fixtures.js";

/** A call to DynamoDB's `updateItem`, with no parameters unless given. */
const sdkCall = (call: Partial<AwsSdkCall> = {}): AwsSdkCall => ({
  service: "DynamoDB",
  action: "updateItem",
  physicalResourceId: PhysicalResourceId.of("seed"),
  ...call,
});

/** An `updateItem` call whose `UpdateExpression` is `expression`, over a value `:v`. */
const update = (expression: unknown, call: Partial<AwsSdkCall> = {}): AwsSdkCall =>
  sdkCall({
    parameters: {
      TableName: "t",
      Key: { pk: { S: "p" } },
      UpdateExpression: expression,
      ExpressionAttributeValues: { ":v": { S: "v" } },
    },
    ...call,
  });

const seed = (stack: Stack, props: Partial<AwsCustomResourceProps>) =>
  new AwsCustomResource(stack, "Seed", {
    // Not fromSdkCalls: the floor can't derive an IAM action from every service form.
    policy: AwsCustomResourcePolicy.fromStatements([
      new PolicyStatement({ actions: ["dynamodb:*"], resources: ["*"] }),
    ]),
    ...props,
  });

const SEED = "/Stack/Seed/Resource/Default";
const RAW = "/Stack/Raw/Default";

/** A custom resource with `properties` as they are, for shapes `AwsCustomResource` doesn't emit. */
const rawResource = (stack: Stack, properties: Record<string, unknown>) =>
  new CustomResource(stack, "Raw", { serviceToken: "arn:aws:lambda:::function:f", properties });

const synthMessage = (app: App): string => {
  try {
    app.synth();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("synth did not throw");
};

const infoAt = (stack: Stack, path: string): string[] =>
  Annotations.fromStack(stack)
    .findInfo(path, Match.anyValue())
    .map((message) => message.entry.data as string);

describe("custom resources", () => {
  it("reports a reserved word in an AwsCustomResource call, with a token in the request", () => {
    const { app, stack, table } = fixture();
    seed(stack, {
      onCreate: sdkCall({
        parameters: {
          TableName: table.tableName,
          Key: { pk: { S: "p" } },
          UpdateExpression: "SET metrics = :v",
          ExpressionAttributeValues: { ":v": { S: "v" } },
        },
      }),
    });
    dynamodbExpressionPolicy(app);

    expect(synthMessage(app)).toBe(
      [
        "Stack/Seed/Resource/Default: DynamoDB would reject a request this custom resource sends.",
        "Create (dynamodb:updateItem) parameters:",
        '  UpdateExpression: "metrics" is a reserved word; alias it: ExpressionAttributeNames { "#metrics": "metrics" }.',
        "    SET metrics = :v",
        "        ^^^^^^^",
        "    See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html",
      ].join("\n"),
    );
  });

  it("passes calls DynamoDB accepts", () => {
    const { app, stack } = fixture();
    seed(stack, {
      onCreate: sdkCall({
        parameters: {
          UpdateExpression: "SET #m = :v",
          ExpressionAttributeNames: { "#m": "metrics" },
          ExpressionAttributeValues: { ":v": { S: "v" } },
        },
      }),
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).not.toThrow();
  });

  it.each(["DynamoDB", "dynamodb", "@aws-sdk/client-dynamodb"])("matches service %s", (service) => {
    const { app, stack } = fixture();
    seed(stack, { onCreate: update("SET metrics = :v", { service }) });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(/"metrics" is a reserved word/);
  });

  it.each(["updateItem", "UpdateItem", "UpdateItemCommand"])("reads action %s", (action) => {
    const { app, stack } = fixture();
    seed(stack, { onCreate: update("SET metrics = :v", { action }) });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(`Create (dynamodb:${action}) parameters:`);
  });

  it("matches by shape when resourceType is overridden", () => {
    const { app, stack } = fixture();
    seed(stack, { resourceType: "Custom::Seed", onCreate: update("SET metrics = :v") });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(/"metrics" is a reserved word/);
  });

  it("reports onUpdate once, though CDK also sets it as Create", () => {
    const { app, stack } = fixture();
    seed(stack, { onUpdate: update("SET metrics = :v") });
    dynamodbExpressionPolicy(app);

    const message = synthMessage(app);
    expect(message.match(/is a reserved word/g)).toHaveLength(1);
    expect(message).toContain("Update (dynamodb:updateItem) parameters:");
    expect(message).not.toContain("Create (");
  });

  it("reports each distinct phase", () => {
    const { app, stack } = fixture();
    seed(stack, {
      onCreate: update("SET metrics = :v"),
      onUpdate: update("SET status = :v"),
      onDelete: update("SET data = :v"),
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(
      /Create \(dynamodb:updateItem\) parameters:\n {2}UpdateExpression: "metrics"[\s\S]*Update \(dynamodb:updateItem\) parameters:\n {2}UpdateExpression: "status"[\s\S]*Delete \(dynamodb:updateItem\) parameters:\n {2}UpdateExpression: "data"/,
    );
  });

  it("checks each item of a transaction", () => {
    const { app, stack } = fixture();
    seed(stack, {
      onCreate: sdkCall({
        action: "transactWriteItems",
        parameters: { TransactItems: [{ Update: { UpdateExpression: "SET size = :v" } }] },
      }),
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).toThrow(
      /Create \(dynamodb:transactWriteItems\) parameters\.TransactItems\[0\]\.Update:\n {2}UpdateExpression: "size"/,
    );
  });

  it("ignores a GetItem's ExpressionAttributeValues, which the SDK never sends", () => {
    const { app, stack } = fixture();
    seed(stack, {
      onCreate: sdkCall({
        action: "getItem",
        parameters: { ProjectionExpression: "a", ExpressionAttributeValues: { ":v": { S: "v" } } },
      }),
    });
    dynamodbExpressionPolicy(app);

    expect(synth(app)).not.toThrow();
  });

  it("warns instead, with an id that can be acknowledged", () => {
    const { app, stack } = fixture();
    seed(stack, { onCreate: update("SET metrics = :v") });
    dynamodbExpressionPolicy(app, { onViolation: "warn" });

    expect(synth(app)).not.toThrow();
    Annotations.fromStack(stack).hasWarning(
      SEED,
      Match.stringLikeRegexp(
        `custom resource sends[\\s\\S]*\\[ack: ${DYNAMODB_EXPRESSION_WARNING}\\]`,
      ),
    );
  });

  describe("what it leaves alone", () => {
    it("ignores a phase that calls another service, beside one that calls DynamoDB", () => {
      const { app, stack } = fixture();
      seed(stack, {
        onCreate: update("SET a = :v"),
        onDelete: update("SET metrics = :v", { service: "SSM" }),
      });
      dynamodbExpressionPolicy(app);

      expect(synth(app)).not.toThrow();
    });

    it("doesn't fail synth if cfnProperties ever goes away, and reports it when asked", () => {
      class WithoutProperties extends CfnResource {
        protected override get cfnProperties(): Record<string, unknown> {
          return undefined as never;
        }
      }
      const { app, stack } = fixture();
      new WithoutProperties(stack, "Raw", { type: "Custom::Raw" });
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      expect(infoAt(stack, "/Stack/Raw")).toEqual([
        expect.stringContaining("doesn't expose its properties (cfnProperties)") as string,
      ]);
    });

    it.each(["SSM", "DynamoDBStreams"])("ignores a call to %s", (service) => {
      const { app, stack } = fixture();
      seed(stack, { onCreate: update("SET metrics = :v", { service }) });
      dynamodbExpressionPolicy(app);

      expect(synth(app)).not.toThrow();
    });

    it.each([
      ["no call properties", { Other: "x" }],
      ["a Create that isn't JSON", { Create: "{" }],
      ["a Create that is an intrinsic", { Create: Fn.sub("${AWS::Region}") }],
      ["a Create with no action", { Create: JSON.stringify({ service: "dynamodb" }) }],
    ])("ignores a custom resource with %s", (_name, properties) => {
      const { app, stack } = fixture();
      rawResource(stack, properties);
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      expect(infoAt(stack, RAW)).toEqual([]);
    });
  });

  describe("values not known at synth", () => {
    it("skips an expression built from a token, and reports it when asked", () => {
      const { app, stack, table } = fixture();
      seed(stack, { onCreate: update(`SET ${table.tableName} = :v`) });
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      expect(infoAt(stack, SEED)).toEqual([
        expect.stringContaining(
          "1 DynamoDB field(s) aren't known at synth and were not checked: Create (dynamodb:updateItem) parameters UpdateExpression.",
        ) as string,
      ]);
    });

    it.each([
      [
        "parameters that are wholly a token",
        { onCreate: sdkCall({ parameters: Fn.getAtt("Other", "Parameters") }) },
      ],
      ["a PhysicalResourceIdReference", { onDelete: update(new PhysicalResourceIdReference()) }],
      [
        "a call whose action is a token",
        {
          onCreate: update("SET metrics = :v", {
            action: Lazy.string({ produce: () => Fn.ref("AWS::Region") }),
          }),
        },
      ],
    ])("skips %s", (_name, props) => {
      const { app, stack } = fixture();
      seed(stack, props);
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      expect(infoAt(stack, SEED)).toHaveLength(1);
    });

    it("reads a call with no parameters", () => {
      const { app, stack } = fixture();
      seed(stack, { onCreate: sdkCall() });
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      expect(infoAt(stack, SEED)).toEqual([]);
    });

    it.each([
      ["a CloudFormation intrinsic", Fn.sub("${AWS::Region}")],
      ["invalid JSON", "{"],
    ])("reports a phase that is %s, beside one it can read", (reason, Delete) => {
      const { app, stack } = fixture();
      rawResource(stack, { Create: JSON.stringify(update("SET a = :v")), Delete });
      dynamodbExpressionPolicy(app, { reportUnchecked: true });

      expect(synth(app)).not.toThrow();
      expect(infoAt(stack, RAW)).toEqual([
        expect.stringContaining(`not checked: Delete (${reason}).`) as string,
      ]);
    });

    it("still checks the readable phase beside an unreadable one", () => {
      const { app, stack } = fixture();
      rawResource(stack, { Create: JSON.stringify(update("SET status = :v")), Delete: "{" });
      dynamodbExpressionPolicy(app);

      expect(synth(app)).toThrow(/"status" is a reserved word/);
    });
  });

  // The canary for #9. The policy reads AwsCustomResource through the protected
  // cfnProperties, so an aws-cdk-lib upgrade that moves its calls must fail here,
  // naming what moved, rather than leave the other tests failing with "expected
  // a throw". It checks only what CDK renders, never this package's own output.
  it("relies on a shape aws-cdk-lib still renders", () => {
    const broken = (what: string) =>
      `aws-cdk-lib changed how AwsCustomResource renders its calls: ${what}. ` +
      "src/cdk/custom-resource.ts reads them there, so without a fix the policy skips " +
      "every custom resource silently. See #9.";
    const { stack } = fixture();
    const calls = {
      Create: update("SET a = :v"),
      Update: update("SET b = :v"),
      Delete: update("SET c = :v"),
    };
    const custom = seed(stack, {
      onCreate: calls.Create,
      onUpdate: calls.Update,
      onDelete: calls.Delete,
    });
    const resource = custom.node
      .findAll()
      .find(
        (child): child is CfnResource =>
          CfnResource.isCfnResource(child) && child.cfnResourceType === "Custom::AWS",
      );
    if (resource === undefined) throw new Error(broken("no Custom::AWS CfnResource"));
    const { cfnProperties: properties } = resource as unknown as { cfnProperties: unknown };
    if (typeof properties !== "object" || properties === null) {
      throw new Error(broken("cfnProperties isn't an object"));
    }

    for (const [phase, call] of Object.entries(calls)) {
      const text: unknown = stack.resolve((properties as Record<string, unknown>)[phase]);
      expect(typeof text, broken(`${phase} isn't JSON text`)).toBe("string");
      expect(JSON.parse(String(text)), broken(`${phase} no longer holds the call`)).toMatchObject({
        service: call.service,
        action: call.action,
        parameters: call.parameters as object,
      });
    }
  });
});
