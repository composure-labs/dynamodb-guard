/**
 * The synth-time guard: a policy that checks the DynamoDB expressions in Step
 * Functions definitions. Needs the optional `aws-cdk-lib` and `constructs` peers.
 */
export {
  DYNAMODB_EXPRESSION_WARNING,
  dynamodbExpressionPolicy,
  type DynamodbExpressionPolicyConfig,
  type DynamodbExpressionViolationMode,
} from "./cdk/policy.js";
