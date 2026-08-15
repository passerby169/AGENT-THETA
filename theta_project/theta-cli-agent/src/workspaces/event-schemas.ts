import { hashCanonicalJson, type EventSchemaRegistry, type JsonSchema } from '@hypha/core';

export const THETA_WORKSPACE_EVENT_TYPE = 'runtime.observation.theta-workspace';
export const THETA_WORKSPACE_EVENT_SCHEMA_VERSION = '1.0.0';

const schema: JsonSchema = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: {
      enum: ['theta.workspace.revised', 'theta.workspace.downstream_invalidated'],
    },
  },
  additionalProperties: true,
};

export const registerThetaWorkspaceEventSchemas = async (
  registry: EventSchemaRegistry,
): Promise<void> => {
  await registry.register({
    eventType: THETA_WORKSPACE_EVENT_TYPE,
    version: THETA_WORKSPACE_EVENT_SCHEMA_VERSION,
    schema,
    schemaHash: hashCanonicalJson(schema),
    sensitivePaths: ['/workspace/sourceRefs'],
  });
};
