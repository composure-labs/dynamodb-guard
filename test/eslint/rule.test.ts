import * as tsParser from "@typescript-eslint/parser";
import { Linter, RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
import dynamodbGuard, { configs, rules } from "../../src/eslint.js";
import { VERSION } from "../../src/core/version.js";
import { rule } from "../../src/eslint/rule.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
});

ruleTester.run("valid-expressions", rule, {
  valid: [
    {
      name: "an aliased update",
      code: `new UpdateCommand({ TableName: "t", Key: { id }, UpdateExpression: "SET #status = :s", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":s": "done" } });`,
    },
    {
      name: "a FilterExpression with nothing saying it is DynamoDB",
      code: `const request = { FilterExpression: "status = done" };`,
    },
    {
      name: "an expression held in a variable, which the rule can't see",
      code: `send({ TableName: "t", UpdateExpression: expression, ExpressionAttributeValues: { ":v": 1 } });`,
    },
    {
      name: "a spread, which may hold the maps",
      code: `send({ ...base, TableName: "t", UpdateExpression: "SET #a = :v" });`,
    },
    {
      name: "a computed map key, which makes the map unknowable",
      code: `send({ TableName: "t", UpdateExpression: "SET #a = :v", ExpressionAttributeNames: { [key]: "a" }, ExpressionAttributeValues: { ":v": 1 } });`,
    },
    {
      name: "a GetItem's ExpressionAttributeValues, which the SDK drops",
      code: `new GetItemCommand({ TableName: "t", Key: k, ProjectionExpression: "a", ExpressionAttributeValues: { ":v": v } });`,
    },
    {
      name: "a transaction Get's ExpressionAttributeValues, which the SDK drops",
      code: `send({ TransactItems: [{ Get: { Key: k, ProjectionExpression: "a", ExpressionAttributeValues: { ":v": v } } }] });`,
    },
    {
      name: "a BatchGetItem table's ExpressionAttributeValues, which the SDK drops",
      code: `send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ProjectionExpression: "a", ExpressionAttributeValues: { ":v": v } } } }));`,
    },
    {
      name: "a default for a destructured RequestItems, which is no request",
      code: `const { RequestItems = { t: { ProjectionExpression: "data" } } } = input;`,
    },
    {
      name: "an interpolated expression, with reportDynamic off",
      code: "send({ TableName: 't', UpdateExpression: `SET ${name} = :v` });",
      options: [{ reportDynamic: false }],
    },
    {
      name: "a ConditionExpression passed to a callee the rule can't name",
      code: `handlers[kind]({ ConditionExpression: "size > 1" }); pick()({ ConditionExpression: "size > 1" });`,
    },
    {
      name: "a non-string expression value, and a numeric key",
      code: `send({ TableName: "t", ProjectionExpression: 1, 2: "x" });`,
    },
    {
      name: "a map with nothing saying it is DynamoDB",
      code: `const aliases = { ExpressionAttributeNames: { "#a": "a" } };`,
    },
    {
      name: "a template literal with nothing interpolated",
      code: "send({ TableName: 't', UpdateExpression: `SET #a = :v`, ExpressionAttributeNames: { '#a': 'a' }, ExpressionAttributeValues: { ':v': 1 } });",
    },
    {
      name: "a ReturnValues the operation takes",
      code: `new PutCommand({ TableName: "t", Item: item, ReturnValues: "ALL_OLD", ReturnValuesOnConditionCheckFailure: ReturnValue.ALL_OLD });`,
    },
    {
      name: "a ReturnValues the rule can't read",
      code: `new PutCommand({ TableName: "t", Item: item, ReturnValues: options.returnValues }); new PutCommand({ TableName: "t", Item: item, ReturnValues: mode });`,
    },
    {
      name: "a ReturnValues where the rule can't see the operation",
      code: `const params = { TableName: "t", Item: item, ReturnValues: "ALL_NEW" }; send(params);`,
    },
    {
      name: "an AwsCustomResource call's ReturnValues, which its action takes",
      code: `new AwsCustomResource(this, "S", { onCreate: { service: "DynamoDB", action: "updateItem", parameters: { TableName: "t", Key: k, ReturnValues: "ALL_NEW" } } });`,
    },
    {
      name: "an AwsCustomResource call to another service, or with an action the rule can't read",
      code: `new AwsCustomResource(this, "S", { onCreate: { service: "SQS", action: "putItem", parameters: { TableName: "t", ReturnValues: "ALL_NEW" } } }); new AwsCustomResource(this, "T", { onCreate: { service: "DynamoDB", action, parameters: { TableName: "t", ReturnValues: "ALL_NEW" } } });`,
    },
    {
      name: "an AwsCustomResource getItem's ExpressionAttributeValues, which the SDK drops",
      code: `new AwsCustomResource(this, "S", { onCreate: { service: "dynamodb", action: "getItem", parameters: { Key: k, ProjectionExpression: "a", ExpressionAttributeValues: { ":v": v } } } });`,
    },
    {
      name: "a transaction item's ReturnValues, which the SDK drops",
      code: `send({ TransactItems: [{ Put: { TableName: "t", Item: item, ReturnValues: "ALL_NEW" } }] });`,
    },
    {
      name: "a ternary between an expression and undefined, which sends none",
      code: `new PutCommand({ TableName: "t", Item: item, ConditionExpression: create ? "attribute_not_exists(pk)" : undefined });`,
    },
    {
      name: "two ternaries whose conditions may be related, so placeholders aren't judged across them",
      code: `send({ TableName: "t", UpdateExpression: f ? "SET a = :v" : "REMOVE a", ConditionExpression: f ? "attribute_exists(b)" : "c = :v", ExpressionAttributeValues: { ":v": 1 } });`,
    },
    {
      name: "a ternary with a branch the rule can't read",
      code: `send({ TableName: "t", UpdateExpression: f ? "SET status = :a" : expression, ExpressionAttributeValues: { ":a": 1 } });`,
    },
  ],
  invalid: [
    {
      name: "a reserved word in one branch of a ternary, reported in that branch",
      code: `send({ TableName: "t", UpdateExpression: f ? "SET a = :a" : "SET status = :a", ExpressionAttributeValues: { ":a": 1 } });`,
      errors: [{ messageId: "reserved-word", column: 66, endColumn: 72 }],
    },
    {
      name: "a placeholder one branch of a ternary leaves unused",
      code: `send({ TableName: "t", UpdateExpression: f ? "SET a = :a, m = :m" : "SET a = :a REMOVE m", ExpressionAttributeValues: { ":a": a, ":m": m } });`,
      errors: [{ messageId: "unused-alias" }],
    },
    {
      name: "a nested ternary's last branch, which uses :c in place of :a",
      code: `send({ TableName: "t", UpdateExpression: f ? "SET a = :a" : g ? "SET b = :a" : "SET c = :c", ExpressionAttributeValues: { ":a": 1 } });`,
      errors: [{ messageId: "undefined-alias" }, { messageId: "unused-alias" }],
    },
    {
      name: "a name only the branch that sends an expression uses",
      code: `send({ TableName: "t", UpdateExpression: "SET a = :a", ConditionExpression: f ? "attribute_exists(#pk)" : undefined, ExpressionAttributeNames: { "#pk": "pk" }, ExpressionAttributeValues: { ":a": 1 } });`,
      errors: [{ messageId: "unused-alias" }],
    },
    {
      name: "a finding outside the ternary, reported once",
      code: `send({ TableName: "t", UpdateExpression: f ? "SET a = :a" : "SET b = :a", ConditionExpression: "attribute_exists(data)", ExpressionAttributeValues: { ":a": 1 } });`,
      errors: [{ messageId: "reserved-word" }],
    },
    {
      name: "#627: a reserved word two characters from an aliased one",
      code: `await client.send(new UpdateCommand({
  TableName: "jobs",
  Key: { id },
  UpdateExpression: "SET #status = :completed, metrics = :metrics",
  ExpressionAttributeNames: { "#status": "status" },
  ExpressionAttributeValues: { ":completed": "done", ":metrics": metrics },
}));`,
      errors: [{ messageId: "reserved-word", line: 4, column: 48, endColumn: 55 }],
    },
    {
      name: "an interpolated name",
      code: "send({ TableName: 't', UpdateExpression: `SET ${attribute} = :v`, ExpressionAttributeValues: { ':v': 1 } });",
      errors: [{ messageId: "dynamic" }],
    },
    {
      name: "a concatenated name",
      code: `send({ TableName: "t", UpdateExpression: "SET " + attribute + " = :v" });`,
      errors: [{ messageId: "dynamic" }],
    },
    {
      name: "placeholders with no entry, and entries with no use",
      code: `send({ TableName: "t", UpdateExpression: "SET #a = :v", ExpressionAttributeValues: { ":v": 1, ":w": 2 } });`,
      errors: [{ messageId: "undefined-alias", column: 47 }, { messageId: "unused-alias" }],
    },
    {
      name: "a transaction item, known by the operation it sits under",
      code: `send({ TransactItems: [{ Get: { Key: k, ProjectionExpression: "data" } }] });`,
      errors: [{ messageId: "reserved-word" }],
    },
    {
      name: "a BatchGetItem table, known by the RequestItems it sits under",
      code: `send({ RequestItems: { [TABLE]: { Keys: keys, ProjectionExpression: "id, data" } } });`,
      errors: [{ messageId: "reserved-word", column: 74, endColumn: 78 }],
    },
    {
      name: "a CDK DynamoUpdateItem's camelCase props",
      code: `new DynamoUpdateItem(this, "U", { table, key, updateExpression: "SET count = :c", expressionAttributeValues: { ":c": c } });`,
      errors: [{ messageId: "reserved-word" }],
    },
    {
      name: "a CDK task reached through a namespace, known by its callee alone",
      code: `new tasks.DynamoDeleteItem(this, "D", { key, conditionExpression: "attribute_exists(size)" });`,
      errors: [{ messageId: "reserved-word" }],
    },
    {
      name: "a map on a request with no expression",
      code: `send({ TableName: "t", Item: item, ExpressionAttributeNames: { "#a": "a" } });`,
      errors: [{ messageId: "names-without-expression" }],
    },
    {
      name: "an escaped string, reported as a whole",
      code: `send({ TableName: "t", ProjectionExpression: "a, \\u0073tatus" });`,
      errors: [{ messageId: "reserved-word", column: 46 }],
    },
    {
      name: "every bare name, with aliasAll",
      code: `send({ TableName: "t", UpdateExpression: "SET a = :v, status = :v", ExpressionAttributeValues: { ":v": 1 } });`,
      options: [{ aliasAll: true }],
      errors: [
        { messageId: "unaliased", column: 47, endColumn: 48 },
        { messageId: "reserved-word" },
      ],
    },
    {
      name: "a ReturnValues the SDK command's operation doesn't take, at the value",
      code: `new PutCommand({ TableName: "t", Item: item, ReturnValues: "ALL_NEW" });`,
      errors: [{ messageId: "return-values", column: 60, endColumn: 69 }],
    },
    {
      name: "a ReturnValues written as an SDK or CDK enum member",
      code: `new DeleteItemCommand({ TableName: "t", Key: k, ReturnValues: ReturnValue.UPDATED_OLD }); new DynamoPutItem(this, "P", { table, item, returnValues: tasks.DynamoReturnValues.ALL_NEW });`,
      errors: [{ messageId: "return-values" }, { messageId: "return-values" }],
    },
    {
      name: "a v2 Document client write, known by its method",
      code: `docClient.put({ TableName: "t", Item: item, ReturnValues: "UPDATED_NEW" });`,
      errors: [{ messageId: "return-values" }],
    },
    {
      name: "#41: an AwsCustomResource call's ReturnValues, known by the action beside it",
      code: `new AwsCustomResource(this, "S", { onUpdate: { service: "DynamoDB", action: "putItem", parameters: { TableName: "t", Item: item, ReturnValues: "ALL_NEW" } } });`,
      errors: [{ messageId: "return-values" }],
    },
    {
      name: "a transaction item's ReturnValuesOnConditionCheckFailure",
      code: `send({ TransactItems: [{ ConditionCheck: { Key: k, ConditionExpression: "attribute_exists(a)", ReturnValuesOnConditionCheckFailure: "ALL_NEW" } }] });`,
      errors: [{ messageId: "return-values" }],
    },
  ],
});

describe("plugin", () => {
  it("registers the same plugin object in its preset, so presets compose", () => {
    expect(configs.recommended.plugins["dynamodb-guard"]).toBe(dynamodbGuard);
    expect(rules).toBe(dynamodbGuard.rules);
  });

  it("names its version, which ESLint's cache reads", () => {
    expect(dynamodbGuard.meta?.version).toBe(VERSION);
  });

  it("runs from the recommended preset in a flat config", () => {
    const messages = new Linter().verify(
      `send({ TableName: "t", UpdateExpression: "SET name = gross-net" });`,
      [configs.recommended],
    );

    expect(messages.map((m) => [m.ruleId, m.severity, m.message])).toEqual([
      [
        "dynamodb-guard/valid-expressions",
        2,
        expect.stringMatching(/^"name" is a reserved word/) as string,
      ],
      [
        "dynamodb-guard/ambiguous-subtraction",
        1,
        expect.stringMatching(/^"gross-net" is read as gross - net/) as string,
      ],
    ]);
  });
});
