import { type DynamoRequest, isRecord } from "../core/check.js";
import { checkRequestsIn, formatSites } from "../core/requests.js";
import type { Violation } from "../core/violations.js";

/**
 * Where the requests come from: anything that records what was sent, read by
 * shape so no mocking library is a dependency.
 *
 * - An `aws-sdk-client-mock` stub, or anything with `calls()` returning
 *   `{ args }` records: `mockClient(DynamoDBDocumentClient)`.
 * - A Vitest or Jest mock function, or anything with `mock.calls`:
 *   `vi.spyOn(client, "send")`.
 * - An array of what was sent: SDK commands, or their inputs.
 *
 * Each call's first argument is the request: an SDK command, whose `input` is
 * checked, or the input itself.
 */
export type DynamoRequestSource =
  | { calls(): readonly { readonly args: readonly unknown[] }[] }
  | { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }
  | readonly unknown[];

/** One request DynamoDB would reject, and where it was found. */
export interface RejectedRequest {
  /** Which call sent it, counting from 0. */
  readonly call: number;
  /** The command's class name, such as `UpdateCommand`; `undefined` for a plain input. */
  readonly command: string | undefined;
  /** Where in the call's input the request sits; `""` for the input itself. */
  readonly path: string;
  readonly request: DynamoRequest;
  readonly violations: readonly Violation[];
}

/** What each call sent, in order. */
function sent(source: DynamoRequestSource): unknown[] {
  if (Array.isArray(source)) return source;
  if ("calls" in source && typeof source.calls === "function") {
    return source.calls().map((call) => call.args[0]);
  }
  if ("mock" in source) return source.mock.calls.map((args) => args[0]);
  throw new TypeError(
    "Expected an aws-sdk-client-mock stub, a mock function, or an array of requests.",
  );
}

/** A command's input and class name, or a plain input as it is. */
function unwrap(value: unknown): { input: unknown; command?: string } {
  if (!isRecord(value) || !isRecord(value.input)) return { input: value };
  const name: unknown = value.constructor.name;
  return {
    input: value.input,
    command: typeof name === "string" && name !== "Object" ? name : undefined,
  };
}

/**
 * Every request the source sent that DynamoDB would reject, with its
 * violations. Requests are found by shape, so any DynamoDB client and command
 * works, as does each item of a transaction; calls that aren't DynamoDB
 * requests have no expressions to check.
 */
export function rejectedDynamoRequests(source: DynamoRequestSource): RejectedRequest[] {
  const rejected: RejectedRequest[] = [];
  sent(source).forEach((value, call) => {
    const { input, command } = unwrap(value);
    for (const { path, request, violations } of checkRequestsIn(input, command)) {
      if (violations.length > 0) rejected.push({ call, command, path, request, violations });
    }
  });
  return rejected;
}

/** The failure message for a non-empty list of rejected requests. */
function report(rejected: readonly RejectedRequest[]): string {
  const count = rejected.length === 1 ? "a request" : `${String(rejected.length)} requests`;
  const blocks = formatSites(
    rejected.map((site) => {
      const where = [site.command, site.path].filter(Boolean).join(" ");
      return { ...site, label: `call ${String(site.call)}${where === "" ? "" : ` (${where})`}` };
    }),
  );
  return `DynamoDB would reject ${count}:\n${blocks}`;
}

/**
 * Throws if any request the source sent would be rejected by DynamoDB,
 * listing every one. Call it after each test, from a setup file, so no test
 * has to remember to, and clear the source after it so the next test starts
 * empty.
 *
 * @example
 * ```ts
 * const ddb = mockClient(DynamoDBDocumentClient);
 * afterEach(() => {
 *   assertValidDynamoRequests(ddb);
 *   ddb.reset();
 * });
 * ```
 */
export function assertValidDynamoRequests(source: DynamoRequestSource): void {
  const rejected = rejectedDynamoRequests(source);
  if (rejected.length > 0) throw new Error(report(rejected));
}

/**
 * Matchers for `expect.extend`, in Vitest or Jest:
 * `expect(ddb).toHaveOnlyValidDynamoRequests()`.
 */
export const dynamodbGuardMatchers = {
  toHaveOnlyValidDynamoRequests(received: DynamoRequestSource) {
    const rejected = rejectedDynamoRequests(received);
    const pass = rejected.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? "Expected a request DynamoDB would reject, but it would accept every one."
          : report(rejected),
    };
  },
};
