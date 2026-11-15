import type { Rule } from "eslint";
import { aliasFor } from "../core/parse.js";
import { DOC_LINKS, type ViolationKind } from "../core/violations.js";
import { readRequest } from "./request.js";

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
    return {
      ObjectExpression(node) {
        const literal = readRequest(node, context.sourceCode);
        if (literal === undefined) return;
        if (reportDynamic) {
          for (const { field, node: value } of literal.assembled) {
            context.report({ node: value, messageId: "dynamic", data: { field } });
          }
        }
        for (const { kind, field, message, offset, token } of literal.violations) {
          context.report({
            ...literal.at(field, offset, token?.length ?? 0),
            messageId: kind,
            data: { message },
          });
        }
        if (!aliasAll) return;
        for (const { field, text, offset } of literal.bareNames) {
          context.report({
            ...literal.at(field, offset, text.length),
            messageId: "unaliased",
            data: { name: text, alias: aliasFor(text) },
          });
        }
      },
    };
  },
};
