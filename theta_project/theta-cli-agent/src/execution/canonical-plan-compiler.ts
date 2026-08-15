import type { DatasetRecord } from '../storage/dataset-registry.js';
import type {
  CandidatePlan,
  EvidenceSelectionReceipt,
  PlanApprovalReceipt,
  PlanValidationReceipt,
} from '../planner-v3/contracts.js';
import {
  candidatePlanHash,
  evidenceBundleHash,
  planApprovalReceiptHash,
  validationReceiptHash,
} from '../planner-v3/contracts.js';
import type { DatasetWorkspace, ResearchWorkspace } from '../workspaces/contracts.js';
import {
  canonicalPlanSchema,
  type CanonicalPlan,
  type CanonicalPlanIssue,
} from './contracts.js';
import { ModelExecutionRegistry } from './model-execution-registry.js';

export interface CompileCanonicalPlanInput {
  candidate: CandidatePlan;
  datasetWorkspace: DatasetWorkspace;
  researchWorkspace: ResearchWorkspace;
  datasetRecord: DatasetRecord;
  evidenceReceipt: EvidenceSelectionReceipt;
  validationReceipt: PlanValidationReceipt;
  approvalReceipt: PlanApprovalReceipt;
}

export class CanonicalPlanCompilationError extends Error {
  constructor(readonly issues: CanonicalPlanIssue[]) {
    super(issues.map((issue) => `${issue.code} (${issue.target}): ${issue.message}`).join('\n'));
    this.name = 'CanonicalPlanCompilationError';
  }
}

export const compileCanonicalPlan = (
  input: CompileCanonicalPlanInput,
  registry = new ModelExecutionRegistry(),
): CanonicalPlan => {
  const bindingIssues = validateBindings(input);
  if (bindingIssues.length > 0) throw new CanonicalPlanCompilationError(bindingIssues);
  const { candidate } = input;
  let primary;
  try {
    primary = registry.compilePrimary(candidate);
  } catch (error) {
    throw new CanonicalPlanCompilationError([{
      code: 'MODEL_EXECUTION_CONTRACT_INVALID',
      target: 'model',
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
  const baselines: [] = [];
  const plan: CanonicalPlan = {
    schemaVersion: '3.0.0',
    runId: candidate.runId,
    datasetId: input.datasetRecord.datasetRef,
    datasetRef: input.datasetRecord.datasetRef,
    datasetSha256: input.datasetRecord.sha256,
    researchIntentSummary: input.researchWorkspace.narrative,
    model: primary,
    columns: {
      textColumns: unique(candidate.columns.textColumns),
      timeColumn: candidate.columns.timeColumn,
      idColumn: candidate.columns.idColumn,
      covariateColumns: unique(candidate.columns.trainingCovariates),
      metadataColumns: unique([
        ...candidate.columns.trainingCovariates,
        ...candidate.columns.displayGroups,
      ]),
      groupingColumns: unique(candidate.columns.displayGroups),
      evaluationLabelColumns: [],
    },
    preprocessing: candidate.preprocessing,
    experimentProtocol: {
      mode: 'quick',
      primarySeeds: [candidate.experimentProtocol.seeds[0]],
      baselines,
      estimatedTrainingRuns: 1,
      rationale: candidate.rationale,
      evidenceRefs: unique(candidate.evidenceRefs),
      confidence: confidenceFor(candidate),
    },
    evaluation: candidate.evaluation,
    visualizations: unique(candidate.visualizations),
    artifactRequirements: [primary.modelId]
      .flatMap((modelId) => registry.require(modelId).artifacts.map((artifact) => ({
        modelId,
        artifactId: artifact.artifactId,
        pathPattern: artifact.pathPattern,
        required: artifact.required,
        description: artifact.description,
      }))),
    resources: {
      device: 'cpu',
      cpuLevel: candidate.resources.cpuLevel,
      memoryLevel: candidate.resources.memoryLevel,
      timeLevel: candidate.resources.timeLevel,
      networkAllowed: !candidate.resources.offlineRequired,
    },
    provenance: {
      candidateRef: candidate.candidateRef,
      candidatePlanHash: candidate.candidatePlanHash,
      datasetWorkspaceHash: candidate.datasetWorkspaceHash,
      researchWorkspaceHash: candidate.researchWorkspaceHash,
      toolContractSnapshotHash: candidate.toolContractSnapshotHash,
      evidenceBundleHash: input.evidenceReceipt.evidenceBundleHash,
      validationReceiptHash: input.validationReceipt.validationReceiptHash,
      planWorkspaceHash: input.approvalReceipt.planWorkspaceHash,
      planApprovalHash: input.approvalReceipt.planApprovalHash,
      approvalPrincipalId: input.approvalReceipt.principalId,
    },
    assumptions: unique(candidate.assumptions),
    warnings: unique(candidate.warnings),
    rationale: candidate.rationale,
  };
  const issues = validateCanonicalPlan(plan, registry);
  if (issues.length > 0) throw new CanonicalPlanCompilationError(issues);
  return canonicalPlanSchema.parse(plan);
};

export const validateCanonicalPlan = (
  plan: CanonicalPlan,
  registry = new ModelExecutionRegistry(),
): CanonicalPlanIssue[] => {
  const issues: CanonicalPlanIssue[] = [];
  const parsed = canonicalPlanSchema.safeParse(plan);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      code: 'CANONICAL_PLAN_SCHEMA_INVALID',
      target: issue.path.join('.'),
      message: issue.message,
    }));
  }
  const columns = parsed.data.columns;
  const knownRoles = [
    ...columns.textColumns,
    ...columns.covariateColumns,
    ...columns.groupingColumns,
    ...columns.evaluationLabelColumns,
    columns.timeColumn,
    columns.idColumn,
  ].filter((value): value is string => value !== null);
  if (new Set(columns.textColumns).size !== columns.textColumns.length) {
    add(issues, 'DUPLICATE_TEXT_COLUMN', 'columns.textColumns', 'Text columns must be unique.');
  }
  if (columns.covariateColumns.some((column) => columns.groupingColumns.includes(column))) {
    add(issues, 'COVARIATE_GROUPING_OVERLAP', 'columns', 'Training covariates and display grouping columns must be distinct.');
  }
  if (columns.textColumns.some((column) => knownRoles.filter((value) => value === column).length > 1)) {
    add(issues, 'TEXT_COLUMN_ROLE_OVERLAP', 'columns.textColumns', 'A text column cannot also be a time, ID, covariate, grouping or evaluation column.');
  }
  validateExecutableModel(parsed.data.model, 'model', parsed.data.columns, registry, issues);
  return issues;
};

const validateBindings = (input: CompileCanonicalPlanInput): CanonicalPlanIssue[] => {
  const { candidate, datasetWorkspace, researchWorkspace, datasetRecord, evidenceReceipt, validationReceipt, approvalReceipt } = input;
  const issues: CanonicalPlanIssue[] = [];
  const requireEqual = (left: unknown, right: unknown, code: string, target: string): void => {
    if (left !== right) add(issues, code, target, `Binding mismatch: '${String(left)}' does not equal '${String(right)}'.`);
  };
  requireEqual(candidate.runId, datasetWorkspace.runId, 'RUN_BINDING_MISMATCH', 'datasetWorkspace.runId');
  requireEqual(candidate.runId, researchWorkspace.runId, 'RUN_BINDING_MISMATCH', 'researchWorkspace.runId');
  requireEqual(candidate.datasetRef, datasetRecord.datasetRef, 'DATASET_REF_MISMATCH', 'datasetRecord.datasetRef');
  requireEqual(candidate.datasetHash, `sha256:${datasetRecord.sha256}`, 'DATASET_HASH_MISMATCH', 'datasetRecord.sha256');
  requireEqual(candidate.datasetHash, datasetWorkspace.datasetHash, 'DATASET_WORKSPACE_HASH_MISMATCH', 'datasetWorkspace.datasetHash');
  requireEqual(candidate.datasetWorkspaceHash, datasetWorkspace.workspaceHash, 'STALE_DATASET_WORKSPACE', 'candidate.datasetWorkspaceHash');
  requireEqual(candidate.researchWorkspaceHash, researchWorkspace.workspaceHash, 'STALE_RESEARCH_WORKSPACE', 'candidate.researchWorkspaceHash');
  requireEqual(evidenceReceipt.candidatePlanHash, candidate.candidatePlanHash, 'STALE_EVIDENCE_RECEIPT', 'evidenceReceipt.candidatePlanHash');
  requireEqual(evidenceReceipt.researchWorkspaceHash, candidate.researchWorkspaceHash, 'STALE_EVIDENCE_RECEIPT', 'evidenceReceipt.researchWorkspaceHash');
  requireEqual(validationReceipt.candidatePlanHash, candidate.candidatePlanHash, 'STALE_VALIDATION_RECEIPT', 'validationReceipt.candidatePlanHash');
  requireEqual(validationReceipt.evidenceBundleHash, evidenceReceipt.evidenceBundleHash, 'VALIDATION_EVIDENCE_MISMATCH', 'validationReceipt.evidenceBundleHash');
  requireEqual(approvalReceipt.runId, candidate.runId, 'APPROVAL_RUN_MISMATCH', 'approvalReceipt.runId');
  requireEqual(approvalReceipt.candidateRef, candidate.candidateRef, 'APPROVAL_CANDIDATE_MISMATCH', 'approvalReceipt.candidateRef');
  requireEqual(approvalReceipt.candidatePlanHash, candidate.candidatePlanHash, 'APPROVAL_CANDIDATE_MISMATCH', 'approvalReceipt.candidatePlanHash');
  requireEqual(approvalReceipt.validationReceiptHash, validationReceipt.validationReceiptHash, 'APPROVAL_VALIDATION_MISMATCH', 'approvalReceipt.validationReceiptHash');
  requireEqual(approvalReceipt.evidenceBundleHash, evidenceReceipt.evidenceBundleHash, 'APPROVAL_EVIDENCE_MISMATCH', 'approvalReceipt.evidenceBundleHash');
  const {
    candidatePlanHash: _candidateHash,
    candidateRef: _candidateRef,
    createdAt: _candidateCreatedAt,
    ...candidateMaterial
  } = candidate;
  requireEqual(candidate.candidatePlanHash, candidatePlanHash(candidateMaterial), 'CANDIDATE_HASH_INVALID', 'candidate.candidatePlanHash');
  requireEqual(evidenceReceipt.evidenceBundleHash, evidenceBundleHash({
    candidatePlanHash: evidenceReceipt.candidatePlanHash,
    researchWorkspaceHash: evidenceReceipt.researchWorkspaceHash,
    selectedEvidenceIds: evidenceReceipt.selectedEvidenceIds,
  }), 'EVIDENCE_HASH_INVALID', 'evidenceReceipt.evidenceBundleHash');
  const { validationReceiptHash: _validationHash, createdAt: _validationCreatedAt, ...validationMaterial } = validationReceipt;
  requireEqual(validationReceipt.validationReceiptHash, validationReceiptHash(validationMaterial), 'VALIDATION_HASH_INVALID', 'validationReceipt.validationReceiptHash');
  const { planApprovalHash: _approvalHash, approvedAt: _approvedAt, ...approvalMaterial } = approvalReceipt;
  requireEqual(approvalReceipt.planApprovalHash, planApprovalReceiptHash(approvalMaterial), 'APPROVAL_HASH_INVALID', 'approvalReceipt.planApprovalHash');
  const knownColumns = new Set(datasetWorkspace.columnRoles.map((role) => role.column));
  for (const column of [
    ...candidate.columns.textColumns,
    ...candidate.columns.trainingCovariates,
    ...candidate.columns.displayGroups,
    candidate.columns.timeColumn,
    candidate.columns.idColumn,
  ].filter((value): value is string => value !== null)) {
    if (!knownColumns.has(column)) add(issues, 'UNKNOWN_DATASET_COLUMN', `columns.${column}`, `Column '${column}' is absent from the verified DatasetWorkspace.`);
  }
  if (!validationReceipt.valid || validationReceipt.issues.some((issue) => issue.severity === 'blocking')) {
    add(issues, 'CANDIDATE_VALIDATION_FAILED', 'validationReceipt', 'Only a valid, non-blocking candidate can be compiled.');
  }
  return issues;
};

const validateExecutableModel = (
  model: CanonicalPlan['model'],
  target: string,
  columns: CanonicalPlan['columns'],
  registry: ModelExecutionRegistry,
  issues: CanonicalPlanIssue[],
): void => {
  let contract;
  try { contract = registry.require(model.modelId); }
  catch (error) {
    add(issues, 'MODEL_NOT_EXECUTABLE', `${target}.modelId`, error instanceof Error ? error.message : String(error));
    return;
  }
  if (contract.requiredColumns.time && !columns.timeColumn) {
    add(issues, 'TIME_COLUMN_REQUIRED', 'columns.timeColumn', `Model '${model.modelId}' requires a verified time column.`);
  }
  if (contract.requiredColumns.covariates && columns.covariateColumns.length === 0) {
    add(issues, 'COVARIATE_REQUIRED', 'columns.covariateColumns', `Model '${model.modelId}' requires at least one training covariate.`);
  }
  if (contract.cpuExecution === 'unsupported') {
    add(issues, 'CPU_EXECUTION_UNSUPPORTED', `${target}.modelId`, `Model '${model.modelId}' cannot run on the local CPU execution target.`);
  }
  if (model.topicCountMode === 'fixed' && model.numTopics === null) {
    add(issues, 'FIXED_TOPIC_COUNT_MISSING', `${target}.numTopics`, 'Fixed topic mode requires numTopics.');
  }
  if (model.topicCountMode === 'auto' && model.numTopics !== null) {
    add(issues, 'AUTO_TOPIC_COUNT_HAS_TARGET', `${target}.numTopics`, 'Auto topic mode must not carry a fixed numTopics value.');
  }
  if (model.modelId === 'hdp' && (model.topicCountMode !== 'auto' || model.maxTopics === null)) {
    add(issues, 'HDP_TOPIC_CONTRACT_INVALID', target, 'HDP requires auto topic mode and maxTopics.');
  }
  if (model.modelId !== 'hdp' && model.maxTopics !== null) {
    add(issues, 'MAX_TOPICS_UNSUPPORTED', `${target}.maxTopics`, 'Only HDP uses maxTopics.');
  }
  const card = registry.capabilities.require(model.modelId);
  const parameterContracts = new Map(
    card.parameters
      .filter((parameter) => parameter.exposure === 'agent_compiled' && parameter.usedByTraining && parameter.planField && !['numTopics', 'maxTopics', 'mode'].includes(parameter.planField))
      .map((parameter) => [parameter.planField as string, parameter]),
  );
  for (const [name, value] of Object.entries(model.parameters)) {
    const parameter = parameterContracts.get(name);
    if (!parameter) {
      add(issues, 'EXECUTION_PARAMETER_UNSUPPORTED', `${target}.parameters.${name}`, `Parameter '${name}' is not part of the governed execution contract for '${model.modelId}'.`);
      continue;
    }
    const validType = value === null
      ? parameter.defaultValue === null
      : parameter.valueType === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : parameter.valueType === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === parameter.valueType;
    if (!validType) add(issues, 'EXECUTION_PARAMETER_TYPE_INVALID', `${target}.parameters.${name}`, `Parameter '${name}' must be a ${parameter.valueType}.`);
    if (typeof value === 'number' && parameter.minimum != null && value < parameter.minimum) add(issues, 'EXECUTION_PARAMETER_BELOW_MINIMUM', `${target}.parameters.${name}`, `Parameter '${name}' must be at least ${parameter.minimum}.`);
    if (typeof value === 'number' && parameter.maximum != null && value > parameter.maximum) add(issues, 'EXECUTION_PARAMETER_ABOVE_MAXIMUM', `${target}.parameters.${name}`, `Parameter '${name}' must be at most ${parameter.maximum}.`);
    if (parameter.choices.length > 0 && !parameter.choices.includes(value)) add(issues, 'EXECUTION_PARAMETER_CHOICE_INVALID', `${target}.parameters.${name}`, `Parameter '${name}' is not one of its governed choices.`);
  }
};

const confidenceFor = (candidate: CandidatePlan): 'low' | 'medium' | 'high' => {
  if (candidate.warnings.length > 0 || candidate.assumptions.length >= 3) return 'low';
  if (candidate.assumptions.length > 0) return 'medium';
  return 'high';
};

const add = (issues: CanonicalPlanIssue[], code: string, target: string, message: string): void => {
  issues.push({ code, target, message });
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
