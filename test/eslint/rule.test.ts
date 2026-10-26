import * as tsParser from "@typescript-eslint/parser";
import { Linter, RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
import dynamodbGuard, { configs, rules } from "../../src/eslint.js";
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
  ],
  invalid: [
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
  ],
});

describe("plugin", () => {
  it("registers the same plugin object in its preset, so presets compose", () => {
    expect(configs.recommended.plugins["dynamodb-guard"]).toBe(dynamodbGuard);
    expect(rules).toBe(dynamodbGuard.rules);
  });

  it("runs from the recommended preset in a flat config", () => {
    const messages = new Linter().verify(
      `send({ TableName: "t", UpdateExpression: "SET name = :v", ExpressionAttributeValues: { ":v": 1 } });`,
      [configs.recommended],
    );

    expect(messages.map((m) => [m.ruleId, m.message])).toEqual([
      [
        "dynamodb-guard/valid-expressions",
        expect.stringMatching(/^"name" is a reserved word/) as string,
      ],
    ]);
  });
});
