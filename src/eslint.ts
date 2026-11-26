/**
 * The lint guard: an ESLint plugin whose rules check DynamoDB requests written
 * as object literals. Needs the optional `eslint` peer.
 */
import type { ESLint } from "eslint";
import { VERSION } from "./core/version.js";
import { ambiguousSubtraction } from "./eslint/ambiguous-subtraction.js";
import { rule } from "./eslint/rule.js";

/**
 * The plugin object, built before `configs` so the preset registers this same
 * object: ESLint rejects a config that registers two objects under one name.
 */
const plugin: ESLint.Plugin = {
  // ESLint's cache and --print-config read the version.
  meta: { name: "@composure-labs/dynamodb-guard", version: VERSION },
  rules: { "valid-expressions": rule, "ambiguous-subtraction": ambiguousSubtraction },
};

/**
 * The preset's type, spelled out so the declarations name only `eslint`'s
 * types. Inferred, they inline `@eslint/core`, which ESLint 8 doesn't install.
 */
interface RecommendedConfig {
  name: string;
  plugins: { "dynamodb-guard": ESLint.Plugin };
  rules: {
    "dynamodb-guard/valid-expressions": "error";
    "dynamodb-guard/ambiguous-subtraction": "warn";
  };
}

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
export const configs: { recommended: RecommendedConfig } = {
  recommended: {
    name: "dynamodb-guard/recommended",
    plugins: { "dynamodb-guard": plugin },
    rules: {
      "dynamodb-guard/valid-expressions": "error",
      "dynamodb-guard/ambiguous-subtraction": "warn",
    },
  },
};

export const rules: ESLint.Plugin["rules"] = plugin.rules;

const dynamodbGuard: ESLint.Plugin & { configs: typeof configs } = Object.assign(plugin, {
  configs,
});
export default dynamodbGuard;
