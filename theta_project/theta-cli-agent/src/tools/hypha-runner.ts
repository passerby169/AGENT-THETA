import { InMemoryEventStore, type PolicyEngine } from '@hypha/core';
import { GovernedToolRunner, type ToolCallContext, type ToolCallResult } from '@hypha/tools';
import { createThetaHyphaToolRegistry } from './hypha-registry.js';
import type { ThetaDatasetDetectColumnsOutput } from './dataset-detect-columns-tool.js';
import type { ThetaDatasetFileInput, ThetaDatasetInspectOutput } from './dataset-inspect-tool.js';
import type { ThetaModelCatalogInput, ThetaModelCatalogOutput } from './model-catalog-tool.js';
import type {
  ThetaModelRecommendInput,
  ThetaModelRecommendOutput,
} from './model-recommend-tool.js';
import type { ThetaPlanApproveInput, ThetaPlanApproveOutput } from './plan-approve-tool.js';
import type { ThetaPlanCreateInput, ThetaPlanCreateOutput } from './plan-create-tool.js';
import type { ThetaPlanValidateInput, ThetaPlanValidateOutput } from './plan-validate-tool.js';
import type {
  ThetaTrainingDryRunInput,
  ThetaTrainingDryRunOutput,
} from './training-dry-run-tool.js';
import type {
  ThetaTrainingCancelInput,
  ThetaTrainingCancelOutput,
} from './training-cancel-tool.js';
import type { ThetaTrainingStartInput, ThetaTrainingStartOutput } from './training-start-tool.js';
import type {
  ThetaTrainingStatusInput,
  ThetaTrainingStatusOutput,
} from './training-status-tool.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

export interface ThetaHyphaRunnerOptions {
  userId?: string;
  workspaceId?: string;
  permissionScopes?: string[];
  idempotencyKey?: string;
  invocationId?: string;
}

export interface ThetaHyphaRuntime {
  runner: GovernedToolRunner;
  trace: InMemoryEventStore;
}

const thetaTrainingControlToolIds = new Set<string>([
  THETA_TOOL_IDS.trainingStart,
  THETA_TOOL_IDS.trainingCancel,
]);

const thetaCliPolicyEngine: PolicyEngine = {
  async evaluate(context) {
    if (
      context.sideEffectLevel === 'external_effect' &&
      context.capabilityId &&
      thetaTrainingControlToolIds.has(context.capabilityId)
    ) {
      return {
        allowed: true,
        requiresHumanReview: true,
        policyId: 'theta-cli-training-controls',
        ruleId: 'allow-approved-training-control',
        reason: 'THETA training external effects require explicit human approval.',
      };
    }

    if (
      context.sideEffectLevel === 'external_effect' ||
      context.sideEffectLevel === 'irreversible'
    ) {
      return {
        allowed: false,
        policyId: 'theta-cli-training-controls',
        ruleId: 'deny-unlisted-external-effects',
        reason: `Capability ${
          context.capabilityId ?? 'unknown'
        } is not an approved THETA training control.`,
      };
    }

    return {
      allowed: true,
      policyId: 'theta-cli-training-controls',
      ruleId: 'allow-local-capability',
    };
  },
};

export const createThetaHyphaRuntime = (): ThetaHyphaRuntime => {
  const registry = createThetaHyphaToolRegistry();
  const trace = new InMemoryEventStore();
  const runner = new GovernedToolRunner(registry, trace, thetaCliPolicyEngine);
  return { runner, trace };
};

export const createThetaToolCallContext = (
  runId: string,
  stepId: string,
  options: ThetaHyphaRunnerOptions = {}
): ToolCallContext => ({
  runId,
  stepId,
  invocationId: options.invocationId,
  idempotencyKey: options.idempotencyKey,
  userId: options.userId ?? 'local_user',
  workspaceId: options.workspaceId ?? 'local_workspace',
  principal: {
    id: options.userId ?? 'local_user',
    type: 'user',
    userId: options.userId ?? 'local_user',
    workspaceId: options.workspaceId ?? 'local_workspace',
    permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.modelRead],
  },
  metadata: {
    source: 'theta-cli-agent',
  },
});

export const runThetaDatasetInspect = async (
  input: ThetaDatasetFileInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaDatasetInspectOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.datasetInspect,
    input,
    context: createThetaToolCallContext('theta-dataset-inspect', 'dataset_inspect', {
      ...options,
      permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.datasetRead],
    }),
  }) as Promise<ToolCallResult<ThetaDatasetInspectOutput>>;
};

export const runThetaDatasetDetectColumns = async (
  input: ThetaDatasetFileInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaDatasetDetectColumnsOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.datasetDetectColumns,
    input,
    context: createThetaToolCallContext('theta-dataset-detect-columns', 'dataset_detect_columns', {
      ...options,
      permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.datasetRead],
    }),
  }) as Promise<ToolCallResult<ThetaDatasetDetectColumnsOutput>>;
};

export const runThetaModelCatalog = async (
  input: ThetaModelCatalogInput = {},
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaModelCatalogOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.modelCatalog,
    input,
    context: createThetaToolCallContext('theta-model-catalog-smoke', 'model_catalog', options),
  }) as Promise<ToolCallResult<ThetaModelCatalogOutput>>;
};

export const runThetaModelRecommend = async (
  input: ThetaModelRecommendInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaModelRecommendOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.modelRecommend,
    input,
    context: createThetaToolCallContext('theta-model-recommend-smoke', 'model_recommend', {
      ...options,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.modelRead,
        THETA_PERMISSION_SCOPES.datasetRead,
      ],
    }),
  }) as Promise<ToolCallResult<ThetaModelRecommendOutput>>;
};

export const runThetaPlanValidate = async (
  input: ThetaPlanValidateInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaPlanValidateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.planValidate,
    input,
    context: createThetaToolCallContext('theta-plan-validate-smoke', 'plan_validate', {
      ...options,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.planRead,
        THETA_PERMISSION_SCOPES.modelRead,
      ],
    }),
  }) as Promise<ToolCallResult<ThetaPlanValidateOutput>>;
};

export const requestThetaPlanCreate = async (
  input: ThetaPlanCreateInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaPlanCreateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.planCreate,
    input,
    context: createThetaToolCallContext('theta-plan-create-approval-smoke', 'plan_create', {
      ...options,
      idempotencyKey: options.idempotencyKey ?? 'theta-plan-create-approval-smoke',
      permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.planWrite],
    }),
  }) as Promise<ToolCallResult<ThetaPlanCreateOutput>>;
};

export const runApprovedThetaPlanCreate = async (
  input: ThetaPlanCreateInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaPlanCreateOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const invocationId = options.invocationId ?? 'theta-plan-create-approved-smoke';
  const context = createThetaToolCallContext('theta-plan-create-approved-smoke', 'plan_create', {
    ...options,
    invocationId,
    idempotencyKey: options.idempotencyKey ?? 'theta-plan-create-approved-smoke',
    permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.planWrite],
  });
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.planCreate,
    input,
    context,
  });

  if (requested.status !== 'human_review_required') {
    return requested as ToolCallResult<ThetaPlanCreateOutput>;
  }

  return runner.approveAndResume(invocationId, options.userId ?? 'local_user') as Promise<
    ToolCallResult<ThetaPlanCreateOutput>
  >;
};

export const requestThetaPlanApprove = async (
  input: ThetaPlanApproveInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaPlanApproveOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.planApprove,
    input,
    context: createThetaToolCallContext('theta-plan-approve-request', 'plan_approve', {
      ...options,
      idempotencyKey: options.idempotencyKey ?? 'theta-plan-approve-request',
      permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.planApprove],
    }),
  }) as Promise<ToolCallResult<ThetaPlanApproveOutput>>;
};

export const runApprovedThetaPlanApprove = async (
  input: ThetaPlanApproveInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaPlanApproveOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const invocationId = options.invocationId ?? 'theta-plan-approve-approved';
  const context = createThetaToolCallContext('theta-plan-approve-approved', 'plan_approve', {
    ...options,
    invocationId,
    idempotencyKey: options.idempotencyKey ?? 'theta-plan-approve-approved',
    permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.planApprove],
  });
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.planApprove,
    input,
    context,
  });

  if (requested.status !== 'human_review_required') {
    return requested as ToolCallResult<ThetaPlanApproveOutput>;
  }

  return runner.approveAndResume(invocationId, options.userId ?? 'local_user') as Promise<
    ToolCallResult<ThetaPlanApproveOutput>
  >;
};

export const runThetaTrainingDryRun = async (
  input: ThetaTrainingDryRunInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaTrainingDryRunOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingDryRun,
    input,
    context: createThetaToolCallContext('theta-training-dry-run', 'training_dry_run', {
      ...options,
      permissionScopes: options.permissionScopes ?? [
        THETA_PERMISSION_SCOPES.planRead,
        THETA_PERMISSION_SCOPES.trainingRead,
      ],
    }),
  }) as Promise<ToolCallResult<ThetaTrainingDryRunOutput>>;
};

export const requestThetaTrainingStart = async (
  input: ThetaTrainingStartInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaTrainingStartOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingStart,
    input,
    context: createThetaToolCallContext('theta-training-start-request', 'training_start', {
      ...options,
      idempotencyKey: options.idempotencyKey ?? input.idempotencyKey,
      permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.trainingWrite],
    }),
  }) as Promise<ToolCallResult<ThetaTrainingStartOutput>>;
};

export const runApprovedThetaTrainingStart = async (
  input: ThetaTrainingStartInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaTrainingStartOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const invocationId = options.invocationId ?? `theta-training-start-${input.idempotencyKey}`;
  const context = createThetaToolCallContext('theta-training-start-approved', 'training_start', {
    ...options,
    invocationId,
    idempotencyKey: options.idempotencyKey ?? input.idempotencyKey,
    permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.trainingWrite],
  });
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.trainingStart,
    input,
    context,
  });

  if (requested.status !== 'human_review_required') {
    return requested as ToolCallResult<ThetaTrainingStartOutput>;
  }

  return runner.approveAndResume(invocationId, options.userId ?? 'local_user') as Promise<
    ToolCallResult<ThetaTrainingStartOutput>
  >;
};

export const runThetaTrainingStatus = async (
  input: ThetaTrainingStatusInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaTrainingStatusOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingStatus,
    input,
    context: createThetaToolCallContext('theta-training-status', 'training_status', {
      ...options,
      permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.trainingRead],
    }),
  }) as Promise<ToolCallResult<ThetaTrainingStatusOutput>>;
};

export const requestThetaTrainingCancel = async (
  input: ThetaTrainingCancelInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaTrainingCancelOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  return runner.run({
    toolId: THETA_TOOL_IDS.trainingCancel,
    input,
    context: createThetaToolCallContext('theta-training-cancel-request', 'training_cancel', {
      ...options,
      idempotencyKey: options.idempotencyKey ?? `theta-training-cancel-${input.trainingRunId}`,
      permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.trainingWrite],
    }),
  }) as Promise<ToolCallResult<ThetaTrainingCancelOutput>>;
};

export const runApprovedThetaTrainingCancel = async (
  input: ThetaTrainingCancelInput,
  options: ThetaHyphaRunnerOptions = {}
): Promise<ToolCallResult<ThetaTrainingCancelOutput>> => {
  const { runner } = createThetaHyphaRuntime();
  const defaultKey = `theta-training-cancel-${input.trainingRunId}`;
  const invocationId = options.invocationId ?? defaultKey;
  const context = createThetaToolCallContext('theta-training-cancel-approved', 'training_cancel', {
    ...options,
    invocationId,
    idempotencyKey: options.idempotencyKey ?? defaultKey,
    permissionScopes: options.permissionScopes ?? [THETA_PERMISSION_SCOPES.trainingWrite],
  });
  const requested = await runner.run({
    toolId: THETA_TOOL_IDS.trainingCancel,
    input,
    context,
  });

  if (requested.status !== 'human_review_required') {
    return requested as ToolCallResult<ThetaTrainingCancelOutput>;
  }

  return runner.approveAndResume(invocationId, options.userId ?? 'local_user') as Promise<
    ToolCallResult<ThetaTrainingCancelOutput>
  >;
};
