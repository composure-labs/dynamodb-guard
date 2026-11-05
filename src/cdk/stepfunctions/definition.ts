import { isRecord } from "../../core/check.js";
import { settle, type SettleRules } from "../rendered-json.js";

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
 * What a definition leaves unknown at synth: a JSONPath `.$` field, a JSONata
 * `{% %}` value, or a `DefinitionSubstitutions` placeholder.
 */
const settleRules = (placeholders: readonly string[]): SettleRules => ({
  text: (text) =>
    /^\s*\{%[\s\S]*%\}\s*$/.test(text) ||
    placeholders.some((placeholder) => text.includes(placeholder)),
  key: (key) => (key.endsWith(".$") ? key.slice(0, -2) : undefined),
});

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
  const rules = settleRules(substitutions.map((name) => `\${${name}}`));
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
        tasks.push({ state, action, field, payload: settle(body[field], rules) });
      }
      if (Array.isArray(body.Branches)) body.Branches.forEach(visit);
      visit(body.Iterator);
      visit(body.ItemProcessor);
    }
  };
  visit(definition);
  return tasks;
}
