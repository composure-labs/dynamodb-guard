import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { VERSION } from "../src/core/version.js";

it("VERSION is package.json's version; run `node scripts/write-version.mjs` if not", () => {
  const { version } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };

  expect(VERSION).toBe(version);
});
