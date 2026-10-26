import type { CfnResource } from "aws-cdk-lib";

/** One payload a resource sends DynamoDB. */
export interface Payload {
  /** Where it sits, as messages name it: `state "Complete" (dynamodb:updateItem) Parameters`. */
  readonly label: string;
  /** The DynamoDB operation, such as `updateItem`. */
  readonly operation: string;
  /** The payload, with `UNKNOWN` for each value not known at synth, or for the whole of it. */
  readonly value: unknown;
}

/**
 * A kind of CloudFormation resource that sends DynamoDB requests, and how to
 * read them out of its properties. The policy checks every resource of each
 * kind it has a source for.
 */
export interface RequestSource {
  /** Whether `resource` is one it reads: by type, or by shape for a type a user can rename. */
  matches(resource: CfnResource): boolean;
  /** What messages call one: `state machine`. */
  readonly noun: string;
  /** The payloads the resource sends, or why its properties can't be read. */
  read(resource: CfnResource): Payload[] | { readonly unreadable: string };
}
