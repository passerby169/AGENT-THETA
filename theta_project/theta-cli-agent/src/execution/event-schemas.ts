import { hashCanonicalJson, type EventSchemaRegistry, type JsonSchema } from '@hypha/core';

export const THETA_EXECUTION_EVENT_TYPE = 'runtime.observation.theta-execution';
export const THETA_EXECUTION_EVENT_SCHEMA_VERSION = '1.0.0';

const schema: JsonSchema = {
  type: 'object',
  required: ['kind'],
  properties: {
    kind: {
      enum: [
        'theta.execution.canonical_plan.created',
        'theta.execution.dry_run.completed',
        'theta.execution.training_approval.created',
        'theta.execution.dataset_verification.completed',
        'theta.execution.training_run.accepted',
        'theta.execution.training_progress.observed',
        'theta.execution.training_cancellation.recorded',
        'theta.execution.artifact_manifest.verified',
      ],
    },
  },
  additionalProperties: true,
};

export const registerThetaExecutionEventSchemas = async (
  registry: EventSchemaRegistry,
): Promise<void> => {
  await registry.register({
    eventType: THETA_EXECUTION_EVENT_TYPE,
    version: THETA_EXECUTION_EVENT_SCHEMA_VERSION,
    schema,
    schemaHash: hashCanonicalJson(schema),
    sensitivePaths: ['/canonicalPlanRecord/canonicalPlan/datasetRef'],
  });
};
