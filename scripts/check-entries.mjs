#!/usr/bin/env node

/**
 * Bundles every entry point, recording each package it imports (every one is
 * left external, so nothing is actually bundled), and fails if an entry
 * imports a package other than its own peers (scripts/entries.mjs), or grows
 * past its size budget. That is how "the root and /testing load
 * with no peers, /cdk needs no ESLint" is enforced through re-exports and
 * shared modules, which the import bans in eslint.config.mjs cannot see.
 *
 * It also fails if the table stops matching package.json's `tshy.exports` and
 * `typesVersions`, so a new entry point can't go unchecked.
 *
 * Usage: node scripts/check-entries.mjs (after `npm run build`)
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import { ENTRIES } from "./entries.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Minified bytes of the package's own code. Generous for a word list, a tokeniser and a walker. */
const BUDGET = 30 * 1024;

const problems = [];
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const exported = Object.keys(manifest.tshy.exports).filter((key) => key !== "./package.json");
if (!same(Object.keys(ENTRIES), exported)) {
  problems.push(
    `scripts/entries.mjs lists ${Object.keys(ENTRIES).join(", ")}; tshy.exports has ${exported.join(", ")}`,
  );
}
const subpaths = exported.filter((key) => key !== ".").map((key) => key.slice(2));
if (!same(Object.keys(manifest.typesVersions["*"]), subpaths)) {
  problems.push(
    `typesVersions must list exactly ${subpaths.join(", ")} (moduleResolution: node10)`,
  );
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
const packageOf = (path) =>
  path
    .split("/")
    .slice(0, path.startsWith("@") ? 2 : 1)
    .join("/");

for (const [entry, { peers }] of Object.entries(ENTRIES)) {
  const source = manifest.tshy.exports[entry];
  if (source === undefined) continue;
  const file = source.replace(/^\.\/src\//, "dist/esm/").replace(/\.ts$/, ".js");
  const imported = new Set();
  const { outputFiles } = await build({
    absWorkingDir: root,
    entryPoints: [file],
    bundle: true,
    minify: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "record-packages",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, ({ path }) => {
            if (!isBuiltin(path)) imported.add(packageOf(path));
            return { path, external: true };
          });
        },
      },
    ],
  });
  const disallowed = [...imported].filter((name) => !peers.includes(name));
  const bytes = outputFiles[0].contents.byteLength;
  const allowed = peers.length === 0 ? "no peers" : peers.join(", ");
  if (disallowed.length > 0) {
    problems.push(`${entry} may load only ${allowed}, but imports ${disallowed.join(", ")}`);
  } else if (bytes > BUDGET) {
    problems.push(`${entry} is ${String(bytes)} bytes minified, over the ${String(BUDGET)} budget`);
  } else {
    console.log(`✓ ${entry}: ${String(bytes)} bytes minified, loads ${allowed}.`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
