/**
 * The conformance corpus: requests DynamoDB accepts or rejects, each with one
 * fault at most, since DynamoDB reports only the first error it finds.
 * scripts/record-corpus.mjs sends every case to a real table and writes what
 * DynamoDB said to recorded.json; the checker's tests replay that recording, so
 * the checker is specified by the service, not by the docs.
 *
 * `fault` is the violation the checker should report (the kinds are in the
 * plan, laazyj/composureCDK#627), or `null` for a request DynamoDB should
 * accept. Where the docs leave the outcome open, write your best guess: the
 * recorder lists every case DynamoDB judged differently, and the test fails
 * until the fault matches.
 *
 * Every request runs against one seeded item (`SEED`), keyed `pk`/`data`.
 * `data` is a reserved word, which makes the key-condition cases possible.
 */

import { createHash } from "node:crypto";

export const KEY = { pk: "p", data: "d" };

/** The table's partition and sort key attribute names, in that order. */
export const [PARTITION_KEY, SORT_KEY] = Object.keys(KEY);

export const SEED = {
  ...KEY,
  a: 1,
  b: 2,
  c: 3,
  s: "text",
  l: [1, 2],
  n: { m: 1 },
  status: "s",
  metrics: 1,
  statuses: 1,
  "1abc": 1,
  "my-attr": 1,
  _u: 1,
  café: 1,
};

/** @typedef {"UpdateItem" | "PutItem" | "GetItem" | "Query" | "Scan"} Operation */
/** @typedef {{ id: string, fault: string | null, op: Operation, input: Record<string, unknown> }} Case */

/**
 * The request a case sends, less `TableName`. PutItem writes the seed itself,
 * so its condition is evaluated against it.
 */
export function request({ op, input }) {
  switch (op) {
    case "UpdateItem":
    case "GetItem":
      return { Key: KEY, ...input };
    case "PutItem":
      return { Item: SEED, ...input };
    default:
      return { ...input };
  }
}

/**
 * Identifies everything DynamoDB judged a case on: the operation, the request
 * and the seed. A recording keeps it, so a test can tell when either changed.
 */
export const requestHash = (testCase) =>
  createHash("sha256")
    .update(JSON.stringify({ op: testCase.op, request: request(testCase), seed: SEED }))
    .digest("hex")
    .slice(0, 16);

/** What DynamoDB should do with a case. */
export const expectedOutcome = ({ fault }) => (fault === null ? "accepted" : "rejected");

/** @returns {(id: string, fault: string | null, expression: string | undefined, extra?: object) => Case} */
const builder =
  (op, field) =>
  (id, fault, expression, extra = {}) => ({
    id,
    fault,
    op,
    input: { [field]: expression, ...extra },
  });

const update = builder("UpdateItem", "UpdateExpression");
const condition = builder("PutItem", "ConditionExpression");
const filter = builder("Scan", "FilterExpression");
const projection = builder("GetItem", "ProjectionExpression");
const keyCondition = builder("Query", "KeyConditionExpression");

const V = { ":v": 1 };
const P = { ":p": "p" };
const range = (count) => Array.from({ length: count }, (_, i) => i);

/** A name of `length` characters, distinct per `i`. */
const longName = (i, length) => `n${String(i)}`.padEnd(length, "x");

/** `count` distinct unaliased names joined into a projection. */
const longProjection = (count, length) =>
  range(count)
    .map((i) => longName(i, length))
    .join(", ");

/** `clauses` comparisons joined by OR: `clauses` comparators plus `clauses - 1` ORs. */
const orChain = (clauses) =>
  range(clauses)
    .map(() => "a = :v")
    .join(" OR ");

/** A filter with `count` operands to IN. */
const inCase = (id, fault, count) => {
  const placeholders = range(count).map((i) => `:v${String(i)}`);
  return filter(id, fault, `a IN (${placeholders.join(", ")})`, {
    ExpressionAttributeValues: Object.fromEntries(placeholders.map((p, i) => [p, i])),
  });
};

/** An update through a name placeholder `length` characters long, `#` included. */
const placeholderCase = (id, fault, length) => {
  const placeholder = `#${"x".repeat(length - 1)}`;
  return update(id, fault, `SET ${placeholder} = :v`, {
    ExpressionAttributeNames: { [placeholder]: "a" },
    ExpressionAttributeValues: V,
  });
};

/** @type {Case[]} */
export const CASES = [
  // Reserved words, in every expression kind and position.
  update("update-reserved-bare", "reserved-word", "SET status = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-reserved-aliased", null, "SET #s = :v", {
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: V,
  }),
  update("update-reserved-title-case", "reserved-word", "SET Status = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-reserved-upper-case", "reserved-word", "SET STATUS = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-reserved-path-segment", "reserved-word", "SET n.status = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-reserved-rhs-operand", "reserved-word", "SET a = metrics"),
  update("update-reserved-remove", "reserved-word", "REMOVE metrics"),
  update("update-reserved-function-arg", "reserved-word", "SET a = if_not_exists(metrics, :v)", {
    ExpressionAttributeValues: V,
  }),
  update("update-near-reserved", null, "SET statuses = :v", { ExpressionAttributeValues: V }),
  update("update-keywords-lower-case", null, "set a = :v remove b", {
    ExpressionAttributeValues: V,
  }),
  condition("condition-reserved", "reserved-word", "attribute_exists(status)"),
  condition("condition-reserved-aliased", null, "attribute_exists(#s)", {
    ExpressionAttributeNames: { "#s": "status" },
  }),
  filter("filter-reserved", "reserved-word", "metrics = :v", { ExpressionAttributeValues: V }),
  filter("filter-reserved-in-size", "reserved-word", "size(status) > :v", {
    ExpressionAttributeValues: V,
  }),
  projection("projection-reserved", "reserved-word", "a, status"),
  projection("projection-reserved-aliased", null, "a, #s", {
    ExpressionAttributeNames: { "#s": "status" },
  }),
  keyCondition("key-condition-reserved", "reserved-word", "pk = :p AND data = :d", {
    ExpressionAttributeValues: { ...P, ":d": "d" },
  }),
  keyCondition("key-condition-reserved-aliased", null, "pk = :p AND #d = :d", {
    ExpressionAttributeNames: { "#d": "data" },
    ExpressionAttributeValues: { ...P, ":d": "d" },
  }),

  // Names that need an alias for reasons other than being reserved.
  update("update-digit-leading", "must-alias", "SET 1abc = :v", { ExpressionAttributeValues: V }),
  update("update-digit-leading-aliased", null, "SET #n = :v", {
    ExpressionAttributeNames: { "#n": "1abc" },
    ExpressionAttributeValues: V,
  }),
  update("update-dash-lhs", "must-alias", "SET my-attr = :v", { ExpressionAttributeValues: V }),
  condition("condition-dash", "must-alias", "attribute_exists(my-attr)"),
  update("update-subtraction-spaced", null, "SET c = a - b"),
  update("update-subtraction-unspaced", null, "SET c = a-b"),
  update("update-nested-path", null, "SET n.m = :v", { ExpressionAttributeValues: V }),
  update("update-list-index", null, "SET l[0] = :v", { ExpressionAttributeValues: V }),
  update("update-underscore-leading", "must-alias", "SET _u = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-non-ascii", "must-alias", "SET café = :v", { ExpressionAttributeValues: V }),
  update("update-alias-digit-leading", null, "SET #1star = :v", {
    ExpressionAttributeNames: { "#1star": "a" },
    ExpressionAttributeValues: V,
  }),
  update("update-value-digit-leading", null, "SET a = :1v", {
    ExpressionAttributeValues: { ":1v": 1 },
  }),

  // Alias accounting, which DynamoDB does across the whole request.
  update("update-undefined-name", "undefined-alias", "SET #x = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-undefined-value", "undefined-alias", "SET a = :v"),
  update("update-unused-name", "unused-alias", "SET a = :v", {
    ExpressionAttributeNames: { "#u": "b" },
    ExpressionAttributeValues: V,
  }),
  update("update-unused-value", "unused-alias", "SET a = :v", {
    ExpressionAttributeValues: { ...V, ":w": 2 },
  }),
  update("update-name-shared-with-condition", null, "SET a = :v", {
    ConditionExpression: "attribute_exists(#s)",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: V,
  }),
  update("update-value-shared-with-condition", null, "SET a = :v", {
    ConditionExpression: "b <> :v",
    ExpressionAttributeValues: V,
  }),
  keyCondition("query-name-shared-with-filter", null, "pk = :p", {
    FilterExpression: "#m = :v",
    ExpressionAttributeNames: { "#m": "metrics" },
    ExpressionAttributeValues: { ...P, ...V },
  }),
  keyCondition("query-name-shared-with-projection", null, "pk = :p", {
    ProjectionExpression: "#m",
    ExpressionAttributeNames: { "#m": "metrics" },
    ExpressionAttributeValues: P,
  }),
  // GetItem takes no ExpressionAttributeValues: the SDK drops the field before
  // sending, so DynamoDB never sees it. Scan takes both maps.
  filter("scan-values-without-expression", "values-without-expression", undefined, {
    ExpressionAttributeValues: V,
  }),
  projection("get-names-without-expression", "names-without-expression", undefined, {
    ExpressionAttributeNames: { "#s": "status" },
  }),

  // Kind-specific grammar.
  keyCondition("key-condition-or", "kind-grammar", "pk = :p OR pk = :q", {
    ExpressionAttributeValues: { ...P, ":q": "q" },
  }),
  keyCondition("key-condition-not-equal", "kind-grammar", "pk <> :p", {
    ExpressionAttributeValues: P,
  }),
  keyCondition("key-condition-not", "kind-grammar", "NOT pk = :p", {
    ExpressionAttributeValues: P,
  }),
  keyCondition("key-condition-in", "kind-grammar", "pk IN (:p)", { ExpressionAttributeValues: P }),
  keyCondition("key-condition-contains", "kind-grammar", "pk = :p AND contains(#d, :d)", {
    ExpressionAttributeNames: { "#d": "data" },
    ExpressionAttributeValues: { ...P, ":d": "d" },
  }),
  keyCondition("key-condition-size", "kind-grammar", "pk = :p AND size(#d) > :n", {
    ExpressionAttributeNames: { "#d": "data" },
    ExpressionAttributeValues: { ...P, ":n": 0 },
  }),
  keyCondition("key-condition-begins-with", null, "pk = :p AND begins_with(#d, :d)", {
    ExpressionAttributeNames: { "#d": "data" },
    ExpressionAttributeValues: { ...P, ":d": "d" },
  }),
  keyCondition("key-condition-between", null, "pk = :p AND #d BETWEEN :x AND :y", {
    ExpressionAttributeNames: { "#d": "data" },
    ExpressionAttributeValues: { ...P, ":x": "a", ":y": "z" },
  }),
  condition("condition-if-not-exists", "kind-grammar", "if_not_exists(a, :v) = :v", {
    ExpressionAttributeValues: V,
  }),
  condition("condition-list-append", "kind-grammar", "size(list_append(l, :l)) > :n", {
    ExpressionAttributeValues: { ":l": [3], ":n": 0 },
  }),
  update("update-if-not-exists-rhs", null, "SET a = if_not_exists(a, :v)", {
    ExpressionAttributeValues: V,
  }),
  update("update-list-append-rhs", null, "SET l = list_append(l, :l)", {
    ExpressionAttributeValues: { ":l": [3] },
  }),
  update("update-function-lhs", "kind-grammar", "SET if_not_exists(a, :v) = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-condition-function-in-set", "kind-grammar", "SET a = attribute_exists(b)"),
  projection("projection-function", "kind-grammar", "size(l)"),
  filter("filter-functions", null, "size(l) > :v AND begins_with(s, :t) AND contains(l, :v)", {
    ExpressionAttributeValues: { ...V, ":t": "te" },
  }),

  // Clause structure and syntax.
  update("update-clause-repeated", "syntax", "SET a = :v SET b = :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-clauses-any-order", null, "REMOVE b SET a = :v ADD c :v", {
    ExpressionAttributeValues: V,
  }),
  update("update-overlapping-paths", "overlapping-paths", "SET a = :v, a = :w", {
    ExpressionAttributeValues: { ...V, ":w": 2 },
  }),
  update("update-empty", "syntax", ""),
  update("update-missing-operand", "syntax", "SET a ="),
  condition("condition-unbalanced-paren", "syntax", "attribute_exists(a"),

  // Limits.
  projection("projection-under-4kb", null, longProjection(20, 200)),
  projection("projection-over-4kb", "limit", longProjection(21, 200)),
  filter("filter-299-operators", null, orChain(150), { ExpressionAttributeValues: V }),
  filter("filter-301-operators", "limit", orChain(151), { ExpressionAttributeValues: V }),
  inCase("filter-in-100-operands", null, 100),
  inCase("filter-in-101-operands", "limit", 101),
  placeholderCase("update-name-placeholder-255", null, 255),
  placeholderCase("update-name-placeholder-256", "limit", 256),
];

const ids = CASES.map(({ id }) => id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicates.length > 0) {
  // At load, so neither the recorder nor the tests can run with a case shadowed.
  throw new Error(`Duplicate corpus case ids: ${duplicates.join(", ")}`);
}
