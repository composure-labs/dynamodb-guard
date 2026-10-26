import type { Rule } from "eslint";
import type { Node, ObjectExpression, Property } from "estree";
import { UNKNOWN } from "../core/check.js";
import { aliasFor } from "../core/parse.js";
import { checkRequestsIn, TRANSACT_OPERATIONS } from "../core/requests.js";
import {
  DOC_LINKS,
  EXPRESSION_FIELDS,
  type ExpressionField,
  MAP_FIELDS,
  type MapField,
  type ViolationField,
  type ViolationKind,
} from "../core/violations.js";

const EXPRESSION_KEYS = Object.keys(EXPRESSION_FIELDS) as ExpressionField[];
const MAP_KEYS = Object.keys(MAP_FIELDS) as MapField[];

/** The fields as the SDK spells them, and as CDK's Step Functions tasks do. */
const FIELDS = new Map<string, ViolationField>(
  [...EXPRESSION_KEYS, ...MAP_KEYS].flatMap((field) => [
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

/** A string assembled from parts: a template literal with interpolations, or `+`. */
const isAssembled = (node: Node): boolean =>
  (node.type === "TemplateLiteral" && node.expressions.length > 0) ||
  (node.type === "BinaryExpression" && node.operator === "+");

/**
 * The operation this object is sent to, when its place says: the call or
 * `new` it is an argument to, or the transaction item key it sits under.
 */
function operationOf(node: ObjectExpression & Rule.NodeParentExtension): {
  name?: string;
  dynamo: boolean;
} {
  const parent = node.parent;
  if (parent.type === "Property") {
    const key = parent.value === node ? keyOf(parent) : undefined;
    return key !== undefined && TRANSACT.has(key) ? { name: key, dynamo: true } : { dynamo: false };
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

/** A literal map as the checker reads it: its keys, and each name's literal value. */
function mapOf(node: Node, field: MapField): Record<string, unknown> | typeof UNKNOWN {
  if (node.type !== "ObjectExpression") return UNKNOWN;
  const entries: Record<string, unknown> = {};
  for (const property of node.properties) {
    if (property.type !== "Property") return UNKNOWN;
    const key = keyOf(property);
    if (key === undefined) return UNKNOWN;
    entries[key] =
      field === "ExpressionAttributeNames" ? (staticString(property.value) ?? UNKNOWN) : null;
  }
  return entries;
}

interface Options {
  reportDynamic?: boolean;
  aliasAll?: boolean;
}

/**
 * Reports a DynamoDB request, written as an object literal, that DynamoDB
 * would reject. Runs the same checker as the other guards over the literal
 * expressions and attribute maps, so an SDK command's input, a Document
 * client's, a transaction item and a CDK `Dynamo*` task's props are all
 * checked where they are written.
 *
 * See {@link https://github.com/composure-labs/dynamodb-guard#lint-eslint | the README}.
 */
export const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description: "Report DynamoDB expressions that DynamoDB would reject",
      url: "https://github.com/composure-labs/dynamodb-guard#lint-eslint",
    },
    schema: [
      {
        type: "object",
        properties: {
          reportDynamic: {
            type: "boolean",
            description:
              "Report an expression assembled with interpolation or `+`, whose names the rule can't check.",
          },
          aliasAll: {
            type: "boolean",
            description:
              "Report every attribute name not written as a `#placeholder`, reserved or not.",
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      ...Object.fromEntries(
        (Object.keys(DOC_LINKS) as ViolationKind[]).map((kind) => [kind, "{{message}}"]),
      ),
      dynamic:
        "{{field}} is assembled from parts, so its names can't be checked. Write it as one " +
        "string, with each name that varies as a #placeholder in ExpressionAttributeNames.",
      unaliased:
        '"{{name}}" is not aliased. Write it as a #placeholder: ExpressionAttributeNames ' +
        '{ "{{alias}}": "{{name}}" }.',
    },
  },

  create(context) {
    // Defaults here, not in meta.defaultOptions, which postdates the ESLint floor.
    const [{ reportDynamic = true, aliasAll = false } = {}] = context.options as [Options?];
    const { sourceCode } = context;

    /** Where `token` sits in a literal, or the whole literal when escapes make that unknowable. */
    const locate = (node: Node, offset: number | undefined, length: number) => {
      const value = staticString(node);
      const [start] = node.range ?? [0];
      // Only an escape-free literal's text is its value plus the two quotes.
      if (
        offset === undefined ||
        value === undefined ||
        sourceCode.getText(node).length !== value.length + 2
      ) {
        return { node };
      }
      const from = start + 1 + offset;
      return {
        loc: {
          start: sourceCode.getLocFromIndex(from),
          end: sourceCode.getLocFromIndex(from + Math.max(1, length)),
        },
      };
    };

    return {
      ObjectExpression(node) {
        // Every object literal in the codebase comes through here: find a
        // request field before allocating anything.
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
        if (fields === undefined) return;
        const operation = operationOf(node);
        if (!operation.dynamo && !(expression ? named : table)) return;

        const request: Partial<Record<ViolationField, unknown>> = {};
        for (const field of EXPRESSION_KEYS) {
          const value = fields.get(field)?.value;
          if (value === undefined) {
            // A spread may hold any field.
            if (spread) request[field] = UNKNOWN;
            continue;
          }
          const text = staticString(value);
          request[field] = text ?? UNKNOWN;
          if (text === undefined && reportDynamic && isAssembled(value)) {
            context.report({ node: value, messageId: "dynamic", data: { field } });
          }
        }
        for (const field of MAP_KEYS) {
          const value = fields.get(field)?.value;
          if (value !== undefined) request[field] = mapOf(value, field);
          else if (spread) request[field] = UNKNOWN;
        }

        // The request holds no TransactItems or RequestItems, so it is the one site.
        for (const { violations, bareNames } of checkRequestsIn(request, operation.name)) {
          for (const violation of violations) {
            const property = fields.get(violation.field);
            context.report({
              ...(property === undefined
                ? { node }
                : locate(property.value, violation.offset, violation.token?.length ?? 0)),
              messageId: violation.kind,
              data: { message: violation.message },
            });
          }
          if (!aliasAll) continue;
          for (const { field, text, offset } of bareNames) {
            const property = fields.get(field);
            if (property === undefined) continue;
            context.report({
              ...locate(property.value, offset, text.length),
              messageId: "unaliased",
              data: { name: text, alias: aliasFor(text) },
            });
          }
        }
      },
    };
  },
};
