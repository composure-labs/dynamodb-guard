/** The request fields that hold an expression, and the grammar each one takes. */
export const EXPRESSION_FIELDS = {
  UpdateExpression: "update",
  ConditionExpression: "condition",
  KeyConditionExpression: "keyCondition",
  FilterExpression: "filter",
  ProjectionExpression: "projection",
} as const;

/** The request fields that hold placeholders' definitions, and each one's sigil. */
export const MAP_FIELDS = {
  ExpressionAttributeNames: "#",
  ExpressionAttributeValues: ":",
} as const;

/** A request field that holds placeholders' definitions. */
export type MapField = keyof typeof MAP_FIELDS;

/** A request field that holds an expression. */
export type ExpressionField = keyof typeof EXPRESSION_FIELDS;

/** The grammar an expression is written in. */
export type ExpressionKind = (typeof EXPRESSION_FIELDS)[ExpressionField];

/** Where a violation was found: an expression, or one of the attribute maps. */
export type ViolationField = ExpressionField | MapField;

/**
 * What is wrong. Each kind is one way DynamoDB rejects a request with a
 * `ValidationException`, established against the service itself (see
 * test/corpus/).
 */
export type ViolationKind =
  /** An unaliased attribute name that DynamoDB reserves. */
  | "reserved-word"
  /** An unaliased name DynamoDB can't parse: not an ASCII letter followed by letters, digits or `_`. */
  | "must-alias"
  /** A `#name` or `:value` placeholder with no entry in its map. */
  | "undefined-alias"
  /** A map entry that no expression in the request uses. */
  | "unused-alias"
  /** `ExpressionAttributeValues` on a request with no expression. */
  | "values-without-expression"
  /** `ExpressionAttributeNames` on a request with no expression. */
  | "names-without-expression"
  /** Valid syntax in the wrong kind of expression, such as `OR` in a key condition. */
  | "kind-grammar"
  /** Two update actions on the same or overlapping document paths. */
  | "overlapping-paths"
  /** Over one of DynamoDB's expression limits. */
  | "limit"
  /** Not an expression DynamoDB can parse. */
  | "syntax";

/** One reason DynamoDB would reject the request. */
export interface Violation {
  readonly kind: ViolationKind;
  readonly field: ViolationField;
  /** One line: what is wrong and how to fix it. */
  readonly message: string;
  /** The offending text, when there is one. */
  readonly token?: string;
  /** Where `token` starts in the field's expression, in UTF-16 code units. */
  readonly offset?: number;
}

const FIELD_OF_KIND = Object.fromEntries(
  Object.entries(EXPRESSION_FIELDS).map(([field, kind]) => [kind, field]),
) as Record<ExpressionKind, ExpressionField>;

/** The request field that holds an expression of `kind`. */
export const fieldOf = (kind: ExpressionKind): ExpressionField => FIELD_OF_KIND[kind];

const DOCS = "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide";

/** The AWS page that explains each kind of violation. */
export const DOC_LINKS: Readonly<Record<ViolationKind, string>> = {
  "reserved-word": `${DOCS}/ReservedWords.html`,
  "must-alias": `${DOCS}/Expressions.ExpressionAttributeNames.html`,
  "undefined-alias": `${DOCS}/Expressions.ExpressionAttributeNames.html`,
  "unused-alias": `${DOCS}/Expressions.ExpressionAttributeNames.html`,
  "values-without-expression": `${DOCS}/Expressions.ExpressionAttributeValues.html`,
  "names-without-expression": `${DOCS}/Expressions.ExpressionAttributeNames.html`,
  "kind-grammar": `${DOCS}/Expressions.OperatorsAndFunctions.html`,
  "overlapping-paths": `${DOCS}/Expressions.UpdateExpressions.html`,
  limit: `${DOCS}/Constraints.html#limits-expression-parameters`,
  syntax: `${DOCS}/Expressions.html`,
};
