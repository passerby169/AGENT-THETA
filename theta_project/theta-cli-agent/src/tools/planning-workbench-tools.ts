import type { JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import { CapabilityRegistry } from '../capabilities/registry.js';
import { createThetaRuntimeComposition, defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { GOVERNED_PLAN_TARGET_PATHS, researchAlignmentItems, validateIntentAlignment } from '../planner-v3/alignment-validator.js';
import { planCompletionProgress } from '../planner-v3/completion-gates.js';
import { ThetaPlannerEventRepository } from '../planner-v3/event-store.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import { thetaModelListAvailableHandler } from './model-planning-tools.js';
import {
  thetaRuntimeCheckOfflineReadinessHandler,
  thetaRuntimeProfileHardwareHandler,
} from './runtime-planning-tools.js';
import {
  thetaPlannerSelectEvidenceHandler,
  thetaPlannerValidatePreviewHandler,
} from './planner-v3-tools.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';

const spec = (
  id: string,
  displayName: string,
  description: string,
  inputSchema: JsonSchema,
  permissionScope: string[],
  write = false,
): ToolSpec => ({
  id,
  version: '1.0.0',
  displayName,
  description,
  tags: ['theta', 'planner-v3', 'workbench'],
  inputSchema,
  outputSchema: { type: 'object', additionalProperties: true },
  sideEffectLevel: write ? 'write' : 'read',
  permissionScope,
  timeoutPolicy: { timeoutMs: 90_000, onTimeout: 'fail' },
  retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: false },
  source: 'local',
});

export const thetaPlannerInspectCaseToolSpec = spec(
  THETA_TOOL_IDS.plannerInspectCase,
  'Inspect planning case',
  'Read one compact, hash-bound planning workbench containing current Dataset/Research intent, accepted decisions, boundaries, model availability, hardware, active candidate receipts and completion gates. Prefer this over many separate read calls.',
  { type: 'object', additionalProperties: false },
  [THETA_PERMISSION_SCOPES.datasetRead, THETA_PERMISSION_SCOPES.researchRead, THETA_PERMISSION_SCOPES.modelRead, THETA_PERMISSION_SCOPES.planRead, THETA_PERMISSION_SCOPES.runtimeRead],
);

export const thetaModelShortlistToolSpec = spec(
  THETA_TOOL_IDS.modelShortlist,
  'Inspect a model shortlist',
  'Read capability, executable parameter defaults and actual offline readiness for only the models the Agent considers plausible. This tool does not choose a winner.',
  {
    type: 'object',
    required: ['modelIds'],
    properties: {
      modelIds: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9_-]+$' } },
    },
    additionalProperties: false,
  },
  [THETA_PERMISSION_SCOPES.modelRead, THETA_PERMISSION_SCOPES.runtimeRead],
);

export const thetaPlannerEvaluateCandidateToolSpec = spec(
  THETA_TOOL_IDS.plannerEvaluateCandidate,
  'Bind evidence and evaluate candidate',
  'Atomically bind only legal local evidence IDs declared by the active candidate, then run structural, parameter, runtime and research-intent alignment validation. Returns exact completion gates.',
  {
    type: 'object',
    required: ['candidateRef', 'evidenceIds'],
    properties: {
      candidateRef: { type: 'string', minLength: 1 },
      evidenceIds: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  [THETA_PERMISSION_SCOPES.planRead, THETA_PERMISSION_SCOPES.planWrite, THETA_PERMISSION_SCOPES.ragRead, THETA_PERMISSION_SCOPES.runtimeRead],
  true,
);

export const thetaPlannerValidateAlignmentToolSpec = spec(
  THETA_TOOL_IDS.plannerValidateAlignment,
  'Check research-plan alignment',
  'Check the active candidate against every consequential dynamic ResearchWorkspace item without changing the candidate.',
  {
    type: 'object',
    properties: { candidateRef: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  },
  [THETA_PERMISSION_SCOPES.researchRead, THETA_PERMISSION_SCOPES.planRead],
);

export const thetaPlannerInspectCaseHandler: ToolHandler<unknown, Record<string, unknown>> = async (_input, context) =>
  withRuntime(context, async (runtime) => {
    const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
    const dataset = await workspaces.current(context.runId, 'dataset');
    const research = await workspaces.current(context.runId, 'research');
    if (!dataset || dataset.workspaceType !== 'dataset' || !research || research.workspaceType !== 'research') {
      throw new Error('Planning case requires current Dataset and Research Workspaces.');
    }
    const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
    const candidate = await planner.candidate(context.runId);
    const evidenceReceipt = candidate ? await planner.evidenceReceipt(context.runId, candidate.candidatePlanHash) : null;
    const validationReceipt = candidate ? await planner.validationReceipt(context.runId, candidate.candidatePlanHash) : null;
    const available = await thetaModelListAvailableHandler({}, context) as Record<string, unknown>;
    const hardware = await thetaRuntimeProfileHardwareHandler({}, context) as Record<string, unknown>;
    return {
      dataset: {
        workspaceRef: `workspace:dataset:${dataset.revision}`,
        workspaceHash: dataset.workspaceHash,
        narrative: dataset.narrative,
        columnRoles: dataset.columnRoles,
        risks: dataset.risks,
      },
      research: {
        workspaceRef: `workspace:research:${research.revision}`,
        workspaceHash: research.workspaceHash,
        narrative: research.narrative,
        alignmentItems: researchAlignmentItems(research),
        openBlockingQuestions: research.questions.filter((item) => item.status === 'open' && item.blocking),
      },
      intentBindingContract: {
        governedTargetPaths: GOVERNED_PLAN_TARGET_PATHS,
        parameterPathPattern: 'model.parameters.<actual_parameter_id>',
        rules: [
          'Planner-owned targets are limited to model.modelId, model.mode, model.parameters.<actual_parameter_id>, and experimentProtocol.seeds.',
          'Use inherited_workspace with no targets for verified dataset facts and column roles; Planner must not re-decide them.',
          'Use pipeline_managed with no targets for evaluation metrics, result interpretation, reports and visualizations; Python generates them automatically.',
          'Exactly one seed is required. Baselines and multi-seed protocols are not part of Planner output.',
          'Use intentionally_excluded only for a non-blocking item deliberately outside scope; never add a fake plan target.',
        ],
        examples: [
          { intent: 'industry is display-only', disposition: 'inherited_workspace', planTargets: [] },
          { intent: 'use 10 target topics', disposition: 'implemented', planTargets: [{ path: 'model.parameters.topic_target', value: 10 }] },
          { intent: 'generate evaluation charts', disposition: 'pipeline_managed', planTargets: [] },
          { intent: 'use seed 42', disposition: 'implemented', planTargets: [{ path: 'experimentProtocol.seeds', value: [42] }] },
        ],
      },
      availableModels: available.models ?? [],
      hardware,
      activeCandidate: candidate,
      evidenceReceipt,
      validationReceipt,
      completion: planCompletionProgress({ candidate, evidenceReceipt, validationReceipt }),
      instruction: candidate
        ? 'Repair only unresolved gates on the active candidate; do not create a duplicate candidate.'
        : 'Choose a small model shortlist, retrieve consequential evidence, then create one intent-bound candidate.',
    };
  });

export const thetaModelShortlistHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const ids = [...new Set((record(input).modelIds as string[] | undefined) ?? [])];
  const registry = new CapabilityRegistry();
  const models = [];
  for (const modelId of ids) {
    const card = registry.require(modelId);
    if (!registry.plannerEligibleModelIds().includes(modelId)) throw new Error(`Model is not Planner eligible: ${modelId}.`);
    const offline = await thetaRuntimeCheckOfflineReadinessHandler({ modelId }, context) as Record<string, unknown>;
    models.push({
      modelId,
      displayName: card.displayName,
      maturity: card.maturity,
      implementation: card.implementation,
      capabilities: card.capabilities,
      parameters: card.parameters
        .filter((parameter) => parameter.exposure === 'agent_compiled')
        .map((parameter) => ({
          parameterId: parameter.parameterId,
          valueType: parameter.valueType,
          defaultValue: parameter.defaultValue,
          minimum: parameter.minimum ?? null,
          maximum: parameter.maximum ?? null,
          choices: parameter.choices,
          usedByTraining: parameter.usedByTraining,
          notes: parameter.notes,
        })),
      limitations: card.limitations,
      offlineReadiness: offline,
    });
  }
  return { models, compared: models.length, chooser: 'theta-agent-minimax' };
};

export const thetaPlannerEvaluateCandidateHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const value = record(input);
  const candidateRef = String(value.candidateRef);
  const evidenceIds = value.evidenceIds as string[];
  await thetaPlannerSelectEvidenceHandler({ candidateRef, evidenceIds }, context);
  const validation = await thetaPlannerValidatePreviewHandler({ candidateRef }, context) as Record<string, unknown>;
  return withRuntime(context, async (runtime) => {
    const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
    const candidate = await planner.candidate(context.runId, candidateRef);
    if (!candidate) throw new Error(`Candidate was not found after evaluation: ${candidateRef}.`);
    const evidenceReceipt = await planner.evidenceReceipt(context.runId, candidate.candidatePlanHash);
    const validationReceipt = await planner.validationReceipt(context.runId, candidate.candidatePlanHash);
    const completion = planCompletionProgress({ candidate, evidenceReceipt, validationReceipt });
    return {
      candidateRef,
      candidatePlanHash: candidate.candidatePlanHash,
      evidenceReceipt,
      validationReceipt,
      runtimeReadiness: validation.runtimeReadiness ?? null,
      completion,
      instruction: completion.percent === 100
        ? 'All exact completion gates are satisfied. Finish PlanDesign now; do not call more planning tools.'
        : 'Revise only the blocking issues, then evaluate the new candidate revision once.',
    };
  });
};

export const thetaPlannerValidateAlignmentHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) =>
  withRuntime(context, async (runtime) => {
    const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
    const candidate = await planner.candidate(context.runId, optionalText(record(input).candidateRef));
    const research = await new ThetaWorkspaceEventRepository(runtime.eventBridge).current(context.runId, 'research');
    if (!candidate || !research || research.workspaceType !== 'research') throw new Error('Current candidate or ResearchWorkspace was not found.');
    const issues = validateIntentAlignment(candidate, research);
    return {
      candidateRef: candidate.candidateRef,
      valid: !issues.some((issue) => issue.severity === 'blocking'),
      items: researchAlignmentItems(research),
      bindings: candidate.intentBindings,
      issues,
    };
  });

const withRuntime = async <T>(
  context: ToolCallContext,
  operation: (runtime: Awaited<ReturnType<typeof createThetaRuntimeComposition>>) => Promise<T>,
): Promise<T> => {
  const runtimeDb = typeof context.metadata?.thetaRuntimeDb === 'string'
    ? context.metadata.thetaRuntimeDb
    : defaultThetaV6RuntimeDb();
  const runtime = await createThetaRuntimeComposition(runtimeDb);
  try { return await operation(runtime); }
  finally { await runtime.close(); }
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
