import { isRecord, UNKNOWN } from "../core/check.js";

/**
 * Stands in for each CloudFormation intrinsic in rendered JSON text, so the
 * rest of it can be parsed. Alphanumeric and quote-free, so it can sit inside a
 * JSON string without escaping.
 */
const TOKEN = "DYNAMODBGUARDTOKEN";

/** Whether parsed text holds an intrinsic, so isn't known at synth. */
export const hasToken = (text: string): boolean => text.includes(TOKEN);

/** Why resolved JSON text can't be parsed. */
export type Unparsed = "intrinsic" | "json";

/** What else a kind of resource leaves unknown at synth, beyond a CDK token. */
export interface SettleRules {
  /** Whether a string's value isn't known at synth. */
  readonly text?: (text: string) => boolean;
  /** The field's real name, if this key marks its value as not known at synth. */
  readonly key?: (key: string) => string | undefined;
}

/** `value` with every value not known at synth replaced by `UNKNOWN`. */
export function settle(value: unknown, rules: SettleRules = {}): unknown {
  if (typeof value === "string") {
    return hasToken(value) || rules.text?.(value) === true ? UNKNOWN : value;
  }
  if (Array.isArray(value)) return value.map((item) => settle(item, rules));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const name = rules.key?.(key);
      return name === undefined ? [key, settle(item, rules)] : [name, UNKNOWN];
    }),
  );
}

/**
 * The text of a resolved value, with every intrinsic replaced by {@link TOKEN},
 * or `undefined` if it is neither a string nor an `Fn::Join`.
 *
 * CDK renders JSON that contains a token, such as a table name, as an `Fn::Join`
 * of JSON text and intrinsics. An intrinsic inside a JSON string becomes the
 * bare token; one outside a string (a token in a numeric field) becomes the
 * quoted token, so the text still parses.
 */
function renderedText(resolved: unknown): string | undefined {
  if (typeof resolved === "string") return resolved;
  const join: unknown = isRecord(resolved) ? resolved["Fn::Join"] : undefined;
  if (!Array.isArray(join)) return undefined;
  const [separator, parts] = join as unknown[];
  if (typeof separator !== "string" || !Array.isArray(parts)) return undefined;
  let text = "";
  let inString = false;
  parts.forEach((part, i) => {
    if (i > 0) text += separator;
    if (typeof part !== "string") {
      text += inString ? TOKEN : `"${TOKEN}"`;
      return;
    }
    for (let c = 0; c < part.length; c++) {
      if (part[c] === "\\") c++;
      else if (part[c] === '"') inString = !inString;
    }
    text += part;
  });
  return text;
}

/** A resolved value that CDK rendered as JSON text, parsed, or why it can't be. */
export function parseRendered(resolved: unknown): { parsed: unknown } | Unparsed {
  const text = renderedText(resolved);
  if (text === undefined) return "intrinsic";
  try {
    return { parsed: JSON.parse(text) as unknown };
  } catch {
    return "json";
  }
}
