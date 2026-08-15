import { randomUUID } from 'node:crypto';
import { hashCanonicalJson, type JsonSchema } from '@hypha/core';
import type { ToolCallContext, ToolHandler, ToolSpec } from '@hypha/tools';
import {
  candidatePlanDraftSchema,
  candidatePlanHash,
  evidenceBundleHash,
  plannerDecisionDraftSchema,
  PLANNER_TOOL_CONTRACT_SNAPSHOT_HASH,
  validationReceiptHash,
  type CandidatePlan,
  type CandidatePlanDraft,
  type EvidenceSelectionReceipt,
  type PlannerDecisionDraft,
  type PlanValidationReceipt,
} from '../planner-v3/contracts.js';
import { ThetaPlannerEventRepository } from '../planner-v3/event-store.js';
import { validateCandidatePlan } from '../planner-v3/validator.js';
import { createThetaRuntimeComposition, defaultThetaV6RuntimeDb } from '../persistence/runtime-composition.js';
import { ThetaWorkspaceEventRepository } from '../workspaces/event-store.js';
import { emptyPlanWorkspace } from '../workspaces/factories.js';
import type { DatasetWorkspace, PlanWorkspace, WorkspaceSourceRef } from '../workspaces/contracts.js';
import { thetaRagGetEvidenceHandler } from './rag-planning-tools.js';
import { THETA_PERMISSION_SCOPES, THETA_TOOL_IDS } from './tool-ids.js';
import { thetaRuntimeCheckOfflineReadinessHandler } from './runtime-planning-tools.js';
import { planCompletionProgress } from '../planner-v3/completion-gates.js';
import { CapabilityRegistry } from '../capabilities/registry.js';

const scalarToolValueSchema: JsonSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
  ],
};

const scalarOrListToolValueSchema: JsonSchema = {
  anyOf: [
    scalarToolValueSchema,
    { type: 'array', items: scalarToolValueSchema },
  ],
  description: 'A scalar value or one flat scalar list. Empty lists are valid.',
};

export const candidateDraftToolSchema: JsonSchema = {
  type: 'object',
  required: ['datasetRef', 'model', 'seed', 'intentBindings', 'rationale'],
  description: 'Choose only one model, one random seed and executable hyperparameters. Dataset columns and all post-training metrics/visualizations are system-managed.',
  properties: {
    datasetRef: { type: 'string', minLength: 1 },
    model: {
      type: 'object',
      required: ['modelId', 'mode', 'parameters', 'rationale'],
      properties: {
        modelId: { type: 'string', pattern: '^[a-z0-9_-]+$' },
        mode: { type: 'string', minLength: 1 },
        parameters: { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } },
        rationale: { type: 'string', minLength: 1 },
        capabilityObservationRefs: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    seed: { type: 'integer', minimum: 0, maximum: 2147483647, description: 'Exactly one random seed for exactly one training run.' },
    intentBindings: {
      type: 'array',
      description: 'Exactly one binding for every non-optional alignment item returned by theta.planner.inspect_case.',
      items: {
        type: 'object',
        required: ['researchItemId', 'disposition', 'planTargets', 'rationale'],
        properties: {
          researchItemId: { type: 'string', minLength: 1 },
          disposition: {
            enum: ['implemented', 'inherited_workspace', 'pipeline_managed', 'intentionally_excluded', 'needs_user_decision'],
            description: 'Use implemented only for model/seed/hyperparameter decisions; inherited_workspace for confirmed dataset facts; pipeline_managed for automatic metrics, interpretation and visualizations.',
          },
          planTargets: {
            type: 'array',
            items: {
              type: 'object', required: ['path', 'value'],
              properties: {
                path: {
                  type: 'string',
                  minLength: 1,
                  description: 'Only model.modelId, model.mode, model.parameters.<name>, or experimentProtocol.seeds are Planner-owned targets.',
                },
                value: scalarOrListToolValueSchema,
              }, additionalProperties: false,
            },
          },
          rationale: { type: 'string', minLength: 1 },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        }, additionalProperties: false,
      },
    },
    evidenceRefs: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    rationale: { type: 'string', minLength: 1 },
  }, additionalProperties: false,
};

const draftSchema = candidateDraftToolSchema;

const spec = (id: string, name: string, description: string, inputSchema: JsonSchema, write = false): ToolSpec => ({
  id, version: '1.0.0', displayName: name, description, tags: ['theta', 'planner-v3'], inputSchema,
  outputSchema: { type: 'object', additionalProperties: true }, sideEffectLevel: write ? 'write' : 'read',
  permissionScope: [write ? THETA_PERMISSION_SCOPES.planWrite : THETA_PERMISSION_SCOPES.planRead],
  timeoutPolicy: { timeoutMs: 30_000, onTimeout: 'fail' }, retryPolicy: { maxAttempts: 1 },
  auditPolicy: { enabled: true, includeInput: true, includeOutput: true }, source: 'local',
});

export const thetaPlannerCreateCandidateToolSpec = spec(THETA_TOOL_IDS.plannerCreateCandidate, 'Create plan candidate', 'Choose exactly one model, one random seed and that model\'s executable hyperparameters. The backend inherits dataset bindings and Python automatically produces metrics and visualizations.', draftSchema, true);
export const thetaPlannerSubmitRevisionToolSpec = spec(THETA_TOOL_IDS.plannerSubmitRevision, 'Revise plan candidate', 'Revise only the model, single seed, executable hyperparameters, rationale or evidence. System-managed execution fields are rebuilt automatically.', {
  type: 'object', required: ['candidateRef', 'draft'], properties: { candidateRef: { type: 'string' }, draft: draftSchema }, additionalProperties: false,
}, true);
export const thetaPlannerGetCandidateToolSpec = spec(THETA_TOOL_IDS.plannerGetCandidate, 'Read plan candidate', 'Read the current or named candidate and its bound receipts.', {
  type: 'object', properties: { candidateRef: { type: 'string' } }, additionalProperties: false,
});
export const thetaPlannerCompareCandidatesToolSpec = spec(THETA_TOOL_IDS.plannerCompareCandidates, 'Compare plan candidates', 'Return objective differences among candidate models, runs, resources, evidence and warnings.', {
  type: 'object', required: ['candidateRefs'], properties: { candidateRefs: { type: 'array', minItems: 2, maxItems: 6, uniqueItems: true, items: { type: 'string' } } }, additionalProperties: false,
});
export const thetaPlannerEstimateProtocolToolSpec = spec(THETA_TOOL_IDS.plannerEstimateProtocol, 'Confirm single-run protocol', 'Normalize one random seed into the fixed one-model, one-run protocol.', {
  type: 'object', required: ['seed'], properties: { seed: { type: 'integer', minimum: 0, maximum: 2147483647 } }, additionalProperties: false,
});
export const thetaPlannerSelectEvidenceToolSpec = spec(THETA_TOOL_IDS.plannerSelectEvidence, 'Select legal evidence', 'Bind exact evidence IDs returned by the local RAG index to the current candidate. Any unknown ID rejects the whole call.', {
  type: 'object', required: ['candidateRef', 'evidenceIds'], properties: { candidateRef: { type: 'string' }, evidenceIds: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: { type: 'string' } } }, additionalProperties: false,
}, true);
export const thetaPlannerValidatePreviewToolSpec = spec(THETA_TOOL_IDS.plannerValidatePreview, 'Validate plan candidate', 'Run strict local validation and return structured repairability issues. A valid receipt is required before PlanConfirmation.', {
  type: 'object', required: ['candidateRef'], properties: { candidateRef: { type: 'string' } }, additionalProperties: false,
}, true);

export const thetaPlannerCreateCandidateHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const draft = plannerDecisionDraftSchema.parse(input);
  return createOrReviseCandidate(context, draft);
};

export const thetaPlannerSubmitRevisionHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => {
  const value = record(input);
  const draft = plannerDecisionDraftSchema.parse(value.draft);
  return createOrReviseCandidate(context, draft, String(value.candidateRef));
};

export const thetaPlannerGetCandidateHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => withRuntime(context, async (runtime) => {
  const repository = new ThetaPlannerEventRepository(runtime.eventBridge);
  const candidate = await repository.candidate(context.runId, optionalText(record(input).candidateRef));
  if (!candidate) throw new Error('Plan candidate was not found.');
  return {
    candidate,
    evidenceReceipt: await repository.evidenceReceipt(context.runId, candidate.candidatePlanHash),
    validationReceipt: await repository.validationReceipt(context.runId, candidate.candidatePlanHash),
    planWorkspace: await new ThetaWorkspaceEventRepository(runtime.eventBridge).current(context.runId, 'plan'),
  };
});

export const thetaPlannerCompareCandidatesHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => withRuntime(context, async (runtime) => {
  const refs = record(input).candidateRefs as string[];
  const repository = new ThetaPlannerEventRepository(runtime.eventBridge);
  const candidates = await Promise.all(refs.map(async (ref) => {
    const candidate = await repository.candidate(context.runId, ref);
    if (!candidate) throw new Error(`Candidate not found: ${ref}.`);
    return candidate;
  }));
  return { candidates: candidates.map((candidate) => ({ candidateRef: candidate.candidateRef, modelId: candidate.model.modelId, mode: candidate.model.mode, parameters: candidate.model.parameters, seed: candidate.experimentProtocol.seeds[0], evidenceCount: candidate.evidenceRefs.length, warnings: candidate.warnings, rationale: candidate.rationale })) };
});

export const thetaPlannerEstimateProtocolHandler: ToolHandler<unknown, Record<string, unknown>> = async (input) => {
  const value = record(input);
  const seed = plannerDecisionDraftSchema.shape.seed.parse(value.seed);
  return { seed, seeds: [seed], baselines: [], estimatedTrainingRuns: 1 };
};

export const thetaPlannerSelectEvidenceHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => withRuntime(context, async (runtime) => {
  const value = record(input);
  const candidate = await requireCandidate(runtime, context.runId, String(value.candidateRef));
  const evidenceIds = value.evidenceIds as string[];
  const requested = [...new Set(evidenceIds)].sort();
  const declared = [...new Set(candidate.evidenceRefs)].sort();
  if (requested.length !== declared.length || requested.some((id, index) => id !== declared[index])) {
    throw new Error('Evidence selection must exactly match the candidate evidenceRefs; revise the candidate before changing its citations.');
  }
  const planner = new ThetaPlannerEventRepository(runtime.eventBridge);
  const existing = await planner.evidenceReceipt(context.runId, candidate.candidatePlanHash);
  if (existing && existing.selectedEvidenceIds.length === requested.length && existing.selectedEvidenceIds.every((id, index) => id === requested[index])) {
    return {
      ...existing,
      planWorkspace: await new ThetaWorkspaceEventRepository(runtime.eventBridge).current(context.runId, 'plan'),
      reused: true,
    } as unknown as Record<string, unknown>;
  }
  const exact = await thetaRagGetEvidenceHandler({ evidenceIds }, context) as Record<string, unknown>;
  const evidence = exact.evidence as Array<{ evidenceId: string }>;
  const selectedEvidenceIds = evidence.map((item) => item.evidenceId).sort();
  const bundleHash = evidenceBundleHash({ candidatePlanHash: candidate.candidatePlanHash, researchWorkspaceHash: candidate.researchWorkspaceHash, selectedEvidenceIds });
  const receipt: EvidenceSelectionReceipt = { receiptId: `evidence-selection:${bundleHash.slice(7, 23)}`, runId: context.runId, candidateRef: candidate.candidateRef, candidatePlanHash: candidate.candidatePlanHash, researchWorkspaceHash: candidate.researchWorkspaceHash, selectedEvidenceIds, evidenceBundleHash: bundleHash, createdAt: new Date().toISOString() };
  await planner.recordEvidence({ runId: context.runId, sessionId: context.sessionId ?? `session:${context.runId}`, userId: context.userId ?? 'local_user', receipt });
  const planWorkspace = await updatePlanWorkspace(runtime, context, candidate, { evidenceReceipt: receipt, evidence: evidence as unknown as Array<Record<string, unknown>> });
  return { ...receipt, planWorkspace } as unknown as Record<string, unknown>;
});

export const thetaPlannerValidatePreviewHandler: ToolHandler<unknown, Record<string, unknown>> = async (input, context) => withRuntime(context, async (runtime) => {
  const candidate = await requireCandidate(runtime, context.runId, String(record(input).candidateRef));
  const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
  const dataset = await workspaces.current(context.runId, 'dataset');
  const research = await workspaces.current(context.runId, 'research');
  if (!dataset || dataset.workspaceType !== 'dataset' || !research || research.workspaceType !== 'research') throw new Error('Current Dataset/Research Workspace was not found.');
  const repository = new ThetaPlannerEventRepository(runtime.eventBridge);
  const evidenceReceipt = await repository.evidenceReceipt(context.runId, candidate.candidatePlanHash);
  const existing = await repository.validationReceipt(context.runId, candidate.candidatePlanHash);
  if (existing && existing.evidenceBundleHash === evidenceReceipt?.evidenceBundleHash) {
    return {
      ...existing,
      planWorkspace: await workspaces.current(context.runId, 'plan'),
      completion: planCompletionProgress({ candidate, evidenceReceipt, validationReceipt: existing }),
      reused: true,
    } as unknown as Record<string, unknown>;
  }
  const runtimeReadiness = await thetaRuntimeCheckOfflineReadinessHandler({ modelId: candidate.model.modelId }, context) as { ready: boolean; missing?: string[] };
  const issues = validateCandidatePlan({ candidate, dataset, research, evidenceReceipt, runtimeReadiness });
  const material = { receiptId: `validation:${randomUUID()}`, runId: context.runId, candidateRef: candidate.candidateRef, candidatePlanHash: candidate.candidatePlanHash, evidenceBundleHash: evidenceReceipt?.evidenceBundleHash ?? hashCanonicalJson([]), valid: !issues.some((issue) => issue.severity === 'blocking'), issues };
  const receipt: PlanValidationReceipt = { ...material, validationReceiptHash: validationReceiptHash(material), createdAt: new Date().toISOString() };
  await repository.recordValidation({ runId: context.runId, sessionId: context.sessionId ?? `session:${context.runId}`, userId: context.userId ?? 'local_user', receipt });
  const planWorkspace = await updatePlanWorkspace(runtime, context, candidate, { validationReceipt: receipt });
  return { ...receipt, planWorkspace, runtimeReadiness, completion: planCompletionProgress({ candidate, evidenceReceipt, validationReceipt: receipt }) } as unknown as Record<string, unknown>;
});

const createOrReviseCandidate = async (context: ToolCallContext, decision: PlannerDecisionDraft, supersedesCandidateRef?: string): Promise<Record<string, unknown>> => withRuntime(context, async (runtime) => {
  const registeredDatasetRef = typeof context.metadata?.datasetRef === 'string' ? context.metadata.datasetRef : undefined;
  if (registeredDatasetRef && decision.datasetRef !== registeredDatasetRef) {
    throw new Error(`Candidate datasetRef must match the registered Run datasetRef: ${registeredDatasetRef}.`);
  }
  const workspaces = new ThetaWorkspaceEventRepository(runtime.eventBridge);
  const dataset = await workspaces.current(context.runId, 'dataset');
  const research = await workspaces.current(context.runId, 'research');
  if (!dataset || dataset.workspaceType !== 'dataset' || !research || research.workspaceType !== 'research') throw new Error('Current Dataset/Research Workspace was not found.');
  const normalizedDraft = withExecutableDefaults(hydratePlannerDecision(decision, dataset));
  const repository = new ThetaPlannerEventRepository(runtime.eventBridge);
  const superseded = supersedesCandidateRef ? await repository.candidate(context.runId, supersedesCandidateRef) : null;
  if (supersedesCandidateRef && !superseded) throw new Error(`Candidate to revise was not found: ${supersedesCandidateRef}.`);
  const latest = await repository.candidate(context.runId);
  if (
    latest &&
    latest.datasetWorkspaceHash === dataset.workspaceHash &&
    latest.researchWorkspaceHash === research.workspaceHash &&
    hashCanonicalJson(candidateDraft(latest)) === hashCanonicalJson(normalizedDraft)
  ) {
    return {
      candidate: latest,
      planWorkspace: await workspaces.current(context.runId, 'plan'),
      invalidatedPriorReceipts: false,
      reused: true,
      instruction: 'An identical hash-bound candidate already exists. Do not create it again; evaluate or finish it.',
    };
  }
  const candidateId = superseded?.candidateId ?? `candidate:${randomUUID()}`;
  const revision = (superseded?.revision ?? 0) + 1;
  const hashable = { schemaVersion: '1.0.0' as const, candidateId, revision, runId: context.runId, datasetHash: dataset.datasetHash, datasetWorkspaceHash: dataset.workspaceHash, researchWorkspaceHash: research.workspaceHash, toolContractSnapshotHash: PLANNER_TOOL_CONTRACT_SNAPSHOT_HASH, ...normalizedDraft, ...(supersedesCandidateRef ? { supersedesCandidateRef } : {}) };
  const planHash = candidatePlanHash(hashable);
  const candidate: CandidatePlan = { ...hashable, candidateRef: `${candidateId}:r${revision}`, candidatePlanHash: planHash, createdAt: new Date().toISOString() };
  await repository.recordCandidate({ runId: context.runId, sessionId: context.sessionId ?? `session:${context.runId}`, userId: context.userId ?? 'local_user', candidate });
  const planWorkspace = await updatePlanWorkspace(runtime, context, candidate, {});
  return { candidate, planWorkspace, invalidatedPriorReceipts: Boolean(superseded) };
});

const updatePlanWorkspace = async (
  runtime: Awaited<ReturnType<typeof createThetaRuntimeComposition>>,
  context: ToolCallContext,
  candidate: CandidatePlan,
  options: { evidenceReceipt?: EvidenceSelectionReceipt; validationReceipt?: PlanValidationReceipt; evidence?: Array<Record<string, unknown>> },
): Promise<PlanWorkspace> => {
  const repository = new ThetaWorkspaceEventRepository(runtime.eventBridge);
  const current = await repository.current(context.runId, 'plan');
  const base = current?.workspaceType === 'plan' && current.researchWorkspaceHash === candidate.researchWorkspaceHash
    ? current
    : emptyPlanWorkspace(context.runId, candidate.datasetHash, candidate.researchWorkspaceHash);
  const sameCandidate = base.activeCandidateRef === candidate.candidateRef;
  const sourceRefs: WorkspaceSourceRef[] = sameCandidate ? [...base.sourceRefs] : [];
  addSource(sourceRefs, { id: candidate.candidateRef, kind: 'agent_decision', hash: candidate.candidatePlanHash });
  for (const item of options.evidence ?? []) addSource(sourceRefs, { id: String(item.evidenceId), kind: 'artifact', hash: String(item.contentHash) });
  if (options.validationReceipt) addSource(sourceRefs, { id: options.validationReceipt.receiptId, kind: 'tool_observation', hash: options.validationReceipt.validationReceiptHash });
  const revised = await repository.revise({
    runId: context.runId, sessionId: context.sessionId, userId: context.userId ?? 'local_user', expectedRevision: current?.revision ?? 0,
    draft: {
      ...emptyPlanWorkspace(context.runId, candidate.datasetHash, candidate.researchWorkspaceHash),
      candidateRefs: unique([...base.candidateRefs, candidate.candidateRef]),
      activeCandidateRef: candidate.candidateRef,
      validationReceiptRefs: options.validationReceipt ? [options.validationReceipt.receiptId] : sameCandidate ? base.validationReceiptRefs : [],
      evidenceRefs: options.evidenceReceipt ? options.evidenceReceipt.selectedEvidenceIds : sameCandidate ? base.evidenceRefs : [],
      sourceRefs,
    },
    reason: `PlanWorkspace updated for ${candidate.candidateRef}.`, invalidates: ['approval', 'dry_run', 'training_approval'],
  });
  if (revised.workspaceType !== 'plan') throw new Error('PlanWorkspace revision returned the wrong type.');
  return revised;
};

const requireCandidate = async (runtime: Awaited<ReturnType<typeof createThetaRuntimeComposition>>, runId: string, candidateRef: string): Promise<CandidatePlan> => {
  const candidate = await new ThetaPlannerEventRepository(runtime.eventBridge).candidate(runId, candidateRef);
  if (!candidate) throw new Error(`Candidate was not found: ${candidateRef}.`);
  return candidate;
};

const withRuntime = async <T>(context: ToolCallContext, operation: (runtime: Awaited<ReturnType<typeof createThetaRuntimeComposition>>) => Promise<T>): Promise<T> => {
  const runtime = await createThetaRuntimeComposition(runtimeDbFrom(context));
  try { return await operation(runtime); } finally { await runtime.close(); }
};
const runtimeDbFrom = (context: ToolCallContext): string => typeof context.metadata?.thetaRuntimeDb === 'string' ? context.metadata.thetaRuntimeDb : defaultThetaV6RuntimeDb();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const optionalText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const addSource = (sources: WorkspaceSourceRef[], source: WorkspaceSourceRef): void => { if (!sources.some((item) => item.id === source.id)) sources.push(source); };

const withExecutableDefaults = (draft: CandidatePlanDraft): CandidatePlanDraft => {
  const card = new CapabilityRegistry().require(draft.model.modelId);
  const parameters = { ...draft.model.parameters };
  for (const parameter of card.parameters) {
    if (parameter.exposure !== 'agent_compiled' || !parameter.usedByTraining || parameters[parameter.parameterId] !== undefined) continue;
    const value = parameter.defaultValue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) parameters[parameter.parameterId] = value as string | number | boolean | null;
  }
  return candidatePlanDraftSchema.parse({ ...draft, model: { ...draft.model, parameters } });
};

const hydratePlannerDecision = (
  decision: PlannerDecisionDraft,
  dataset: DatasetWorkspace,
): CandidatePlanDraft => {
  const card = new CapabilityRegistry().require(decision.model.modelId);
  const inherited = inheritedColumns(dataset.columnRoles);
  const textColumns = inherited.textColumns;
  if (textColumns.length === 0) throw new Error('DatasetWorkspace has no confirmed primary text column. Return to dataset understanding instead of inventing one in Planner.');
  const timeColumn = card.capabilities.temporalTopics ? inherited.timeColumn : null;
  const trainingCovariates = card.capabilities.metadataEffects ? inherited.trainingCovariates : [];
  const displayGroups = unique([
    ...inherited.displayGroups,
    ...(timeColumn === null && inherited.timeColumn ? [inherited.timeColumn] : []),
    ...(card.capabilities.metadataEffects ? [] : inherited.trainingCovariates),
  ]).filter((column) => !textColumns.includes(column) && column !== inherited.idColumn);
  const neural = ['dynamic_neural', 'embedding_clustering', 'contextual_neural', 'llm_embedding_neural'].includes(card.implementation.family);
  return candidatePlanDraftSchema.parse({
    datasetRef: decision.datasetRef,
    model: decision.model,
    columns: { textColumns, timeColumn, trainingCovariates, displayGroups, idColumn: inherited.idColumn },
    preprocessing: {},
    experimentProtocol: { seeds: [decision.seed], baselines: [], estimatedTrainingRuns: 1 },
    // Compatibility fields for Canonical Plan V3 and the Python Bridge. These
    // are system declarations, not Planner decisions; Python computes its
    // complete metric and visualization suite automatically.
    evaluation: {
      metrics: ['python_pipeline_auto'],
      stabilityChecks: [],
      interpretationProtocol: ['python_pipeline_auto'],
    },
    visualizations: [],
    resources: {
      cpuLevel: neural ? 'high' : 'low',
      memoryLevel: neural ? 'high' : 'low',
      timeLevel: neural ? 'hours' : 'minutes',
      offlineRequired: true,
    },
    intentBindings: decision.intentBindings,
    evidenceRefs: decision.evidenceRefs,
    assumptions: decision.assumptions,
    warnings: decision.warnings,
    rationale: decision.rationale,
  });
};

const inheritedColumns = (roles: Array<{ column: string; proposedRole: string }>): {
  textColumns: string[];
  timeColumn: string | null;
  trainingCovariates: string[];
  displayGroups: string[];
  idColumn: string | null;
} => {
  const normalized = roles.map((item) => ({ ...item, role: item.proposedRole.trim().toLowerCase() }));
  const textColumns = normalized.filter((item) => item.role === 'text' || item.role.includes('primary_text')).map((item) => item.column);
  const timeColumn = normalized.find((item) => item.role === 'time' || item.role.includes('time_column'))?.column ?? null;
  const idColumn = normalized.find((item) => item.role === 'id' || item.role.includes('identifier'))?.column ?? null;
  const trainingCovariates = normalized
    .filter((item) => item.role.includes('covariate') && !item.role.includes('candidate') && !item.role.includes('display'))
    .map((item) => item.column);
  const displayGroups = normalized
    .filter((item) => item.role.includes('display') || item.role === 'metadata' || item.role === 'grouping')
    .map((item) => item.column);
  return { textColumns: unique(textColumns), timeColumn, trainingCovariates: unique(trainingCovariates), displayGroups: unique(displayGroups), idColumn };
};

const candidateDraft = (candidate: CandidatePlan): CandidatePlanDraft => ({
  datasetRef: candidate.datasetRef,
  model: candidate.model,
  columns: candidate.columns,
  preprocessing: candidate.preprocessing,
  experimentProtocol: candidate.experimentProtocol,
  evaluation: candidate.evaluation,
  visualizations: candidate.visualizations,
  resources: candidate.resources,
  intentBindings: candidate.intentBindings,
  evidenceRefs: candidate.evidenceRefs,
  assumptions: candidate.assumptions,
  warnings: candidate.warnings,
  rationale: candidate.rationale,
});
