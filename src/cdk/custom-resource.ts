import { type CfnResource, Stack } from "aws-cdk-lib";
import { isRecord, UNKNOWN } from "../core/check.js";
import { hasToken, parseRendered, settle, type Unparsed } from "./rendered-json.js";
import type { Payload, RequestSource } from "./source.js";

/** The forms of `service` an `AwsCustomResource` call can name DynamoDB by. */
const DYNAMODB_SERVICES: ReadonlySet<unknown> = new Set([
  "DynamoDB",
  "dynamodb",
  "@aws-sdk/client-dynamodb",
]);

/** What `PhysicalResourceIdReference` renders as. The handler replaces it at deploy. */
const PHYSICAL_RESOURCE_ID = "PHYSICAL:RESOURCEID:";

/** The properties holding an `AwsCustomResource`'s calls, as JSON text. */
const PHASES = ["Create", "Update", "Delete"] as const;

const UNREADABLE: Readonly<Record<Unparsed, string>> = {
  intrinsic: "a CloudFormation intrinsic",
  json: "invalid JSON",
};

interface Phase {
  readonly name: (typeof PHASES)[number];
  readonly resolved: unknown;
  readonly call: { parsed: unknown } | Unparsed;
}

/**
 * A resource's properties, or `undefined` if aws-cdk-lib stops exposing them.
 * `cfnProperties` is protected, and a generic `CfnResource` has no other way to
 * read its properties. Protected members are part of aws-cdk-lib's API, unlike
 * the `_`-prefixed internals, and the tests prove this one at the floor and at
 * the newest release: if it goes away, they fail.
 */
function propertiesOf(resource: CfnResource): Record<string, unknown> | undefined {
  const { cfnProperties: properties } = resource as unknown as { cfnProperties: unknown };
  return isRecord(properties) ? properties : undefined;
}

/** The phases a resource defines. */
function phasesOf(resource: CfnResource, properties: Record<string, unknown>): Phase[] {
  const stack = Stack.of(resource);
  return PHASES.flatMap((name) => {
    if (properties[name] === undefined) return [];
    const resolved: unknown = stack.resolve(properties[name]);
    return [{ name, resolved, call: parseRendered(resolved) }];
  });
}

const isDynamoCall = (call: unknown): call is { action: string; parameters?: unknown } =>
  isRecord(call) && DYNAMODB_SERVICES.has(call.service) && typeof call.action === "string";

/** The request one phase sends: none if it calls another service, `UNKNOWN` if it can't be read. */
function payloadsOf({ name, call }: Phase): Payload[] {
  if (typeof call === "string") return [{ label: `${name} (${UNREADABLE[call]})`, value: UNKNOWN }];
  if (!isDynamoCall(call.parsed)) return [];
  const { action, parameters } = call.parsed;
  return [
    {
      label: `${name} (dynamodb:${action}) parameters`,
      operation: action,
      // Which fields the SDK drops depends on the operation, so without it nothing can be judged.
      value: hasToken(action)
        ? UNKNOWN
        : settle(parameters, { text: (text) => text === PHYSICAL_RESOURCE_ID }),
    },
  ];
}

/**
 * Each call an `AwsCustomResource` makes to DynamoDB. Matched by the shape of
 * its properties, because `resourceType` can be anything under `Custom::`.
 */
export const customResources: RequestSource = {
  // Claims a resource it can't read, so that reportUnchecked says so.
  matches(resource) {
    const properties = propertiesOf(resource);
    return (
      properties === undefined ||
      phasesOf(resource, properties).some(
        ({ call }) => typeof call === "object" && isDynamoCall(call.parsed),
      )
    );
  },
  noun: "custom resource",
  read(resource) {
    const properties = propertiesOf(resource);
    if (properties === undefined) {
      return { unreadable: "this aws-cdk-lib doesn't expose its properties (cfnProperties)" };
    }
    const phases = phasesOf(resource, properties);
    const update = JSON.stringify(phases.find(({ name }) => name === "Update")?.resolved);
    // CDK sets Create to `onCreate ?? onUpdate`, so one mistake would be reported twice.
    return phases
      .filter(({ name, resolved }) => name !== "Create" || JSON.stringify(resolved) !== update)
      .flatMap(payloadsOf);
  },
};
