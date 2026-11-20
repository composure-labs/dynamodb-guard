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

/** The forms of `service` an `AwsCustomResource` call can name DynamoDB by. */
const DYNAMODB_SERVICES: ReadonlySet<unknown> = new Set([
  "DynamoDB",
  "dynamodb",
  "@aws-sdk/client-dynamodb",
]);

/**
 * The operation an `AwsCustomResource` call sends to DynamoDB: its `action`,
 * when its `service` names DynamoDB and both are strings. `undefined` for a
 * call to another service, or one whose action isn't known.
 */
export const dynamodbAction = (service: unknown, action: unknown): string | undefined =>
  DYNAMODB_SERVICES.has(service) && typeof action === "string" ? action : undefined;

/** The operation a transaction item is sent as, named by the key it sits under: `TransactItems.Put`. */
export const transactionItemOperation = (key: string): string => `TransactItems.${key}`;
