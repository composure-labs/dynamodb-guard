import type { Rule } from "eslint";
import { aliasFor } from "../core/parse.js";
import { readRequest } from "./request.js";

/**
 * Warns about `a-b` on the right of `SET`, written with no space around the
 * `-`. DynamoDB accepts it as `a - b`, a subtraction, so nothing rejects it;
 * but when the author meant one attribute named `a-b`, the update silently
 * writes the wrong value. Spaces say a subtraction is meant; an alias says a
 * name is.
 *
 * See {@link https://github.com/composure-labs/dynamodb-guard#lint-eslint | the README}.
 */
export const ambiguousSubtraction: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Warn about an unspaced `-` between two names on the right of SET",
      url: "https://github.com/composure-labs/dynamodb-guard#lint-eslint",
    },
    schema: [],
    messages: {
      ambiguous:
        '"{{text}}" is read as {{left}} - {{right}}, a subtraction. Write "{{left}} - {{right}}" ' +
        'if that is meant, or alias the name: ExpressionAttributeNames { "{{alias}}": "{{text}}" }.',
    },
  },

  create(context) {
    return {
      ObjectExpression(node) {
        const literal = readRequest(node, context.sourceCode);
        if (literal === undefined) return;
        for (const { field, text, offset } of literal.ambiguousSubtractions) {
          const [left, right] = text.split("-");
          context.report({
            ...literal.at(field, offset, text.length),
            messageId: "ambiguous",
            data: { text, left, right, alias: aliasFor(text) },
          });
        }
      },
    };
  },
};
