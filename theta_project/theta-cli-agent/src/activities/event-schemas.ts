import { hashCanonicalJson, type EventSchemaRegistry, type JsonSchema } from '@hypha/core';

export const THETA_ACTIVITY_EVENT_TYPE = 'runtime.observation.theta-agent-activity';

const schema: JsonSchema = {
  type: 'object',
  required: ['kind', 'activity'],
  properties: {
    kind: { const: 'theta.agent.activity.recorded' },
    activity: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const registerThetaActivityEventSchemas = async (registry: EventSchemaRegistry): Promise<void> => {
  await registry.register({
    eventType: THETA_ACTIVITY_EVENT_TYPE,
    version: '1.0.0',
    schema,
    schemaHash: hashCanonicalJson(schema),
  });
};
