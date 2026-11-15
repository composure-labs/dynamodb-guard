/**
 * The one name for an operation, however a guard spells it: `PutItem`,
 * `putItem` (Step Functions), `PutItemCommand`, `PutCommand` (Document
 * client), `DynamoPutItem` (a CDK task) and `put` (v2 Document client) are all
 * `put`. Every rule that depends on the operation looks it up by this name.
 */
export const canonicalOperation = (operation: string): string =>
  operation
    .replace(/^Dynamo/, "")
    .replace(/Command$/, "")
    .replace(/Item$/, "")
    .toLowerCase();

/** The operation a transaction item is sent as, named by the key it sits under: `TransactItems.Put`. */
export const transactionItemOperation = (key: string): string => `TransactItems.${key}`;
