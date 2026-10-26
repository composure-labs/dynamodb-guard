import { describe, expect, it } from "vitest";
import { findRequests } from "../../src/index.js";

describe("findRequests", () => {
  it("returns the value itself as a request", () => {
    const input = { TableName: "t", UpdateExpression: "SET a = :v" };

    expect(findRequests(input)).toEqual([{ path: "", request: input }]);
  });

  it("finds each item of a transaction", () => {
    const update = { UpdateExpression: "SET a = :v" };
    const check = { ConditionExpression: "attribute_exists(a)" };
    const sites = findRequests({
      TransactItems: [{ Update: update }, "junk", { ConditionCheck: check }],
    });

    expect(sites.slice(1)).toEqual([
      { path: "TransactItems[0].Update", request: update },
      { path: "TransactItems[2].ConditionCheck", request: check },
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
      { path: 'RequestItems["orders"]', request: { ProjectionExpression: "a" } },
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

  it("finds nothing in a value that isn't an object", () => {
    expect([findRequests(undefined), findRequests([]), findRequests("x")]).toEqual([[], [], []]);
  });
});
