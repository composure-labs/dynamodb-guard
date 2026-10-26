import { type ActionPath, byteLength, parseExpression, tooMany } from "./parse.js";
import {
  DOC_LINKS,
  EXPRESSION_FIELDS,
  type ExpressionField,
  type ExpressionKind,
  type Violation,
  type ViolationKind,
} from "./violations.js";

/** The most bytes DynamoDB accepts in one `#name` or `:value` placeholder. */
export const MAX_PLACEHOLDER_BYTES = 255;

/**
 * The parts of a DynamoDB request the checker reads. Any other field, such as
 * `TableName`, `Key` or `Item`, is ignored, so an SDK command's input can be
 * passed as it is.
 */
export interface DynamoRequest {
  readonly UpdateExpression?: string;
  readonly ConditionExpression?: string;
  readonly KeyConditionExpression?: string;
  readonly FilterExpression?: string;
  readonly ProjectionExpression?: string;
  readonly ExpressionAttributeNames?: Readonly<Record<string, string>>;
  readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>>;
}

type MapField = "ExpressionAttributeNames" | "ExpressionAttributeValues";

/**
 * Checks one expression on its own: names, grammar for its kind, and limits.
 * Placeholders are not checked against any map; use {@link checkRequest} for
 * that, since DynamoDB accounts for them across the whole request.
 */
export function checkExpression(expression: string, kind: ExpressionKind): Violation[] {
  return [...parseExpression(expression, kind).violations];
}

/** `a.b[0]`, from its segments. */
const show = (segments: readonly string[]): string => segments.join(".").replaceAll(".[", "[");

/** Whether path `a` is `b` or contains it: `a` contains `a.b` and `a[0]`. */
const contains = (a: readonly string[], b: readonly string[]): boolean =>
  a.length <= b.length && a.every((segment, i) => segment === b[i]);

function overlappingPaths(
  paths: readonly ActionPath[],
  names: DynamoRequest["ExpressionAttributeNames"],
): Violation[] {
  // Compare what DynamoDB compares: the paths with `#name` placeholders resolved.
  const resolved = paths.map(({ segments }) =>
    segments.map((segment) => (segment.startsWith("#") ? (names?.[segment] ?? segment) : segment)),
  );
  const violations: Violation[] = [];
  resolved.forEach((later, j) => {
    const earlier = resolved
      .slice(0, j)
      .find((path) => contains(path, later) || contains(later, path));
    if (earlier === undefined) return;
    const [first, second] = [show(earlier), show(later)];
    const path = paths[j];
    violations.push({
      kind: "overlapping-paths",
      field: "UpdateExpression",
      message: `${first === second ? `"${first}" is updated twice` : `"${first}" and "${second}" overlap`}; one update can't act on both. Combine or remove one.`,
      token: show(path.segments),
      offset: path.offset,
    });
  });
  return violations;
}

function mapViolations(
  field: MapField,
  withoutExpression: ViolationKind,
  map: Readonly<Record<string, unknown>> | undefined,
  used: ReadonlySet<string>,
  hasExpression: boolean,
): Violation[] {
  if (map === undefined) return [];
  if (!hasExpression) {
    return [
      {
        kind: withoutExpression,
        field,
        message: `${field} can only be given with an expression; this request has none.`,
      },
    ];
  }
  const violations: Violation[] = [];
  const unused = Object.keys(map).filter((key) => !used.has(key));
  if (unused.length > 0) {
    const [verb, them] = unused.length === 1 ? ["is", "it"] : ["are", "them"];
    violations.push({
      kind: "unused-alias",
      field,
      message: `${unused.join(", ")} ${verb} in ${field} but no expression uses ${them}; remove ${them}.`,
      token: unused.join(", "),
    });
  }
  for (const key of Object.keys(map)) {
    const bytes = byteLength(key);
    if (bytes > MAX_PLACEHOLDER_BYTES) {
      violations.push({
        kind: "limit",
        field,
        message: tooMany(
          `The placeholder ${key.slice(0, 20)}… is # bytes`,
          bytes,
          MAX_PLACEHOLDER_BYTES,
        ),
        token: key,
      });
    }
  }
  return violations;
}

/**
 * Checks a request as DynamoDB would: every expression it carries, and its
 * `ExpressionAttributeNames` and `ExpressionAttributeValues`, which are shared
 * by all of them. Returns every violation found; an empty array means
 * DynamoDB should accept the expressions.
 */
export function checkRequest(request: DynamoRequest): Violation[] {
  const { ExpressionAttributeNames: names, ExpressionAttributeValues: values } = request;
  const used: Record<MapField, Set<string>> = {
    ExpressionAttributeNames: new Set(),
    ExpressionAttributeValues: new Set(),
  };
  const violations: Violation[] = [];
  let hasExpression = false;

  for (const [field, kind] of Object.entries(EXPRESSION_FIELDS) as [
    ExpressionField,
    ExpressionKind,
  ][]) {
    const expression = request[field];
    if (typeof expression !== "string") continue;
    hasExpression = true;
    const parsed = parseExpression(expression, kind);
    violations.push(...parsed.violations);
    for (const [mapField, map, placeholders] of [
      ["ExpressionAttributeNames", names, parsed.names],
      ["ExpressionAttributeValues", values, parsed.values],
    ] as const) {
      for (const [placeholder, offset] of placeholders) {
        used[mapField].add(placeholder);
        if (map === undefined || !(placeholder in map)) {
          violations.push({
            kind: "undefined-alias",
            field,
            message: `${placeholder} is used but not defined; add it to ${mapField}.`,
            token: placeholder,
            offset,
          });
        }
      }
    }
    if (field === "UpdateExpression")
      violations.push(...overlappingPaths(parsed.actionPaths, names));
  }

  violations.push(
    ...mapViolations(
      "ExpressionAttributeNames",
      "names-without-expression",
      names,
      used.ExpressionAttributeNames,
      hasExpression,
    ),
    ...mapViolations(
      "ExpressionAttributeValues",
      "values-without-expression",
      values,
      used.ExpressionAttributeValues,
      hasExpression,
    ),
  );
  return violations;
}

/** Each violation on its own lines: the message, a caret under the token, and the AWS doc. */
export function formatViolations(request: DynamoRequest, violations: readonly Violation[]): string {
  return violations
    .map((violation) => {
      const lines = [`${violation.field}: ${violation.message}`];
      const expression = request[violation.field];
      if (
        typeof expression === "string" &&
        violation.offset !== undefined &&
        violation.token !== undefined
      ) {
        lines.push(
          `  ${expression}`,
          `  ${" ".repeat(violation.offset)}${"^".repeat(Math.max(1, violation.token.length))}`,
        );
      }
      lines.push(`  See ${DOC_LINKS[violation.kind]}`);
      return lines.join("\n");
    })
    .join("\n");
}

/** Thrown by {@link assertRequest}, holding every violation it found. */
export class DynamoExpressionError extends Error {
  override readonly name = "DynamoExpressionError";

  constructor(
    readonly violations: readonly Violation[],
    request: DynamoRequest,
  ) {
    super(`DynamoDB would reject this request:\n${formatViolations(request, violations)}`);
  }
}

/** {@link checkRequest}, throwing a {@link DynamoExpressionError} listing every violation. */
export function assertRequest(request: DynamoRequest): void {
  const violations = checkRequest(request);
  if (violations.length > 0) throw new DynamoExpressionError(violations, request);
}
