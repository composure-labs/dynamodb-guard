/**
 * The lint guard: an ESLint plugin whose rules check DynamoDB requests written
 * as object literals. Needs the optional `eslint` peer.
 */
import type { ESLint, Linter } from "eslint";
import { ambiguousSubtraction } from "./eslint/ambiguous-subtraction.js";
import { rule } from "./eslint/rule.js";

/**
 * The plugin object, built before `configs` so the preset registers this same
 * object: ESLint rejects a config that registers two objects under one name.
 */
const plugin: ESLint.Plugin = {
  meta: { name: "@composure-labs/dynamodb-guard" },
  rules: { "valid-expressions": rule, "ambiguous-subtraction": ambiguousSubtraction },
};

/**
 * `recommended` turns `valid-expressions` on as an error, since DynamoDB would
 * reject what it reports, and `ambiguous-subtraction` on as a warning, since
 * DynamoDB accepts what it reports. It declares no `files`: only
 * the consumer knows where their code lives.
 *
 * ```js
 * import dynamodbGuard from "@composure-labs/dynamodb-guard/eslint";
 * export default [dynamodbGuard.configs.recommended];
 * ```
 */
export const configs = {
  recommended: {
    name: "dynamodb-guard/recommended",
    plugins: { "dynamodb-guard": plugin },
    rules: {
      "dynamodb-guard/valid-expressions": "error",
      "dynamodb-guard/ambiguous-subtraction": "warn",
    },
  },
} satisfies Record<string, Linter.Config>;

export const rules = plugin.rules;

export default Object.assign(plugin, { configs });
