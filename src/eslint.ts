/**
 * The lint guard: an ESLint plugin whose rule checks DynamoDB requests written
 * as object literals. Needs the optional `eslint` peer.
 */
import type { ESLint, Linter } from "eslint";
import { rule } from "./eslint/rule.js";

/**
 * The plugin object, built before `configs` so the preset registers this same
 * object: ESLint rejects a config that registers two objects under one name.
 */
const plugin: ESLint.Plugin = {
  meta: { name: "@composure-labs/dynamodb-guard" },
  rules: { "valid-expressions": rule },
};

/**
 * `recommended` turns the rule on as an error. It declares no `files`: only
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
    rules: { "dynamodb-guard/valid-expressions": "error" },
  },
} satisfies Record<string, Linter.Config>;

export const rules = plugin.rules;

export default Object.assign(plugin, { configs });
