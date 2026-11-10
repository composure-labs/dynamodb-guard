import * as tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
import { ambiguousSubtraction } from "../../src/eslint/ambiguous-subtraction.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
});

const update = (expression: string): string =>
  `send({ TableName: "t", UpdateExpression: "${expression}", ExpressionAttributeValues: { ":v": 1 } });`;

ruleTester.run("ambiguous-subtraction", ambiguousSubtraction, {
  valid: [
    { name: "a spaced subtraction", code: update("SET total = my - attr") },
    { name: "a subtraction spaced on one side", code: update("SET total = my -attr") },
    { name: "an aliased name", code: update("SET total = #a-#b") },
    { name: "a value on one side", code: update("SET total = my-:v") },
    { name: "an addition", code: update("SET total = my+attr") },
    {
      name: "a hyphenated name on the left of SET, which valid-expressions reports",
      code: update("SET my-attr = :v"),
    },
    {
      name: "a condition, where a - is no operator",
      code: `send({ TableName: "t", ConditionExpression: "a-b = :v", ExpressionAttributeValues: { ":v": 1 } });`,
    },
    {
      name: "an object with nothing saying it is DynamoDB",
      code: `const request = { FilterExpression: "a-b" };`,
    },
  ],
  invalid: [
    {
      name: "an unspaced - between two names",
      code: update("SET total = my-attr"),
      errors: [
        {
          message:
            '"my-attr" is read as my - attr, a subtraction. Write "my - attr" if that is meant, ' +
            'or alias the name: ExpressionAttributeNames { "#my_attr": "my-attr" }.',
          column: 55,
          endColumn: 62,
        },
      ],
    },
    {
      name: "the last segment of a path",
      code: update("SET a = :v, total = item.my-attr"),
      errors: [{ messageId: "ambiguous", column: 68, endColumn: 75 }],
    },
    {
      name: "a CDK task's camelCase props",
      code: `new DynamoUpdateItem(this, "U", { table, key, updateExpression: "SET total = gross-net" });`,
      errors: [{ messageId: "ambiguous" }],
    },
    {
      name: "a transaction item",
      code: `send({ TransactItems: [{ Update: { Key: k, UpdateExpression: "SET total = gross-net" } }] });`,
      errors: [{ messageId: "ambiguous" }],
    },
  ],
});
