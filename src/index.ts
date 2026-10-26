/**
 * The checker the guards build on. Nothing here may import a peer dependency:
 * test suites and lint configs import this entry point in projects that have
 * no CDK and no ESLint installed.
 */
export {
  assertRequest,
  checkExpression,
  checkRequest,
  DynamoExpressionError,
  type DynamoRequest,
} from "./core/check.js";
export type {
  ExpressionField,
  ExpressionKind,
  Violation,
  ViolationField,
  ViolationKind,
} from "./core/violations.js";
