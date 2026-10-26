import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  assertValidDynamoRequests,
  dynamodbGuardMatchers,
  rejectedDynamoRequests,
} from "../../src/testing.js";

expect.extend(dynamodbGuardMatchers);

declare module "vitest" {
  interface Matchers {
    toHaveOnlyValidDynamoRequests(): void;
  }
}

/** A mock of `client` that is restored when the test finishes, pass or fail. */
function stub(client: typeof DynamoDBClient | typeof DynamoDBDocumentClient) {
  const mock = mockClient(client);
  onTestFinished(() => {
    mock.restore();
  });
  return mock;
}

const documentClient = () => DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** The #627 handler: `status` aliased by habit, `metrics` two characters along not. */
async function completeJob(client: DynamoDBDocumentClient, id: string, metrics: object) {
  await client.send(
    new UpdateCommand({
      TableName: "jobs",
      Key: { id },
      UpdateExpression: "SET #status = :completed, metrics = :metrics",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":completed": "done", ":metrics": metrics },
    }),
  );
}

describe("assertValidDynamoRequests", () => {
  it("catches #627: an unaliased reserved word in a handler's UpdateCommand", async () => {
    const ddb = stub(DynamoDBDocumentClient);
    await completeJob(documentClient(), "1", { runs: 1 });

    expect(() => {
      assertValidDynamoRequests(ddb);
    }).toThrow(
      [
        "DynamoDB would reject a request:",
        "call 0 (UpdateCommand):",
        '  UpdateExpression: "metrics" is a reserved word; alias it: ExpressionAttributeNames { "#metrics": "metrics" }.',
        "    SET #status = :completed, metrics = :metrics",
        "                              ^^^^^^^",
        "    See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html",
      ].join("\n"),
    );
  });

  it("passes when every request would be accepted", async () => {
    const ddb = stub(DynamoDBClient);
    await new DynamoDBClient({}).send(
      new QueryCommand({
        TableName: "t",
        KeyConditionExpression: "pk = :p",
        ExpressionAttributeValues: { ":p": { S: "p" } },
      }),
    );

    expect(() => {
      assertValidDynamoRequests(ddb);
    }).not.toThrow();
  });

  it("checks every call, and each item of a transaction", async () => {
    const ddb = stub(DynamoDBDocumentClient);
    const client = documentClient();
    await client.send(new GetCommand({ TableName: "t", Key: { id: "1" } }));
    await client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: "t", Item: { id: "1" } } },
          {
            Update: {
              TableName: "t",
              Key: { id: "2" },
              UpdateExpression: "SET #a = :v",
              ExpressionAttributeValues: { ":v": 1 },
            },
          },
        ],
      }),
    );

    expect(
      rejectedDynamoRequests(ddb).map(({ call, command, path }) => [call, command, path]),
    ).toEqual([[1, "TransactWriteCommand", "TransactItems[1].Update"]]);
  });

  it("ignores a GetItem's ExpressionAttributeValues, which the SDK drops", async () => {
    const ddb = stub(DynamoDBClient);
    // GetItemCommandInput has no such field, so only a variable gets one past tsc.
    const input = {
      TableName: "t",
      Key: { id: { S: "1" } },
      ProjectionExpression: "a",
      ExpressionAttributeValues: { ":v": { S: "v" } },
    };
    await new DynamoDBClient({}).send(new GetItemCommand(input));

    expect(rejectedDynamoRequests(ddb)).toEqual([]);
  });

  it("reads a spy on send, and an array of commands or inputs", async () => {
    const client = new DynamoDBClient({});
    const send = vi.spyOn(client, "send").mockResolvedValue({} as never);
    const update = new UpdateItemCommand({
      TableName: "t",
      Key: { id: { S: "1" } },
      UpdateExpression: "SET name = :v",
      ExpressionAttributeValues: { ":v": { S: "v" } },
    });
    await client.send(update);

    expect(rejectedDynamoRequests(send)[0]?.command).toBe("UpdateItemCommand");
    expect(rejectedDynamoRequests([update])[0]?.command).toBe("UpdateItemCommand");
    expect(rejectedDynamoRequests([update.input])[0]).toMatchObject({
      call: 0,
      command: undefined,
      path: "",
    });
  });

  it("lists every rejected request", () => {
    expect(() => {
      assertValidDynamoRequests([
        { ProjectionExpression: "data" },
        { FilterExpression: "size = :v" },
      ]);
    }).toThrow(/^DynamoDB would reject 2 requests:\ncall 0:\n[\s\S]*\ncall 1:\n/);
  });

  it("rejects a source it can't read", () => {
    expect(() => rejectedDynamoRequests({} as never)).toThrow(
      /Expected an aws-sdk-client-mock stub/,
    );
  });
});

describe("dynamodbGuardMatchers", () => {
  it("passes, and fails with the report", async () => {
    const ddb = stub(DynamoDBDocumentClient);
    expect(ddb).toHaveOnlyValidDynamoRequests();

    await completeJob(documentClient(), "1", {});
    expect(() => {
      expect(ddb).toHaveOnlyValidDynamoRequests();
    }).toThrow(/DynamoDB would reject a request:\ncall 0 \(UpdateCommand\):/);
    expect(() => {
      expect(ddb).not.toHaveOnlyValidDynamoRequests();
    }).not.toThrow();
  });

  it("explains a negated failure", () => {
    expect(() => {
      expect([]).not.toHaveOnlyValidDynamoRequests();
    }).toThrow(/Expected a request DynamoDB would reject/);
  });
});
