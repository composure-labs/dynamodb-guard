import { describe, expect, it } from "vitest";
import { checkPartialRequest, formatViolations, UNKNOWN } from "../../src/core/check.js";
import { RESERVED_WORDS } from "../../src/core/reserved-words.js";
import {
  assertRequest,
  checkExpression,
  checkRequest,
  DynamoExpressionError,
  type ExpressionKind,
  isReservedWord,
} from "../../src/index.js";

const kinds = (expression: string, kind: ExpressionKind) =>
  checkExpression(expression, kind).map((v) => v.kind);

describe("RESERVED_WORDS", () => {
  it("holds DynamoDB's 573 words, upper-cased", () => {
    expect(RESERVED_WORDS.size).toBe(573);
    expect([...RESERVED_WORDS].every((word) => word === word.toUpperCase())).toBe(true);
  });

  it("matches in any letter case", () => {
    expect([
      isReservedWord("status"),
      isReservedWord("Metrics"),
      isReservedWord("statuses"),
    ]).toEqual([true, true, false]);
  });
});

describe("checkExpression", () => {
  it("accepts a valid expression of each kind", () => {
    expect(kinds("SET a = :v, b = a + :w REMOVE c ADD d :x DELETE e :y", "update")).toEqual([]);
    expect(kinds("(a = :v OR NOT b <> :w) AND attribute_type(c, :t)", "condition")).toEqual([]);
    expect(kinds("pk = :p AND sk BETWEEN :a AND :b", "keyCondition")).toEqual([]);
    expect(kinds("a.b[0].c, #d", "projection")).toEqual([]);
  });

  it("reports syntax DynamoDB can't parse", () => {
    for (const [expression, kind] of [
      ["SET # = :v", "update"],
      ["a = :", "filter"],
      ["SET l[x] = :v", "update"],
      ["SET l[0 = :v", "update"],
      ["a BETWEEN :x :y", "filter"],
      ["unknown_fn(a)", "condition"],
      ["contains(a, :v) = :v", "condition"],
      ["FOO a", "update"],
      ["ADD a b", "update"],
      ["a = :v b", "filter"],
      ["SET = :v", "update"],
      ["attribute_exists(my - attr)", "condition"],
      ["a", "condition"],
    ] as const) {
      expect(kinds(expression, kind), expression).toEqual(["syntax"]);
    }
  });

  it("reports grammar that is valid elsewhere but not in this kind", () => {
    expect(kinds("pk = :p AND attribute_exists(sk)", "keyCondition")).toEqual(["kind-grammar"]);
    expect(kinds("pk IN (:p)", "keyCondition")).toEqual(["kind-grammar"]);
    expect(kinds("SET a = size(l)", "update")).toEqual(["kind-grammar"]);
    expect(kinds("REMOVE if_not_exists(a, :v)", "update")).toEqual(["kind-grammar"]);
    expect(checkExpression("if_not_exists(a, :v) = :v", "filter")[0]?.message).toMatch(
      /in a filter expression/,
    );
  });

  it("treats a-b as subtraction on the right of SET, and as one name elsewhere", () => {
    expect(kinds("SET c = a-b", "update")).toEqual([]);
    expect(kinds("SET c = :v REMOVE my-attr-name", "update")).toEqual(["must-alias"]);
  });

  it("reports limits", () => {
    expect(
      kinds(Array.from({ length: 700 }, (_, i) => `attr${String(i)}`).join(", "), "projection"),
    ).toEqual(["limit"]);
    expect(kinds(Array.from({ length: 151 }, () => "a = :v").join(" OR "), "filter")).toEqual([
      "limit",
    ]);
    expect(kinds(`a IN (${Array.from({ length: 101 }, () => ":v").join(", ")})`, "filter")).toEqual(
      ["limit"],
    );
  });
});

describe("checkRequest", () => {
  it("reports placeholders when the request has no map for them", () => {
    const violations = checkRequest({ UpdateExpression: "SET #a = :v" });

    expect(violations.map((v) => [v.kind, v.token])).toEqual([
      ["undefined-alias", "#a"],
      ["undefined-alias", ":v"],
    ]);
  });

  it("points at the placeholder itself, not an earlier one it prefixes", () => {
    const [violation] = checkRequest({
      UpdateExpression: "SET #ab = :v, #a = :v",
      ExpressionAttributeNames: { "#ab": "x" },
      ExpressionAttributeValues: { ":v": 1 },
    });

    expect([violation.token, violation.offset]).toEqual(["#a", 14]);
  });

  it("reports every unused entry in one violation", () => {
    const [violation] = checkRequest({
      UpdateExpression: "SET a = :v",
      ExpressionAttributeValues: { ":v": 1, ":w": 2, ":x": 3 },
    });

    expect(violation.message).toMatch(
      /^:w, :x are in ExpressionAttributeValues but no expression uses them/,
    );
  });

  it("finds overlapping paths through name placeholders and list indexes", () => {
    const viaAlias = checkRequest({
      UpdateExpression: "SET #a = :v, a = :w",
      ExpressionAttributeNames: { "#a": "a" },
      ExpressionAttributeValues: { ":v": 1, ":w": 2 },
    });
    const viaIndex = checkRequest({
      UpdateExpression: "SET l = :v REMOVE l[0]",
      ExpressionAttributeValues: { ":v": [1] },
    });

    expect(viaAlias.map((v) => v.message)).toEqual([
      expect.stringMatching(/^"a" is updated twice/),
    ]);
    expect(viaIndex.map((v) => v.message)).toEqual([
      expect.stringMatching(/^"l" and "l\[0\]" overlap/),
    ]);
  });

  it("ignores fields that are not expressions, such as TableName and Key", () => {
    const request = {
      TableName: "t",
      Key: { pk: "p" },
      UpdateExpression: "SET a = :v",
      ExpressionAttributeValues: { ":v": 1 },
    };

    expect(checkRequest(request)).toEqual([]);
  });
});

describe("assertRequest", () => {
  it("passes a request DynamoDB accepts", () => {
    expect(() => {
      assertRequest({ ProjectionExpression: "a" });
    }).not.toThrow();
  });

  it("throws every violation, with a caret under each token and the AWS doc", () => {
    const request = {
      UpdateExpression: "SET status = :v",
      ExpressionAttributeValues: { ":v": 1, ":unused": 2 },
    };
    let error: unknown;
    try {
      assertRequest(request);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(DynamoExpressionError);
    const { message, violations, name } = error as DynamoExpressionError;
    expect(name).toBe("DynamoExpressionError");
    expect(violations.map((v) => v.kind)).toEqual(["reserved-word", "unused-alias"]);
    expect(message).toBe(
      [
        "DynamoDB would reject this request:",
        'UpdateExpression: "status" is a reserved word; alias it: ExpressionAttributeNames { "#status": "status" }.',
        "  SET status = :v",
        "      ^^^^^^",
        "  See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ReservedWords.html",
        "ExpressionAttributeValues: :unused is in ExpressionAttributeValues but no expression uses it; remove it.",
        "  See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ExpressionAttributeNames.html",
      ].join("\n"),
    );
  });

  it("formats a violation with no token on two lines", () => {
    const violations = checkRequest({ ExpressionAttributeNames: { "#a": "a" } });

    expect(formatViolations({}, violations).split("\n")).toHaveLength(2);
  });
});

describe("checkPartialRequest", () => {
  it("doesn't report entries unused when an expression is unknown", () => {
    const { violations, unknown } = checkPartialRequest({
      UpdateExpression: UNKNOWN,
      ConditionExpression: "attribute_exists(status)",
      ExpressionAttributeValues: { ":v": 1 },
    });

    expect(violations.map((v) => v.kind)).toEqual(["reserved-word"]);
    expect(unknown).toEqual(["UpdateExpression"]);
  });

  it("doesn't report a map without an expression when one is unknown", () => {
    const { violations } = checkPartialRequest({
      ProjectionExpression: UNKNOWN,
      ExpressionAttributeNames: { "#a": "a" },
    });

    expect(violations).toEqual([]);
  });

  it("judges each map on its own: an unknown map hides only its own placeholders", () => {
    const { violations, unknown } = checkPartialRequest({
      UpdateExpression: "SET #a = :v",
      ExpressionAttributeNames: UNKNOWN,
      ExpressionAttributeValues: { ":w": 1 },
    });

    expect(violations.map((v) => [v.kind, v.token])).toEqual([
      ["undefined-alias", ":v"],
      ["unused-alias", ":w"],
    ]);
    expect(unknown).toEqual(["ExpressionAttributeNames"]);
  });
});
