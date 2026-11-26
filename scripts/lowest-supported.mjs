#!/usr/bin/env node

/**
 * Prints the install specs for the *lowest* versions the peer ranges admit, one
 * per line, for CI's "Lowest supported" job.
 *
 * The lockfile always resolves the newest version in range, so without this a
 * floor (`aws-cdk-lib ^2.93.0`) is only ever tested at its newest end. Each
 * peer is installed at its range's minimum: the declared floor, which
 * composureCDK's ADR-0008 says must be proven rather than asserted.
 *
 * A peer with an `@types/` devDependency gets those types at the floor's major
 * too, since a consumer on the floor typechecks against them (ESLint 8 ships no
 * types of its own).
 *
 * Usage: see the `lowest-supported` job in .github/workflows/ci.yml.
 */

import { readFileSync } from "node:fs";
import semver from "semver";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const devs = manifest.devDependencies ?? {};

const specs = Object.entries(manifest.peerDependencies ?? {}).flatMap(([name, range]) => {
  const floor = semver.minVersion(range);
  const types = `@types/${name}`;
  return [`${name}@${floor.version}`, ...(types in devs ? [`${types}@${floor.major}`] : [])];
});

console.log(specs.join("\n"));
