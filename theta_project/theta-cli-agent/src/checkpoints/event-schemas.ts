import { hashCanonicalJson, type EventSchemaRegistry, type JsonSchema } from '@hypha/core';

export const THETA_CHECKPOINT_EVENT_TYPE = 'runtime.observation.theta-checkpoint';
export const THETA_CHECKPOINT_EVENT_SCHEMA_VERSION = '1.0.0';

const schema: JsonSchema = {
  type: 'object',
  required: ['kind', 'checkpoint'],
  properties: {
    kind: { enum: ['theta.checkpoint.proposed', 'theta.checkpoint.status_changed'] },
    checkpoint: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const registerThetaCheckpointEventSchemas = async (
  registry: EventSchemaRegistry,
): Promise<void> => {
  await registry.register({
    eventType: THETA_CHECKPOINT_EVENT_TYPE,
    version: THETA_CHECKPOINT_EVENT_SCHEMA_VERSION,
    schema,
    schemaHash: hashCanonicalJson(schema),
  });
};
