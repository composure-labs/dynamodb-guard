import * as tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import * as unsupported from "eslint/use-at-your-own-risk";
import { describe, it } from "vitest";

/**
 * ESLint 8's default RuleTester reads eslintrc and ships the flat-config one as
 * FlatRuleTester; CI's lowest-supported job runs these tests on ESLint 8.
 */
const FlatRuleTester = Object.assign(
  (unsupported as { FlatRuleTester?: typeof RuleTester }).FlatRuleTester ?? RuleTester,
  { describe, it },
);

export const ruleTester = new FlatRuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
});
