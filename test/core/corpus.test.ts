import { describe, expect, it } from "vitest";
import { CASES, request } from "../corpus/cases.mjs";
import { checkRequest } from "../../src/index.js";

describe("checkRequest against the conformance corpus", () => {
  // Each case has one fault, so the checker must report exactly that kind and
  // nothing else; a case DynamoDB accepts must produce no violation at all.
  it.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, testCase) => {
    const kinds = new Set(checkRequest(request(testCase)).map(({ kind }) => kind));

    expect([...kinds]).toEqual(testCase.fault === null ? [] : [testCase.fault]);
  });
});
