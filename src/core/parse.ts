import { isReservedWord } from "./reserved-words.js";
import { type Token, TokenizeError, tokenize } from "./tokenize.js";
import { type ExpressionKind, type Violation, type ViolationKind, fieldOf } from "./violations.js";

/** The most bytes (UTF-8) DynamoDB accepts in one expression. */
export const MAX_EXPRESSION_BYTES = 4096;
/** The most operators and functions DynamoDB accepts in one expression. */
export const MAX_OPERATORS = 300;
/** The most operands DynamoDB accepts for `IN`. */
export const MAX_IN_OPERANDS = 100;

/** A document path an update action writes, as written. */
export interface ActionPath {
  /** Attribute names, `#name` placeholders and `[n]` indexes, in order. */
  readonly segments: readonly string[];
  readonly offset: number;
}

/** Everything one expression contributes to a request's checks. */
export interface ParsedExpression {
  readonly violations: readonly Violation[];
  /** Each `#name` placeholder the expression uses, with where it first appears. */
  readonly names: ReadonlyMap<string, number>;
  /** Each `:value` placeholder the expression uses, with where it first appears. */
  readonly values: ReadonlyMap<string, number>;
  /** The paths an update expression's actions write. Empty for other kinds. */
  readonly actionPaths: readonly ActionPath[];
}

const encoder = new TextEncoder();

/** The size DynamoDB measures: UTF-8 bytes. */
export const byteLength = (text: string): number => encoder.encode(text).length;

/** "IN has 101 operands; DynamoDB allows at most 100." */
export const tooMany = (what: string, count: number, max: number): string =>
  `${what.replace("#", String(count))}; DynamoDB allows at most ${String(max)}.`;

/** An unaliased name DynamoDB parses: an ASCII letter, then letters, digits or `_`. */
const LEGAL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const CLAUSES = new Set(["SET", "REMOVE", "ADD", "DELETE"]);
const COMPARATORS = new Set(["=", "<>", "<", "<=", ">", ">="]);

/**
 * What each function returns, which decides where it may appear: a `boolean`
 * is a condition on its own, a `value` is an operand in a condition, and an
 * `update` function is an operand on the right of `SET` only.
 */
const FUNCTIONS: Readonly<Partial<Record<string, "boolean" | "value" | "update">>> = {
  attribute_exists: "boolean",
  attribute_not_exists: "boolean",
  attribute_type: "boolean",
  begins_with: "boolean",
  contains: "boolean",
  size: "value",
  if_not_exists: "update",
  list_append: "update",
};

/** Where a function call appears. */
type CallSite = "condition" | "operand" | "update" | "target" | "projection";

const KEY_CONDITION_GRAMMAR =
  "a key condition takes = < <= > >= BETWEEN, begins_with() and AND only";

/** Thrown to stop at the first syntax error, as DynamoDB does. */
class SyntaxStop extends Error {}

class Parser {
  readonly violations: Violation[] = [];
  readonly names = new Map<string, number>();
  readonly values = new Map<string, number>();
  readonly actionPaths: ActionPath[] = [];
  operators = 0;
  #tokens: readonly Token[] = [];
  #pos = 0;

  constructor(readonly kind: ExpressionKind) {}

  // Navigation.

  peek(ahead = 0): Token {
    return this.#tokens[Math.min(this.#pos + ahead, this.#tokens.length - 1)];
  }

  next(): Token {
    const token = this.peek();
    if (token.type !== "end") this.#pos++;
    return token;
  }

  atPunct(text: string): boolean {
    const token = this.peek();
    return token.type === "punct" && token.text === text;
  }

  atKeyword(keyword: string): boolean {
    const token = this.peek();
    return token.type === "word" && token.text.toUpperCase() === keyword;
  }

  /** A word followed by `(`: a function call. */
  atCall(): boolean {
    const next = this.peek(1);
    return this.peek().type === "word" && next.type === "punct" && next.text === "(";
  }

  expectPunct(text: string): void {
    if (!this.atPunct(text)) this.fail(`expected "${text}"`);
    this.next();
  }

  // Reporting.

  report(kind: ViolationKind, message: string, token: Pick<Token, "text" | "offset">): void {
    this.violations.push({
      kind,
      field: fieldOf(this.kind),
      message,
      token: token.text,
      offset: token.offset,
    });
  }

  forbid(message: string, token: Token): void {
    this.report("kind-grammar", message, token);
  }

  fail(message: string, token: Pick<Token, "text" | "offset"> = this.peek()): never {
    const found = token.text === "" ? "the end of the expression" : `"${token.text}"`;
    this.report("syntax", `Syntax error at ${found}: ${message}.`, token);
    throw new SyntaxStop();
  }

  use(placeholders: Map<string, number>, token: Token): void {
    if (!placeholders.has(token.text)) placeholders.set(token.text, token.offset);
  }

  // Paths.

  /** `name(.name | [n])*`. `arithmetic` is true where `a-b` is a subtraction. */
  parsePath(arithmetic: boolean): ActionPath {
    const offset = this.peek().offset;
    const segments = [this.parseSegment(arithmetic)];
    for (;;) {
      if (this.atPunct(".")) {
        this.next();
        segments.push(this.parseSegment(arithmetic));
      } else if (this.atPunct("[")) {
        this.next();
        const index = this.next();
        if (index.type !== "number") this.fail("expected a list index", index);
        this.expectPunct("]");
        segments.push(`[${index.text}]`);
      } else {
        return { segments, offset };
      }
    }
  }

  parseSegment(arithmetic: boolean): string {
    const token = this.next();
    if (token.type === "name") {
      this.use(this.names, token);
      return token.text;
    }
    if (token.type !== "word") this.fail("expected an attribute name", token);
    let text = token.text;
    // Outside arithmetic, `my-attr` is one name that needed an alias, not a
    // subtraction, so report it whole rather than as a syntax error at `-`.
    if (!arithmetic) {
      let end = token.offset + text.length;
      while (this.atPunct("-") && this.peek().offset === end) {
        const part = this.peek(1);
        if (part.type !== "word" || part.offset !== end + 1) break;
        this.next();
        this.next();
        text += `-${part.text}`;
        end = part.offset + part.text.length;
      }
    }
    this.checkName({ text, offset: token.offset });
    return text;
  }

  checkName(token: Pick<Token, "text" | "offset">): void {
    const legal = LEGAL_NAME.test(token.text);
    if (legal && !isReservedWord(token.text)) return;
    const alias = `#${token.text.replace(/[^A-Za-z0-9_]/g, "_")}`;
    const fix = `alias it: ExpressionAttributeNames { "${alias}": "${token.text}" }`;
    if (legal) {
      this.report("reserved-word", `"${token.text}" is a reserved word; ${fix}.`, token);
    } else {
      this.report(
        "must-alias",
        `"${token.text}" needs an alias: an unaliased name is an ASCII letter followed by letters, digits or "_"; ${fix}.`,
        token,
      );
    }
  }

  // Function calls.

  /** Reports a function used where it isn't allowed, then parses the call. */
  parseCall(site: CallSite): void {
    const name = this.next();
    const role = FUNCTIONS[name.text];
    if (role === undefined) this.fail(`unknown function "${name.text}"`, name);
    const call = `${name.text}()`;
    if (site === "condition") {
      if (this.kind === "keyCondition" && name.text !== "begins_with") {
        this.forbid(`${call} is not allowed: ${KEY_CONDITION_GRAMMAR}.`, name);
      }
    } else if (site === "operand") {
      if (role === "boolean") {
        this.fail(`${call} is a condition on its own, not a value to compare`, name);
      }
      if (role === "update") {
        this.forbid(
          `${call} is not allowed in a ${this.kind} expression; it is valid only on the right of SET.`,
          name,
        );
      } else if (this.kind === "keyCondition") {
        this.forbid(`${call} is not allowed: ${KEY_CONDITION_GRAMMAR}.`, name);
      }
    } else if (site === "update") {
      if (role !== "update") {
        this.forbid(
          `${call} is not allowed in an update expression; only if_not_exists() and list_append() are.`,
          name,
        );
      }
    } else if (site === "target") {
      this.forbid(
        `${call} can't be the target of an update action; write the attribute path.`,
        name,
      );
    } else {
      this.forbid(`${call} is not allowed in a projection, which lists paths only.`, name);
    }
    this.next(); // "("
    this.operators++;
    const update = site !== "condition" && site !== "operand";
    if (!this.atPunct(")")) {
      this.parseOperand(update);
      while (this.atPunct(",")) {
        this.next();
        this.parseOperand(update);
      }
    }
    this.expectPunct(")");
  }

  /** A path, a `:value` or a function call: in a condition, or (`update`) on the right of SET. */
  parseOperand(update: boolean): void {
    const token = this.peek();
    if (token.type === "value") {
      this.next();
      this.use(this.values, token);
    } else if (this.atCall()) {
      this.parseCall(update ? "update" : "operand");
    } else {
      this.parsePath(update);
    }
  }

  // Conditions: condition, filter and key condition expressions.

  parseOr(): void {
    this.parseAnd();
    while (this.atKeyword("OR")) {
      this.keyConditionForbids(this.next());
      this.operators++;
      this.parseAnd();
    }
  }

  parseAnd(): void {
    this.parseNot();
    while (this.atKeyword("AND")) {
      this.next();
      this.operators++;
      this.parseNot();
    }
  }

  parseNot(): void {
    if (this.atKeyword("NOT")) {
      this.keyConditionForbids(this.next());
      this.operators++;
      this.parseNot();
    } else {
      this.parsePrimary();
    }
  }

  parsePrimary(): void {
    if (this.atPunct("(")) {
      this.next();
      this.parseOr();
      this.expectPunct(")");
      return;
    }
    if (this.atCall() && FUNCTIONS[this.peek().text] === "boolean") {
      this.parseCall("condition");
      return;
    }
    this.parseOperand(false);
    const token = this.peek();
    if (token.type === "punct" && COMPARATORS.has(token.text)) {
      this.next();
      this.operators++;
      if (token.text === "<>") this.keyConditionForbids(token);
      this.parseOperand(false);
    } else if (this.atKeyword("BETWEEN")) {
      this.next();
      this.operators++;
      this.parseOperand(false);
      if (!this.atKeyword("AND")) this.fail('expected "AND" to close BETWEEN');
      this.next();
      this.parseOperand(false);
    } else if (this.atKeyword("IN")) {
      this.keyConditionForbids(this.next());
      this.operators++;
      this.parseInList();
    } else {
      this.fail("expected a comparison");
    }
  }

  parseInList(): void {
    this.expectPunct("(");
    const first = this.peek();
    let operands = 1;
    this.parseOperand(false);
    while (this.atPunct(",")) {
      this.next();
      operands++;
      this.parseOperand(false);
    }
    this.expectPunct(")");
    if (operands > MAX_IN_OPERANDS) {
      this.report("limit", tooMany("IN has # operands", operands, MAX_IN_OPERANDS), first);
    }
  }

  keyConditionForbids(token: Token): void {
    if (this.kind === "keyCondition") {
      this.forbid(`${token.text} is not allowed: ${KEY_CONDITION_GRAMMAR}.`, token);
    }
  }

  // Update expressions.

  parseUpdate(): void {
    if (this.peek().type === "end") this.fail("an update expression can't be empty");
    const seen = new Set<string>();
    while (this.peek().type !== "end") {
      const keyword = this.next();
      const clause = keyword.type === "word" ? keyword.text.toUpperCase() : "";
      if (!CLAUSES.has(clause)) this.fail("expected SET, REMOVE, ADD or DELETE", keyword);
      if (seen.has(clause)) this.fail(`the ${clause} section can be used only once`, keyword);
      seen.add(clause);
      this.parseAction(clause);
      while (this.atPunct(",")) {
        this.next();
        this.parseAction(clause);
      }
    }
  }

  parseAction(clause: string): void {
    if (this.atCall()) this.parseCall("target");
    else this.actionPaths.push(this.parsePath(false));
    if (clause === "SET") {
      this.expectPunct("=");
      this.parseOperand(true);
      if (this.atPunct("+") || this.atPunct("-")) {
        this.next();
        this.operators++;
        this.parseOperand(true);
      }
    } else if (clause !== "REMOVE") {
      const value = this.next();
      if (value.type !== "value") this.fail(`${clause} takes a :value after the path`, value);
      this.use(this.values, value);
    }
  }

  // Projection expressions.

  parseProjection(): void {
    for (;;) {
      if (this.atCall()) this.parseCall("projection");
      else this.parsePath(false);
      if (!this.atPunct(",")) return;
      this.next();
    }
  }

  parse(expression: string): void {
    try {
      this.#tokens = tokenize(expression);
      if (this.kind === "update") this.parseUpdate();
      else if (this.kind === "projection") this.parseProjection();
      else this.parseOr();
      if (this.peek().type !== "end") this.fail("expected the end of the expression");
    } catch (error) {
      if (error instanceof TokenizeError) {
        this.report("syntax", `Syntax error at "${error.token}": ${error.message}.`, {
          text: error.token,
          offset: error.offset,
        });
      } else if (!(error instanceof SyntaxStop)) {
        throw error;
      }
    }
  }
}

/** Parses one expression of `kind`, collecting its violations (limits included) and references. */
export function parseExpression(expression: string, kind: ExpressionKind): ParsedExpression {
  const parser = new Parser(kind);
  parser.parse(expression);
  const field = fieldOf(kind);
  const bytes = byteLength(expression);
  if (bytes > MAX_EXPRESSION_BYTES) {
    parser.violations.push({
      kind: "limit",
      field,
      message: tooMany("The expression is # bytes", bytes, MAX_EXPRESSION_BYTES),
    });
  }
  if (parser.operators > MAX_OPERATORS) {
    parser.violations.push({
      kind: "limit",
      field,
      message: tooMany(
        "The expression has # operators and functions",
        parser.operators,
        MAX_OPERATORS,
      ),
    });
  }
  return parser;
}
