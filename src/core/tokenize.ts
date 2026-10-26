/**
 * - `word`: a bare run of characters, such as an attribute name, a keyword or a
 *   function name. Whether it is a *legal* name is the parser's question, so
 *   `1abc`, `_u` and `café` are words too.
 * - `name` / `value`: a `#name` or `:value` placeholder, including its sigil.
 * - `number`: a list index, the digits between `[` and `]`.
 * - `punct`: an operator or bracket.
 */
export type TokenType = "word" | "name" | "value" | "number" | "punct" | "end";

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly offset: number;
}

const PUNCTUATION = ["<>", "<=", ">=", "=", "<", ">", "(", ")", "[", "]", ",", ".", "+", "-"];

/** Characters that end a word: the start of any punctuation, or of a placeholder. */
const BREAKS = new Set([...PUNCTUATION.map((p) => p.charAt(0)), "#", ":"]);

const PLACEHOLDER = /[A-Za-z0-9_]/;

const isSpace = (char: string): boolean => /\s/.test(char);

/** Thrown for a character that can't start any token. */
export class TokenizeError extends Error {
  constructor(
    message: string,
    readonly token: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** Splits an expression into tokens, ending with an `end` token at its length. */
export function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expression.length) {
    const char = expression.charAt(i);
    if (isSpace(char)) {
      i++;
      continue;
    }
    const start = i;
    if (char === "#" || char === ":") {
      i++;
      while (i < expression.length && PLACEHOLDER.test(expression.charAt(i))) i++;
      if (i === start + 1) {
        throw new TokenizeError(`"${char}" must be followed by a placeholder name`, char, start);
      }
      tokens.push({
        type: char === "#" ? "name" : "value",
        text: expression.slice(start, i),
        offset: start,
      });
      continue;
    }
    const punct = PUNCTUATION.find((p) => expression.startsWith(p, i));
    if (punct !== undefined) {
      tokens.push({ type: "punct", text: punct, offset: start });
      i += punct.length;
      continue;
    }
    while (
      i < expression.length &&
      !isSpace(expression.charAt(i)) &&
      !BREAKS.has(expression.charAt(i))
    )
      i++;
    const text = expression.slice(start, i);
    const inIndex = tokens.at(-1)?.text === "[";
    tokens.push({ type: inIndex && /^\d+$/.test(text) ? "number" : "word", text, offset: start });
  }
  tokens.push({ type: "end", text: "", offset: expression.length });
  return tokens;
}
