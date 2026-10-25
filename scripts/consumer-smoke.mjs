#!/usr/bin/env node

/**
 * Packs the package as `npm publish` would, installs it into a fresh project,
 * and loads every entry point through both `import` and `require()`.
 *
 * It runs in two phases, because the peers are optional:
 *
 * 1. **No peers.** The entries scripts/entries.mjs marks peerless must load in a
 *    project with no aws-cdk-lib, constructs or eslint: a handler's test suite, say.
 * 2. **With peers.** Every entry loads once the peers are installed.
 *
 * Type resolution, including `moduleResolution: node10` through `typesVersions`,
 * is `check:exports`' job (attw), not this script's.
 *
 * Run it on Node, never another runtime: a more permissive resolver would hide
 * exactly the ESM/CJS mistakes this exists to catch.
 *
 * Usage: node scripts/consumer-smoke.mjs [<package.tgz>]
 *   With a tarball (CI's Consumer job, which reuses Verify's), installs that.
 *   Without one, packs this checkout first; needs `npm run build`, since
 *   `files` ships `dist`.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRIES } from "./entries.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = manifest.name;

const specifier = (entry) => JSON.stringify(entry === "." ? name : `${name}${entry.slice(1)}`);
const PEERLESS = Object.keys(ENTRIES).filter((entry) => ENTRIES[entry].peers.length === 0);
const ALL = Object.keys(ENTRIES);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    console.error(result.stdout, result.stderr);
    console.error(`✗ ${command} ${args.join(" ")} failed in ${cwd}`);
    process.exit(1);
  }
  return result.stdout;
}

/** Each peer at the version package-lock.json pins, so no install is needed here. */
function lockedPeers() {
  const locked = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")).packages;
  return Object.keys(manifest.peerDependencies ?? {}).map((peer) => {
    const version = locked[`node_modules/${peer}`]?.version;
    if (version === undefined) {
      console.error(`✗ package-lock.json pins no ${peer}`);
      process.exit(1);
    }
    return `${peer}@${version}`;
  });
}

/** Loads every entry in one process per module system. */
function load(entries, project) {
  const imports = entries.map((entry) => `await import(${specifier(entry)});`).join("\n");
  const requires = entries.map((entry) => `require(${specifier(entry)});`).join("\n");
  run("node", ["--input-type=module", "-e", imports], project);
  run("node", ["--input-type=commonjs", "-e", requires], project);
}

const project = mkdtempSync(join(tmpdir(), "dynamodb-guard-consumer-"));
try {
  const tarball =
    process.argv[2] === undefined
      ? join(
          project,
          JSON.parse(run("npm", ["pack", "--json", "--pack-destination", project], root))[0]
            .filename,
        )
      : resolve(process.argv[2]);
  writeFileSync(join(project, "package.json"), '{ "private": true }\n');

  // Phase 1. npm does not install optional peers, so this is a peerless project.
  run("npm", ["install", "--no-audit", "--no-fund", tarball], project);
  load(PEERLESS, project);
  console.log(`✓ Node ${process.version}: ${PEERLESS.join(", ")} load with no peers installed.`);

  // Phase 2. No --legacy-peer-deps: a consumer's install enforces the peer ranges.
  run("npm", ["install", "--no-audit", "--no-fund", ...lockedPeers()], project);
  load(ALL, project);
  console.log(`✓ Node ${process.version}: every entry point loads with the peers installed.`);
} finally {
  rmSync(project, { recursive: true, force: true });
}
