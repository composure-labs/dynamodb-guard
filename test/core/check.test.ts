import { describe, expect, it } from "vitest";
import { checkPartialRequest, formatViolations, UNKNOWN } from "../../src/core/check.js";
import { isReservedWord, RESERVED_WORDS } from "../../src/core/reserved-words.js";
import {
  assertRequest,
  checkExpression,
  checkRequest,
  DynamoExpressionError,
  type ExpressionKind,
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

  it("names the function and both counts when the arguments are wrong", () => {
    const [violation] = checkExpression("x = :v AND size(a, b) > :v", "filter");

    expect(violation).toMatchObject({
      kind: "argument-count",
      message: "size() takes 1 argument, not 2.",
      token: "size",
      offset: 11,
    });
    expect(checkExpression("begins_with(a)", "filter")[0]?.message).toBe(
      "begins_with() takes 2 arguments, not 1.",
    );
  });

  it("reports a call with no arguments as a syntax error, as DynamoDB does", () => {
    expect(checkExpression("size() > :v", "filter")).toEqual([
      expect.objectContaining({
        kind: "syntax",
        message: 'Syntax error at ")": size() takes 1 argument.',
        token: ")",
        offset: 5,
      }),
    ]);
  });

  it("counts the arguments of a call nested in another", () => {
    expect(kinds("SET a = list_append(if_not_exists(l), :v)", "update")).toEqual([
      "argument-count",
    ]);
  });

  it("reports a syntax error in the arguments, not their number", () => {
    expect(kinds("size(a,) > :v", "filter")).toEqual(["syntax"]);
  });

  it("leaves repeated paths to checkRequest, which knows the aliases", () => {
    expect(kinds("a, a", "projection")).toEqual([]);
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

  it("finds repeated and overlapping paths in a projection, pointing at the later one", () => {
    const repeated = checkRequest({
      ProjectionExpression: "b, #a, a",
      ExpressionAttributeNames: { "#a": "a" },
    });
    const overlapping = checkRequest({ ProjectionExpression: "a.b, a" });

    expect(repeated).toEqual([
      {
        kind: "overlapping-paths",
        field: "ProjectionExpression",
        message: `"a" is projected twice; one projection can't list both. Remove one.`,
        token: "a",
        offset: 7,
      },
    ]);
    expect(overlapping.map((v) => v.message)).toEqual([
      `"a.b" and "a" overlap; one projection can't list both. Remove one.`,
    ]);
  });

  it("doesn't report entries unused when a syntax error stopped the parse before them", () => {
    const values = { ":v": 1, ":w": 2 };

    for (const request of [
      { FilterExpression: "a = ) AND b = :v AND c = :w" },
      { FilterExpression: "a = :v AND b $ :w" },
      { ConditionExpression: "a = :v", UpdateExpression: "SET b = ) , c = :w" },
    ]) {
      expect(
        checkRequest({ ...request, ExpressionAttributeValues: values }).map((v) => v.kind),
        JSON.stringify(request),
      ).toEqual(["syntax"]);
    }
  });

  it("still reports an undefined placeholder the parse reached before a syntax error", () => {
    expect(checkRequest({ FilterExpression: "a = :v AND b = )" }).map((v) => v.kind)).toEqual([
      "syntax",
      "undefined-alias",
    ]);
  });

  it("compares paths only within an expression, not across a request", () => {
    expect(
      checkRequest({
        UpdateExpression: "SET a = :v",
        ConditionExpression: "attribute_exists(a)",
        ProjectionExpression: "a",
        ExpressionAttributeValues: { ":v": 1 },
      }),
    ).toEqual([]);
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

describe("checkRequest with an operation", () => {
  it("reports a ReturnValues the operation doesn't take, naming what it does", () => {
    expect(checkRequest({ ReturnValues: "ALL_NEW" }, "PutItem")).toEqual([
      {
        kind: "return-values",
        field: "ReturnValues",
        message: 'PutItem takes ReturnValues NONE or ALL_OLD, not "ALL_NEW".',
        token: "ALL_NEW",
      },
    ]);
  });

  it("accepts every ReturnValues on UpdateItem, and only those", () => {
    for (const value of ["NONE", "ALL_OLD", "UPDATED_OLD", "ALL_NEW", "UPDATED_NEW"]) {
      expect(checkRequest({ ReturnValues: value }, "UpdateItem"), value).toEqual([]);
    }
    expect(checkRequest({ ReturnValues: "all_new" }, "UpdateItem")[0]?.message).toBe(
      'UpdateItem takes ReturnValues NONE, ALL_OLD, UPDATED_OLD, ALL_NEW or UPDATED_NEW, not "all_new".',
    );
  });

  it("checks ReturnValuesOnConditionCheckFailure on each single write", () => {
    for (const operation of ["UpdateItem", "PutItem", "DeleteItem"]) {
      const request = { ReturnValuesOnConditionCheckFailure: "ALL_NEW" };

      expect(
        checkRequest(request, operation).map((v) => v.field),
        operation,
      ).toEqual(["ReturnValuesOnConditionCheckFailure"]);
      expect(checkRequest({ ReturnValuesOnConditionCheckFailure: "ALL_OLD" }, operation)).toEqual(
        [],
      );
    }
  });

  it("knows the operation however a guard spells it", () => {
    const spellings = [
      "DeleteItem",
      "deleteItem",
      "DeleteItemCommand",
      "DeleteCommand",
      "DynamoDeleteItem",
      "delete",
    ];
    for (const operation of spellings) {
      expect(checkRequest({ ReturnValues: "UPDATED_NEW" }, operation), operation).toHaveLength(1);
    }
  });

  it("doesn't judge return values without a write operation it knows", () => {
    const request = { ReturnValues: "BOGUS", ReturnValuesOnConditionCheckFailure: "BOGUS" };

    for (const operation of [undefined, "Query", "GetItem", "constructor", "UpdateTable"]) {
      expect(checkRequest(request, operation), operation).toEqual([]);
    }
  });

  it("formats a return-values violation without a caret", () => {
    const request = { ReturnValues: "ALL_NEW" };

    expect(() => {
      assertRequest(request, "PutCommand");
    }).toThrow(
      [
        "DynamoDB would reject this request:",
        'ReturnValues: PutItem takes ReturnValues NONE or ALL_OLD, not "ALL_NEW".',
        "  See https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html#WorkingWithItems.ReturnValues",
      ].join("\n"),
    );
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

  it("can't tell what an alias overlaps when the names map is unknown, except itself", () => {
    const check = (ProjectionExpression: string) =>
      checkPartialRequest({ ProjectionExpression, ExpressionAttributeNames: UNKNOWN }).violations;

    expect(check("#a, a")).toEqual([]);
    expect(check("#a, #b")).toEqual([]);
    expect(check("#a, #a").map((v) => v.kind)).toEqual(["overlapping-paths"]);
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

  it("reports an open map's listed entries unused, but none of its placeholders undefined", () => {
    const { violations, unknown } = checkPartialRequest({
      UpdateExpression: "SET a = :v",
      ExpressionAttributeValues: { ":w": 1, [UNKNOWN]: true },
    });

    expect(violations.map((v) => [v.kind, v.token])).toEqual([["unused-alias", ":w"]]);
    expect(unknown).toEqual([]);
  });
});
