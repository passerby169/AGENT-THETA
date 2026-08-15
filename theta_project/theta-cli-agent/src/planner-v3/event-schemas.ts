import { hashCanonicalJson, type EventSchemaRegistry, type JsonSchema } from '@hypha/core';

export const THETA_PLANNER_EVENT_TYPE = 'runtime.observation.theta-planner';
export const THETA_PLANNER_EVENT_SCHEMA_VERSION = '1.0.0';

const schema: JsonSchema = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: {
      enum: [
        'theta.plan.candidate.recorded',
        'theta.plan.evidence.selected',
        'theta.plan.validation.completed',
        'theta.plan.approval.bound',
      ],
    },
  },
  additionalProperties: true,
};

export const registerThetaPlannerEventSchemas = async (
  registry: EventSchemaRegistry,
): Promise<void> => {
  await registry.register({
    eventType: THETA_PLANNER_EVENT_TYPE,
    version: THETA_PLANNER_EVENT_SCHEMA_VERSION,
    schema,
    schemaHash: hashCanonicalJson(schema),
  });
};
