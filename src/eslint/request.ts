import type { AST, Rule, SourceCode } from "eslint";
import type { Identifier, Node, ObjectExpression, Property, VariableDeclaration } from "estree";
import { type FieldToken, IN_LIST_STAND_IN, type PartialCheck, UNKNOWN } from "../core/check.js";
import { dynamodbAction, transactionItemOperation } from "../core/operations.js";
import { checkRequestsIn, TRANSACT_OPERATIONS } from "../core/requests.js";
import { RETURN_VALUES } from "../core/return-values.js";
import {
  EXPRESSION_FIELDS,
  type ExpressionField,
  MAP_FIELDS,
  type MapField,
  RETURN_VALUE_FIELDS,
  type Violation,
  type ViolationField,
} from "../core/violations.js";

const EXPRESSION_KEYS = Object.keys(EXPRESSION_FIELDS) as ExpressionField[];
const MAP_KEYS = Object.keys(MAP_FIELDS) as MapField[];

/** The fields as the SDK spells them, and as CDK's Step Functions tasks do. */
const FIELDS = new Map<string, ViolationField>(
  [...EXPRESSION_KEYS, ...MAP_KEYS, ...RETURN_VALUE_FIELDS].flatMap((field) => [
    [field, field],
    [field.charAt(0).toLowerCase() + field.slice(1), field],
  ]),
);

const TABLE = new Set(["TableName", "tableName", "table"]);

/**
 * Keys that, beside an expression, say an object is a DynamoDB request.
 * `ConditionExpression`, `FilterExpression` and `ProjectionExpression` exist in
 * other AWS APIs, so they don't count on their own.
 */
const NAMES_DYNAMODB = new Set([
  ...TABLE,
  ...[...FIELDS.keys()].filter((key) => /^(update|keyCondition|expressionAttribute)/i.test(key)),
]);

const TRANSACT = new Set<string>(TRANSACT_OPERATIONS);

/** A callee that takes a DynamoDB request: an SDK command, or a CDK `Dynamo*` task. */
const DYNAMO_CALLEE = /Command$|^Dynamo/;

const keyOf = (property: Property): string | undefined => {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  return property.key.type === "Literal" && typeof property.key.value === "string"
    ? property.key.value
    : undefined;
};

/** A string literal, or a template literal with nothing interpolated. */
function staticString(node: Node): string | undefined {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : undefined;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

const ENUM_MEMBERS = new Set<string>(RETURN_VALUES);

/**
 * A return-values field's value: a string literal, or an enum member such as
 * the SDK's `ReturnValue.ALL_NEW` or CDK's `DynamoReturnValues.ALL_NEW`, whose
 * name is its value. Any other member, such as `options.mode`, isn't known.
 */
function returnValueOf(node: Node): string | undefined {
  if (node.type !== "MemberExpression") return staticString(node);
  const { computed, property } = node;
  return !computed && property.type === "Identifier" && ENUM_MEMBERS.has(property.name)
    ? property.name
    : undefined;
}

/** A string assembled from parts: a template literal with interpolations, or `+`. */
const isAssembled = (node: Node): boolean =>
  (node.type === "TemplateLiteral" && node.expressions.length > 0) ||
  (node.type === "BinaryExpression" && node.operator === "+");

/** Text ending inside an `IN (` operand list, where the next operand starts. */
const IN_LIST_OPEN = /\bIN\s*\(([^()]*,)?\s*$/i;
/** Text going on with the next operand, or closing the list. */
const IN_LIST_NEXT = /^\s*[,)]/;

/**
 * A template literal's text with a stand-in placeholder for each
 * interpolation, when every one sits in an `IN ( … )` operand list, as in
 * `` `a IN (${list})` ``. Nothing for any other template literal.
 */
function withListsStoodIn(node: Node): string | undefined {
  if (node.type !== "TemplateLiteral" || node.expressions.length === 0) return undefined;
  const [first, ...rest] = node.quasis.map((quasi) => quasi.value.cooked);
  if (first == null || rest.some((part) => part == null)) return undefined;
  let text = first;
  for (const after of rest as string[]) {
    if (!IN_LIST_OPEN.test(text) || !IN_LIST_NEXT.test(after)) return undefined;
    text += IN_LIST_STAND_IN + after;
  }
  return text;
}

/** The operation an `AwsCustomResource` call written as a literal sends to DynamoDB, if any. */
function customResourceAction(call: Node): string | undefined {
  if (call.type !== "ObjectExpression") return undefined;
  let service: string | undefined;
  let action: string | undefined;
  for (const property of call.properties) {
    if (property.type !== "Property") continue;
    const key = keyOf(property);
    if (key === "service") service = staticString(property.value);
    else if (key === "action") action = staticString(property.value);
  }
  return dynamodbAction(service, action);
}

/**
 * The operation this object is sent to, when its place says: the call or
 * `new` it is an argument to, the transaction item key it sits under, the
 * `RequestItems` it is a table of, or the `action` beside it in an
 * `AwsCustomResource` call. These are the places `findRequests` reads,
 * and the names it gives them.
 */
function operationOf(node: ObjectExpression & Rule.NodeParentExtension): {
  name?: string;
  dynamo: boolean;
} {
  const parent = node.parent;
  if (parent.type === "Property") {
    if (parent.value !== node) return { dynamo: false };
    const key = keyOf(parent);
    if (key !== undefined && TRANSACT.has(key)) {
      return { name: transactionItemOperation(key), dynamo: true };
    }
    // The object this one is a property of: a call's, or a table map's.
    const holder = parent.parent;
    if (key === "parameters") {
      const action = customResourceAction(holder);
      if (action !== undefined) return { name: action, dynamo: true };
    }
    // A table's own key is often computed, so only the key above it is read.
    const above = holder.type === "ObjectExpression" ? holder.parent : undefined;
    return above?.type === "Property" && above.value === holder && keyOf(above) === "RequestItems"
      ? { name: "BatchGetItem", dynamo: true }
      : { dynamo: false };
  }
  if (parent.type !== "CallExpression" && parent.type !== "NewExpression") return { dynamo: false };
  const callee = parent.callee;
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && callee.property.type === "Identifier"
        ? callee.property.name
        : undefined;
  return { name, dynamo: name !== undefined && DYNAMO_CALLEE.test(name) };
}

/** Whether `identifier` is only copied where it's used: into a request's map, or spread into an object. */
function isCopied(identifier: Node): boolean {
  const parent = (identifier as Node & Rule.NodeParentExtension).parent;
  if (parent.type === "SpreadElement") return parent.parent.type === "ObjectExpression";
  if (parent.type !== "Property" || parent.value !== identifier) return false;
  const key = keyOf(parent);
  const field = key === undefined ? undefined : FIELDS.get(key);
  return field !== undefined && field in MAP_FIELDS;
}

/**
 * The object literal a `const` holds, when nothing else can change it: it
 * isn't exported, and every use copies it into a request's map or spreads it
 * into another object.
 */
function constObject(identifier: Identifier, sourceCode: SourceCode): ObjectExpression | undefined {
  const variable = sourceCode
    .getScope(identifier)
    .references.find((ref) => ref.identifier === identifier)?.resolved;
  if (!variable) return undefined;
  const def = variable.defs.length === 1 ? variable.defs[0] : undefined;
  if (def?.type !== "Variable") return undefined;
  const declaration = def.parent as VariableDeclaration & Rule.NodeParentExtension;
  if (declaration.kind !== "const") return undefined;
  if (declaration.parent.type === "ExportNamedDeclaration") return undefined;
  const init = def.node.init;
  if (init?.type !== "ObjectExpression") return undefined;
  return variable.references.every((ref) => ref.init === true || isCopied(ref.identifier as Node))
    ? init
    : undefined;
}

/** How many `const`s and spreads deep a map is read. */
const MAX_DEPTH = 4;

/**
 * A map's entries, as far as they can be read: an object literal, a `const`
 * holding one, and spreads of either. `open` when it may hold others too: a
 * spread or computed key that can't be read may add any entry, or replace a
 * name's value.
 */
function entriesOf(
  node: Node,
  field: MapField,
  sourceCode: SourceCode,
  depth = 0,
): { entries: Record<string, unknown>; open: boolean } | undefined {
  const object =
    node.type === "Identifier" && depth < MAX_DEPTH ? constObject(node, sourceCode) : node;
  if (object?.type !== "ObjectExpression") return undefined;
  const names = field === "ExpressionAttributeNames";
  const entries: Record<string, unknown> = {};
  let open = false;
  const openUp = () => {
    open = true;
    if (names) for (const key of Object.keys(entries)) entries[key] = UNKNOWN;
  };
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      const spread = entriesOf(property.argument, field, sourceCode, depth + 1);
      if (spread === undefined || spread.open) openUp();
      Object.assign(entries, spread?.entries);
      continue;
    }
    const key = keyOf(property);
    if (key === undefined) openUp();
    else entries[key] = names ? (staticString(property.value) ?? UNKNOWN) : null;
  }
  return { entries, open };
}

/** A map as the checker reads it: its keys, each name's literal value, and {@link UNKNOWN} when it may hold more. */
function mapOf(node: Node, field: MapField, sourceCode: SourceCode): object | typeof UNKNOWN {
  const map = entriesOf(node, field, sourceCode);
  if (map === undefined) return UNKNOWN;
  if (!map.open) return map.entries;
  // With no entry known, an open map says nothing the checker can use.
  if (Object.keys(map.entries).length === 0) return UNKNOWN;
  return Object.assign(map.entries, { [UNKNOWN]: true });
}

type ReportLocation = { node: Node } | { loc: AST.SourceLocation };

/** A finding, with where to report it. */
type Located<T> = T & { readonly location: ReportLocation };

/** A DynamoDB request written as an object literal, checked. */
export interface LiteralRequest {
  readonly violations: readonly Located<Violation>[];
  /** Each name an expression writes without an alias that DynamoDB accepts so. */
  readonly bareNames: readonly Located<FieldToken>[];
  /** Each `a-b` that DynamoDB reads as a subtraction but looks like one name. */
  readonly ambiguousSubtractions: readonly Located<FieldToken>[];
  /** Each expression assembled with interpolation or `+`, whose text can't be known. */
  readonly assembled: readonly { readonly field: ExpressionField; readonly node: Node }[];
}

/** One literal a ternary can choose: its text, or `undefined` for no field. */
interface Branch {
  readonly node: Node;
  readonly text: string | undefined;
}

/**
 * The literals a ternary chooses between, through nested ternaries. An
 * `undefined` branch sends no field, as the SDK drops it. Nothing when a
 * branch is anything else.
 */
function branchesOf(node: Node): Branch[] | undefined {
  if (node.type === "ConditionalExpression") {
    const consequent = branchesOf(node.consequent);
    const alternate = branchesOf(node.alternate);
    return consequent && alternate && [...consequent, ...alternate];
  }
  if (node.type === "Identifier" && node.name === "undefined") return [{ node, text: undefined }];
  const text = staticString(node);
  return text === undefined ? undefined : [{ node, text }];
}

/** Each object literal read so far, so the plugin's rules check a request once between them. */
const read = new WeakMap<ObjectExpression, LiteralRequest | undefined>();

/**
 * Reads `node` as a DynamoDB request, when it is one, and checks it. Every
 * rule in this plugin starts here, so they agree on what a request is.
 */
export function readRequest(
  node: ObjectExpression & Rule.NodeParentExtension,
  sourceCode: SourceCode,
): LiteralRequest | undefined {
  if (read.has(node)) return read.get(node);
  const literal = readUncached(node, sourceCode);
  read.set(node, literal);
  return literal;
}

function readUncached(
  node: ObjectExpression & Rule.NodeParentExtension,
  sourceCode: SourceCode,
): LiteralRequest | undefined {
  // Every object literal in the codebase comes through here: find a request
  // field before allocating anything.
  let fields: Map<ViolationField, Property> | undefined;
  let spread = false;
  let expression = false;
  let named = false;
  let table = false;
  for (const property of node.properties) {
    if (property.type !== "Property") {
      spread = true;
      continue;
    }
    const key = keyOf(property);
    if (key === undefined) continue;
    named ||= NAMES_DYNAMODB.has(key);
    table ||= TABLE.has(key);
    const field = FIELDS.get(key);
    if (field === undefined) continue;
    (fields ??= new Map()).set(field, property);
    expression ||= field in EXPRESSION_FIELDS;
  }
  if (fields === undefined) return undefined;
  const operation = operationOf(node);
  if (!operation.dynamo && !(expression ? named : table)) return undefined;

  const request: Partial<Record<ViolationField, unknown>> = {};
  const assembled: { field: ExpressionField; node: Node }[] = [];
  const ternaries: { field: ExpressionField; branches: Branch[] }[] = [];
  for (const field of EXPRESSION_KEYS) {
    const value = fields.get(field)?.value;
    if (value === undefined) {
      // A spread may hold any field.
      if (spread) request[field] = UNKNOWN;
      continue;
    }
    const text = staticString(value) ?? withListsStoodIn(value);
    request[field] = text ?? UNKNOWN;
    if (text === undefined && isAssembled(value)) assembled.push({ field, node: value });
    const branches = value.type === "ConditionalExpression" ? branchesOf(value) : undefined;
    if (branches !== undefined) ternaries.push({ field, branches });
  }
  for (const field of MAP_KEYS) {
    const value = fields.get(field)?.value;
    if (value !== undefined) request[field] = mapOf(value, field, sourceCode);
    else if (spread) request[field] = UNKNOWN;
  }
  for (const field of RETURN_VALUE_FIELDS) {
    const value = fields.get(field)?.value;
    if (value !== undefined) request[field] = returnValueOf(value) ?? UNKNOWN;
  }

  /** Where to report `length` characters at `offset` in `value`: that range, or the whole value. */
  const locate = (value: Node | undefined, offset: number | undefined, length: number) => {
    if (value === undefined) return { node };
    const text = staticString(value);
    // Only an escape-free literal's text is its value plus the two quotes.
    if (
      offset === undefined ||
      text === undefined ||
      sourceCode.getText(value).length !== text.length + 2
    ) {
      return { node: value };
    }
    const from = (value.range?.[0] ?? 0) + 1 + offset;
    return {
      loc: {
        start: sourceCode.getLocFromIndex(from),
        end: sourceCode.getLocFromIndex(from + Math.max(1, length)),
      },
    };
  };

  // Each branch of a ternary is checked as its own request. With one field
  // branching, each is a request the code can send. With more, their
  // conditions may be related, so the others stay unknown in each.
  const runs: { request: object; chosen?: { field: ViolationField; node: Node } }[] =
    ternaries.length === 0
      ? [{ request }]
      : ternaries.flatMap(({ field, branches }) =>
          branches.map((branch) => ({
            request: { ...request, [field]: branch.text },
            chosen: { field, node: branch.node },
          })),
        );
  // The request holds no TransactItems or RequestItems, so it is the one site.
  const checked = runs.map(({ request, chosen }) => ({
    check: checkRequestsIn(request, operation.name)[0],
    chosen,
  }));
  /** One kind of finding from every run, located. Runs share their other fields, so a finding there is kept once. */
  const located = <T extends { field: ViolationField; offset?: number }>(
    pick: (check: PartialCheck) => readonly T[],
    length: (item: T) => number,
  ): Located<T>[] => {
    const found = new Map<string, Located<T>>();
    for (const { check, chosen } of checked) {
      for (const item of pick(check)) {
        const value = chosen?.field === item.field ? chosen.node : fields.get(item.field)?.value;
        const key = JSON.stringify([item, value?.range]);
        if (!found.has(key)) {
          found.set(key, { ...item, location: locate(value, item.offset, length(item)) });
        }
      }
    }
    return [...found.values()];
  };
  return {
    violations: located(
      (check) => check.violations,
      (violation) => violation.token?.length ?? 0,
    ),
    bareNames: located(
      (check) => check.bareNames,
      (token) => token.text.length,
    ),
    ambiguousSubtractions: located(
      (check) => check.ambiguousSubtractions,
      (token) => token.text.length,
    ),
    assembled,
  };
}
