import { type DynamoRequest, isRecord } from "./check.js";

/** One request found by {@link findRequests}, and where it sits in the value searched. */
export interface RequestSite {
  /** Where the request was found, such as `TransactItems[1].Update`; `""` for the value itself. */
  readonly path: string;
  readonly request: DynamoRequest;
}

/** The operations a `TransactWriteItems` or `TransactGetItems` item can hold. */
const TRANSACT_OPERATIONS = ["Update", "ConditionCheck", "Put", "Delete", "Get"] as const;

/**
 * Operations that take no `ExpressionAttributeValues`. The SDK drops the field
 * from these silently, so DynamoDB never sees it and never rejects it.
 */
const WITHOUT_VALUES = new Set(["get", "getitem", "batchget", "batchgetitem"]);

/** `GetItem`, `getItem`, `GetItemCommand` and `GetCommand` all name the same operation. */
const normalize = (operation: string): string => operation.replace(/Command$/, "").toLowerCase();

const withoutValues = (request: Record<string, unknown>): DynamoRequest =>
  Object.fromEntries(
    Object.entries(request).filter(([key]) => key !== "ExpressionAttributeValues"),
  );

/**
 * Finds the DynamoDB requests in a value by their shape, not by command class:
 * the value itself, each item of `TransactItems`, and each table of
 * `BatchGetItem`'s `RequestItems`. Works on an SDK command's input, a Document
 * client's, and a Step Functions task's parameters alike.
 *
 * @param operation - The operation the value was sent to, such as `GetItem` or
 *   `UpdateCommand`, when known. A request to an operation that takes no
 *   `ExpressionAttributeValues` is returned without them, as the SDK sends it.
 */
export function findRequests(value: unknown, operation?: string): RequestSite[] {
  if (!isRecord(value)) return [];
  const top = operation !== undefined && WITHOUT_VALUES.has(normalize(operation));
  const sites: RequestSite[] = [{ path: "", request: top ? withoutValues(value) : value }];
  const { TransactItems: items, RequestItems: tables } = value;
  if (Array.isArray(items)) {
    items.forEach((item: unknown, i) => {
      if (!isRecord(item)) return;
      for (const op of TRANSACT_OPERATIONS) {
        const request = item[op];
        if (!isRecord(request)) continue;
        sites.push({
          path: `TransactItems[${String(i)}].${op}`,
          request: op === "Get" ? withoutValues(request) : request,
        });
      }
    });
  }
  // BatchWriteItem's RequestItems hold arrays of writes, which carry no expressions.
  if (isRecord(tables)) {
    for (const [table, request] of Object.entries(tables)) {
      if (isRecord(request)) {
        sites.push({
          path: `RequestItems[${JSON.stringify(table)}]`,
          request: withoutValues(request),
        });
      }
    }
  }
  return sites;
}
