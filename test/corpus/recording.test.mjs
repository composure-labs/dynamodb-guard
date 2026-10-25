import { describe, expect, it } from "vitest";
import recording from "./recorded.json" with { type: "json" };
import { CASES, expectedOutcome, requestHash } from "./cases.mjs";

const RERECORD = "re-run `npm run corpus:record` (CONTRIBUTING.md#the-conformance-corpus)";

describe("the conformance corpus recording", () => {
  it("has a current recording for every case", () => {
    const missing = CASES.filter(({ id }) => !(id in recording.cases)).map(({ id }) => id);
    const stale = CASES.filter(
      (c) => c.id in recording.cases && recording.cases[c.id].hash !== requestHash(c),
    ).map(({ id }) => id);

    expect(missing, `cases with no recording: ${RERECORD}`).toEqual([]);
    expect(stale, `cases changed since they were recorded: ${RERECORD}`).toEqual([]);
  });

  it("records nothing for a case that no longer exists", () => {
    const ids = new Set(CASES.map(({ id }) => id));

    expect(
      Object.keys(recording.cases).filter((id) => !ids.has(id)),
      RERECORD,
    ).toEqual([]);
  });

  it("agrees with every case's fault", () => {
    const disagreements = CASES.filter(
      (c) => c.id in recording.cases && recording.cases[c.id].outcome !== expectedOutcome(c),
    ).map((c) => `${c.id}: fault ${String(c.fault)}, DynamoDB ${recording.cases[c.id].outcome}`);

    expect(disagreements).toEqual([]);
  });
});
