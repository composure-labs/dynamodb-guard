import { describe, expect, it } from "vitest";
import { checkRequestsIn, findRequests } from "../../src/core/requests.js";

describe("findRequests", () => {
  it("returns the value itself as a request", () => {
    const input = { TableName: "t", UpdateExpression: "SET a = :v" };

    expect(findRequests(input)).toEqual([{ path: "", request: input, operation: undefined }]);
  });

  it("finds each item of a transaction", () => {
    const update = { UpdateExpression: "SET a = :v" };
    const check = { ConditionExpression: "attribute_exists(a)" };
    const sites = findRequests({
      TransactItems: [{ Update: update }, "junk", { ConditionCheck: check }],
    });

    expect(sites.slice(1)).toEqual([
      { path: "TransactItems[0].Update", request: update, operation: "TransactItems.Update" },
      {
        path: "TransactItems[2].ConditionCheck",
        request: check,
        operation: "TransactItems.ConditionCheck",
      },
    ]);
  });

  it("finds each table of a BatchGetItem, which takes no values", () => {
    const sites = findRequests({
      RequestItems: {
        orders: { ProjectionExpression: "a", ExpressionAttributeValues: { ":v": 1 } },
        writes: [{ PutRequest: {} }],
      },
    });

    expect(sites.slice(1)).toEqual([
      {
        path: 'RequestItems["orders"]',
        request: { ProjectionExpression: "a" },
        operation: "BatchGetItem",
      },
    ]);
  });

  it("drops values from a Get, in a transaction or as the named operation", () => {
    const get = { ProjectionExpression: "a", ExpressionAttributeValues: { ":v": 1 } };

    expect(findRequests({ TransactItems: [{ Get: get }] })[1]?.request).toEqual({
      ProjectionExpression: "a",
    });
    for (const operation of ["GetItem", "getItem", "GetItemCommand", "GetCommand"]) {
      expect(findRequests(get, operation)[0]?.request, operation).toEqual({
        ProjectionExpression: "a",
      });
    }
    expect(findRequests(get, "Query")[0]?.request).toBe(get);
  });

  it("checks a transaction item's ReturnValuesOnConditionCheckFailure, but not its ReturnValues, which the SDK drops", () => {
    const sites = checkRequestsIn({
      TransactItems: [
        { Put: { ReturnValues: "ALL_NEW" } },
        { ConditionCheck: { ReturnValuesOnConditionCheckFailure: "ALL_NEW" } },
        { Get: { ReturnValuesOnConditionCheckFailure: "ALL_NEW" } },
      ],
    });

    expect(sites.map(({ path, violations }) => [path, violations.map((v) => v.message)])).toEqual([
      ["", []],
      ["TransactItems[0].Put", []],
      [
        "TransactItems[1].ConditionCheck",
        [
          'A transaction item takes ReturnValuesOnConditionCheckFailure NONE or ALL_OLD, not "ALL_NEW".',
        ],
      ],
      ["TransactItems[2].Get", []],
    ]);
  });

  it("checks the value's own return values against the operation it was sent to", () => {
    const put = { TableName: "t", ReturnValues: "ALL_NEW" };

    expect(checkRequestsIn(put, "PutCommand")[0]?.violations.map((v) => v.kind)).toEqual([
      "return-values",
    ]);
    expect(checkRequestsIn(put)[0]?.violations).toEqual([]);
  });

  it("finds nothing in a value that isn't an object", () => {
    expect([findRequests(undefined), findRequests([]), findRequests("x")]).toEqual([[], [], []]);
  });
});
