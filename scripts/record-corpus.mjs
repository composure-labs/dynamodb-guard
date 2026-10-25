#!/usr/bin/env node

/**
 * Records the conformance corpus (test/corpus/cases.mjs) against real
 * DynamoDB, writing test/corpus/recorded.json. Run by a maintainer, by hand,
 * when a case is added or changed; CI only ever replays the recording.
 *
 * It creates one on-demand table named `dynamodb-guard-corpus-<timestamp>`,
 * re-seeds the item before each case so updates can't leak between cases, and
 * deletes the table at the end, on failure too. About 140 requests: well under
 * a cent.
 *
 * A ValidationException is a rejection, and the message is kept. A
 * ConditionalCheckFailedException means the expression was valid and merely
 * false, so it counts as accepted. Any other error stops the run, and so does a
 * case field the SDK would drop before sending: DynamoDB would never see it,
 * and the recording would claim it was accepted.
 *
 * Usage: AWS_PROFILE=<profile> AWS_REGION=<region> npm run corpus:record
 */

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  CASES,
  PARTITION_KEY,
  SEED,
  SORT_KEY,
  expectedOutcome,
  request,
  requestHash,
} from "../test/corpus/cases.mjs";

const region = process.env.AWS_REGION;
if (region === undefined || region === "") {
  console.error("✗ Set AWS_REGION (and AWS_PROFILE) to the sandbox account.");
  process.exit(1);
}

const OUTPUT = new URL("../test/corpus/recorded.json", import.meta.url);
const TableName = `dynamodb-guard-corpus-${String(Date.now())}`;
const sdkVersion = createRequire(import.meta.url)("@aws-sdk/client-dynamodb/package.json").version;

const COMMANDS = {
  UpdateItem: UpdateCommand,
  PutItem: PutCommand,
  GetItem: GetCommand,
  Query: QueryCommand,
  Scan: ScanCommand,
};

const client = new DynamoDBClient({ region });
const ddb = DynamoDBDocumentClient.from(client);

// Fails a request whose input has a field the serialised body lacks: one the
// operation doesn't take (GetItem has no ExpressionAttributeValues), or a typo.
ddb.middlewareStack.add(
  (next) => async (args) => {
    const { body } = args.request;
    const sent = JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body));
    const dropped = Object.keys(args.input).filter(
      (field) => args.input[field] !== undefined && !(field in sent),
    );
    if (dropped.length > 0) {
      throw new Error(`The SDK drops ${dropped.join(", ")} from this operation; fix the case.`);
    }
    return next(args);
  },
  { step: "build", name: "rejectDroppedFields" },
);

/** Strips anything account-specific from a service message. */
const scrub = (message) =>
  message.replaceAll(/arn:aws[\w:/.-]*/g, "<arn>").replaceAll(/\b\d{12}\b/g, "<account>");

async function record(testCase) {
  await ddb.send(new PutCommand({ TableName, Item: SEED }));
  try {
    await ddb.send(new COMMANDS[testCase.op]({ TableName, ...request(testCase) }));
    return { outcome: "accepted" };
  } catch (error) {
    if (error.name === "ConditionalCheckFailedException") return { outcome: "accepted" };
    if (error.name === "ValidationException") {
      return { outcome: "rejected", message: scrub(error.message) };
    }
    throw new Error(`${testCase.id}: ${error.message}`, { cause: error });
  }
}

console.log(`Creating ${TableName} in ${region}…`);
await client.send(
  new CreateTableCommand({
    TableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: PARTITION_KEY, AttributeType: "S" },
      { AttributeName: SORT_KEY, AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: PARTITION_KEY, KeyType: "HASH" },
      { AttributeName: SORT_KEY, KeyType: "RANGE" },
    ],
    Tags: [{ Key: "purpose", Value: "dynamodb-guard conformance corpus" }],
  }),
);

try {
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName });

  const cases = {};
  const disagreements = [];
  for (const testCase of CASES) {
    const result = await record(testCase);
    cases[testCase.id] = { hash: requestHash(testCase), ...result };
    if (result.outcome !== expectedOutcome(testCase)) {
      const detail = result.message === undefined ? "" : ` (${result.message})`;
      disagreements.push(
        `${testCase.id}: fault ${String(testCase.fault)}, DynamoDB ${result.outcome}${detail}`,
      );
    }
  }

  const recording = {
    recordedAt: new Date().toISOString().slice(0, 10),
    region,
    sdk: `@aws-sdk/client-dynamodb@${sdkVersion}`,
    cases,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(recording, null, 2)}\n`);

  const rejected = Object.values(cases).filter((result) => result.outcome === "rejected").length;
  console.log(
    `✓ Recorded ${String(CASES.length)} cases (${String(rejected)} rejected) to test/corpus/recorded.json.`,
  );
  if (disagreements.length > 0) {
    console.log("\nDynamoDB judged these differently from their fault. Update the faults:");
    for (const note of disagreements) console.log(`  - ${note}`);
  }
} finally {
  console.log(`Deleting ${TableName}…`);
  await client.send(new DeleteTableCommand({ TableName }));
  await waitUntilTableNotExists({ client, maxWaitTime: 120 }, { TableName });
}
