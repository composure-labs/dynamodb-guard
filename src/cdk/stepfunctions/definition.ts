import { isRecord, UNKNOWN } from "../../core/check.js";

/**
 * Stands in for each CloudFormation intrinsic in a `DefinitionString`, so the
 * rest of the definition can be parsed as JSON. Alphanumeric and quote-free,
 * so it can sit inside a JSON string without escaping.
 */
const TOKEN = "DYNAMODBGUARDTOKEN";

/** Why a state machine's definition can't be read at synth. */
export type Unreadable = "s3" | "intrinsic" | "json";

/**
 * The text of a resolved `DefinitionString`, with every intrinsic replaced by
 * {@link TOKEN}, or `undefined` if it is neither a string nor an `Fn::Join`.
 *
 * CDK renders a definition that contains a token, such as a table name, as an
 * `Fn::Join` of JSON text and intrinsics. An intrinsic inside a JSON string
 * becomes the bare token; one outside a string (a token in a numeric field)
 * becomes the quoted token, so the text still parses.
 */
function definitionText(resolved: unknown): string | undefined {
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

/** A resolved `DefinitionString` as JSON, or why it can't be read. */
export function parseDefinition(resolved: unknown): { definition: unknown } | Unreadable {
  const text = definitionText(resolved);
  if (text === undefined) return "intrinsic";
  try {
    return { definition: JSON.parse(text) as unknown };
  } catch {
    return "json";
  }
}

/** A Task state that calls DynamoDB, and the payload it sends. */
export interface DynamoTask {
  readonly state: string;
  /** The action, as the task's `Resource` names it: `updateItem`, `transactWriteItems`. */
  readonly action: string;
  /** `Parameters` (JSONPath) or `Arguments` (JSONata). */
  readonly field: "Parameters" | "Arguments";
  /**
   * The payload in the shape the SDK is sent: `.$` stripped from each key,
   * and every value whose text isn't known at synth replaced by `UNKNOWN`.
   */
  readonly payload: unknown;
}

/**
 * `value` with every value not known at synth replaced by `UNKNOWN`: a JSONPath
 * `.$` field, a JSONata `{% %}` value, a CDK token, or a
 * `DefinitionSubstitutions` placeholder.
 */
function settle(value: unknown, placeholders: readonly string[]): unknown {
  if (typeof value === "string") {
    const dynamic =
      value.includes(TOKEN) ||
      /^\s*\{%[\s\S]*%\}\s*$/.test(value) ||
      placeholders.some((placeholder) => value.includes(placeholder));
    return dynamic ? UNKNOWN : value;
  }
  if (Array.isArray(value)) return value.map((item) => settle(item, placeholders));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      key.endsWith(".$") ? [key.slice(0, -2), UNKNOWN] : [key, settle(item, placeholders)],
    ),
  );
}

/**
 * The optimised integration (`arn:aws:states:::dynamodb:updateItem`) and the
 * SDK integration (`arn:aws:states:::aws-sdk:dynamodb:updateItem`), in any
 * partition, including one CDK leaves as `${AWS::Partition}`.
 */
const DYNAMODB_RESOURCE = /^arn:[^:]+:states:::(?:aws-sdk:)?dynamodb:([A-Za-z]+)$/;

/**
 * Every DynamoDB task in a definition, at any depth: inside `Parallel`
 * branches, and inline and distributed `Map` states (`Iterator` and
 * `ItemProcessor`).
 *
 * @param substitutions - The names in the state machine's `DefinitionSubstitutions`.
 */
export function dynamoTasks(definition: unknown, substitutions: readonly string[]): DynamoTask[] {
  const placeholders = substitutions.map((name) => `\${${name}}`);
  const tasks: DynamoTask[] = [];
  const visit = (machine: unknown): void => {
    if (!isRecord(machine) || !isRecord(machine.States)) return;
    for (const [state, body] of Object.entries(machine.States)) {
      if (!isRecord(body)) continue;
      const action =
        body.Type === "Task" && typeof body.Resource === "string"
          ? DYNAMODB_RESOURCE.exec(body.Resource)?.[1]
          : undefined;
      for (const field of ["Parameters", "Arguments"] as const) {
        if (action === undefined || !(field in body)) continue;
        tasks.push({ state, action, field, payload: settle(body[field], placeholders) });
      }
      if (Array.isArray(body.Branches)) body.Branches.forEach(visit);
      visit(body.Iterator);
      visit(body.ItemProcessor);
    }
  };
  visit(definition);
  return tasks;
}
