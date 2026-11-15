import { canonicalOperation, transactionItemOperation } from "./operations.js";
import { RETURN_VALUE_FIELDS, type ReturnValueField, type Violation } from "./violations.js";

/** Every value a return-values field can hold, on some operation. */
export const RETURN_VALUES = ["NONE", "ALL_OLD", "UPDATED_OLD", "ALL_NEW", "UPDATED_NEW"] as const;
const OLD = ["NONE", "ALL_OLD"] as const;

/**
 * What one request may ask a write to return: the operation, as messages name
 * it, and the values each field takes. A field not listed isn't checked.
 */
export interface ReturnValueRules {
  readonly operation: string;
  readonly fields: Partial<Record<ReturnValueField, readonly string[]>>;
}

/** For a request whose operation isn't known, or takes neither field. */
export const UNCHECKED: ReturnValueRules = { operation: "", fields: {} };

const write = (operation: string, returns: readonly string[]): ReturnValueRules => ({
  operation,
  fields: { ReturnValues: returns, ReturnValuesOnConditionCheckFailure: OLD },
});

/**
 * A `TransactWriteItems` item. Its `ReturnValues` isn't checked: the SDK
 * drops it, as no item takes one, so DynamoDB never sees it.
 */
const TRANSACTION_ITEM: ReturnValueRules = {
  operation: "A transaction item",
  fields: { ReturnValuesOnConditionCheckFailure: OLD },
};

const RULES = new Map<string, ReturnValueRules>([
  ...[write("UpdateItem", RETURN_VALUES), write("PutItem", OLD), write("DeleteItem", OLD)].map(
    (rules) => [canonicalOperation(rules.operation), rules] as const,
  ),
  ...["Update", "Put", "Delete", "ConditionCheck"].map(
    (key) => [canonicalOperation(transactionItemOperation(key)), TRANSACTION_ITEM] as const,
  ),
]);

/** What a request sent to `operation` may ask its write to return; see {@link canonicalOperation}. */
export function returnValueRules(operation: string | undefined): ReturnValueRules {
  if (operation === undefined) return UNCHECKED;
  return RULES.get(canonicalOperation(operation)) ?? UNCHECKED;
}

/** `a, b or c`, of a list of two or more. */
const either = (values: readonly string[]): string =>
  `${values.slice(0, -1).join(", ")} or ${values.at(-1) ?? ""}`;

/** Each return-values field in `request` that `rules` say DynamoDB rejects. A non-string isn't judged. */
export function returnValueViolations(
  request: Readonly<Record<string, unknown>>,
  { operation, fields }: ReturnValueRules,
): Violation[] {
  const violations: Violation[] = [];
  for (const field of RETURN_VALUE_FIELDS) {
    const allowed = fields[field];
    const value = request[field];
    if (allowed === undefined || typeof value !== "string" || allowed.includes(value)) continue;
    violations.push({
      kind: "return-values",
      field,
      message: `${operation} takes ${field} ${either(allowed)}, not "${value}".`,
      token: value,
    });
  }
  return violations;
}
