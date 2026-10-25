// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";
import composurecdk from "@composurecdk/eslint-plugin";
import { readFileSync } from "node:fs";
import { ENTRIES, withSubpaths } from "./scripts/entries.mjs";

const { peerDependencies } = JSON.parse(
  readFileSync(new URL("package.json", import.meta.url), "utf8"),
);

/**
 * Each entry point may import only its own peers, and nothing from another
 * entry's directory except the shared `src/core/`. Derived from
 * scripts/entries.mjs, which scripts/check-entries.mjs also enforces through
 * the bundle; this gives the same answer earlier, in the editor.
 */
const entryImportBans = Object.entries(ENTRIES).map(([entry, { src, peers }]) => {
  const banned = Object.keys(peerDependencies).filter((peer) => !peers.includes(peer));
  const others = Object.keys(ENTRIES)
    .filter((other) => other !== "." && other !== entry)
    .map((other) => other.slice(2));
  const patterns = [];
  if (banned.length > 0) {
    patterns.push({
      group: withSubpaths(banned),
      message: `${entry} must load without this optional peer.`,
    });
  }
  if (others.length > 0) {
    // Relative specifiers only, so the `eslint` package doesn't match `src/eslint/`.
    const regex = `^\\.{1,2}/(.+/)?(${others.join("|")})(\\.js|/|$)`;
    patterns.push({ regex, message: `${entry} may share code only through src/core.` });
  }
  return { files: src, rules: { "no-restricted-imports": ["error", { patterns }] } };
});

export default defineConfig(
  {
    ignores: ["dist/", ".tshy/", ".tshy-build/", "coverage/"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true } },
  },
  {
    // Outside tsconfig, so not type-checked.
    files: ["eslint.config.mjs", "vitest.config.ts", "scripts/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["eslint.config.mjs", "scripts/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly", URL: "readonly" },
    },
  },
  {
    // The tiers true of this package (ADR-0019): it publishes types for others
    // to compile against (`libraryAuthor`) and ships ESM + CommonJS from one
    // source (`dualPublishing`). It writes no Lifecycle or builder, so
    // `recommended` does not apply, and `internal` is composureCDK's own.
    files: ["src/**/*.ts"],
    extends: [composurecdk.configs.libraryAuthor, composurecdk.configs.dualPublishing],
  },
  ...entryImportBans,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: { "@eslint-community/eslint-comments": eslintComments },
    rules: {
      "@eslint-community/eslint-comments/require-description": "error",
    },
  },
  eslintConfigPrettier,
);
