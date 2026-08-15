import { CapabilityRegistry } from '../capabilities/registry.js';
import type { DatasetWorkspace, ResearchWorkspace } from '../workspaces/contracts.js';
import type { CandidatePlan, EvidenceSelectionReceipt, ValidationIssue } from './contracts.js';
import { validateIntentAlignment } from './alignment-validator.js';
import { ModelExecutionRegistry } from '../execution/model-execution-registry.js';

export const validateCandidatePlan = (input: {
  candidate: CandidatePlan;
  dataset: DatasetWorkspace;
  research: ResearchWorkspace;
  evidenceReceipt: EvidenceSelectionReceipt | null;
  runtimeReadiness?: { ready: boolean; missing?: string[] };
}): ValidationIssue[] => {
  const { candidate, dataset, research, evidenceReceipt, runtimeReadiness } = input;
  const issues: ValidationIssue[] = [];
  const blocking = (
    code: string,
    target: string,
    message: string,
    repairability: ValidationIssue['repairability'],
    allowedRepairs: string[],
  ): void => { issues.push({ code, severity: 'blocking', target, message, evidenceRefs: [], repairability, allowedRepairs }); };
  if (candidate.datasetHash !== dataset.datasetHash || candidate.datasetWorkspaceHash !== dataset.workspaceHash) {
    blocking('STALE_DATASET_BINDING', 'bindings.dataset', 'Candidate is not bound to the current DatasetWorkspace.', 'agent_can_repair', ['rebuild_candidate_from_current_workspace']);
  }
  if (candidate.researchWorkspaceHash !== research.workspaceHash) {
    blocking('STALE_RESEARCH_BINDING', 'bindings.research', 'Candidate is not bound to the current ResearchWorkspace.', 'agent_can_repair', ['rebuild_candidate_from_current_workspace']);
  }
  const columns = new Set(dataset.columnRoles.map((role) => role.column));
  for (const column of [
    ...candidate.columns.textColumns,
    ...candidate.columns.trainingCovariates,
    ...candidate.columns.displayGroups,
    candidate.columns.timeColumn,
    candidate.columns.idColumn,
  ].filter((value): value is string => Boolean(value))) {
    if (!columns.has(column)) blocking('UNKNOWN_COLUMN', `columns.${column}`, `Column '${column}' is not present in the verified DatasetWorkspace.`, 'agent_can_repair', ['remove_column', 'read_dataset_workspace']);
  }
  const registry = new CapabilityRegistry();
  let card;
  try { card = registry.require(candidate.model.modelId); }
  catch {
    blocking('UNKNOWN_MODEL', 'model.modelId', `Model '${candidate.model.modelId}' has no audited Capability Card.`, 'agent_can_repair', ['list_available_models', 'choose_audited_model']);
  }
  if (card) {
    if (!registry.plannerEligibleModelIds().includes(card.modelId)) {
      blocking('MODEL_NOT_PLANNER_ELIGIBLE', 'model.modelId', `Model '${card.modelId}' is not eligible for planning: ${card.planner.reason}`, 'agent_can_repair', ['choose_eligible_model']);
    }
    if (candidate.columns.trainingCovariates.length > 0 && !card.capabilities.metadataEffects) {
      blocking('MODEL_COVARIATE_UNSUPPORTED', 'columns.trainingCovariates', `Model '${card.modelId}' cannot train metadata effects.`, 'needs_user_decision', ['move_columns_to_display_groups', 'choose_metadata_model', 'return_to_research_dialogue']);
    }
    if (candidate.model.mode.toLowerCase().includes('temporal') && !card.capabilities.temporalTopics) {
      blocking('MODEL_TEMPORAL_UNSUPPORTED', 'model.mode', `Model '${card.modelId}' cannot train temporal topics.`, 'agent_can_repair', ['choose_temporal_model', 'change_to_static_mode']);
    }
    const parameters = new Map(card.parameters.map((parameter) => [parameter.parameterId, parameter]));
    for (const [name, value] of Object.entries(candidate.model.parameters)) {
      const contract = parameters.get(name);
      if (!contract || contract.exposure !== 'agent_compiled') {
        blocking('PARAMETER_NOT_EXECUTABLE', `model.parameters.${name}`, `Parameter '${name}' is not exposed through the governed Agent command compiler.`, 'agent_can_repair', ['remove_parameter', 'read_parameter_contract']);
        continue;
      }
      const validType = contract.valueType === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : contract.valueType === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === contract.valueType;
      if (!validType) {
        blocking('PARAMETER_TYPE_INVALID', `model.parameters.${name}`, `${name} must be a ${contract.valueType}.`, 'agent_can_repair', ['read_parameter_contract', 'set_parameter_to_legal_type']);
        continue;
      }
      if (typeof value === 'number' && contract.minimum != null && value < contract.minimum) blocking('PARAMETER_BELOW_MINIMUM', `model.parameters.${name}`, `${name}=${value} is below ${contract.minimum}.`, 'agent_can_repair', ['clamp_parameter']);
      if (typeof value === 'number' && contract.maximum != null && value > contract.maximum) blocking('PARAMETER_ABOVE_MAXIMUM', `model.parameters.${name}`, `${name}=${value} exceeds ${contract.maximum}.`, 'agent_can_repair', ['clamp_parameter']);
      if (contract.choices.length > 0 && !contract.choices.includes(value)) blocking('PARAMETER_CHOICE_INVALID', `model.parameters.${name}`, `${name} is not one of the legal choices.`, 'agent_can_repair', ['choose_legal_value']);
    }
    if (candidate.resources.offlineRequired && card.capabilities.offlineExecution === 'unsupported') {
      blocking('OFFLINE_EXECUTION_UNSUPPORTED', 'resources.offlineRequired', `Model '${card.modelId}' does not support offline execution.`, 'agent_can_repair', ['choose_offline_model', 'change_resource_constraint']);
    }
    if (card.maturity === 'experimental') issues.push({ code: 'EXPERIMENTAL_MODEL', severity: 'warning', target: 'model.modelId', message: `Model '${card.modelId}' is experimental and this must be disclosed.`, evidenceRefs: candidate.evidenceRefs, repairability: 'agent_can_repair', allowedRepairs: ['retain_with_warning', 'choose_production_model'] });
    try {
      const execution = new ModelExecutionRegistry(registry);
      execution.compilePrimary(candidate);
      for (const baseline of candidate.experimentProtocol.baselines) execution.compileBaseline(baseline);
    } catch (error) {
      blocking(
        'MODEL_EXECUTION_CONTRACT_INVALID',
        'model',
        error instanceof Error ? error.message : String(error),
        'agent_can_repair',
        ['read_model_capability', 'read_parameter_contract', 'revise_model_mode_or_parameters'],
      );
    }
  }
  const expectedRuns = candidate.experimentProtocol.seeds.length * (1 + candidate.experimentProtocol.baselines.length);
  if (candidate.experimentProtocol.seeds.length !== 1) {
    blocking('SINGLE_SEED_REQUIRED', 'experimentProtocol.seeds', 'Planner must choose exactly one random seed.', 'agent_can_repair', ['choose_one_seed']);
  }
  if (candidate.experimentProtocol.baselines.length !== 0) {
    blocking('BASELINES_NOT_PLANNER_MANAGED', 'experimentProtocol.baselines', 'Planner must choose one primary model only; Python owns automatic post-training outputs and no baseline is planned here.', 'agent_can_repair', ['remove_baselines']);
  }
  if (candidate.experimentProtocol.estimatedTrainingRuns !== expectedRuns) {
    blocking('TRAINING_RUN_COUNT_MISMATCH', 'experimentProtocol.estimatedTrainingRuns', `Expected ${expectedRuns} runs from seeds and baselines.`, 'agent_can_repair', ['set_estimated_runs_to_exact_value']);
  }
  if (!evidenceReceipt) {
    blocking('EVIDENCE_SELECTION_REQUIRED', 'evidenceRefs', 'Candidate evidence must be bound by theta.planner.select_evidence.', 'needs_more_observation', ['search_rag', 'select_evidence']);
  } else {
    if (evidenceReceipt.candidatePlanHash !== candidate.candidatePlanHash || evidenceReceipt.researchWorkspaceHash !== research.workspaceHash) {
      blocking('STALE_EVIDENCE_RECEIPT', 'evidenceRefs', 'Evidence receipt is bound to a stale candidate or research workspace.', 'agent_can_repair', ['select_evidence_again']);
    }
    const selected = new Set(evidenceReceipt.selectedEvidenceIds);
    const outside = candidate.evidenceRefs.filter((id) => !selected.has(id));
    if (outside.length) blocking('EVIDENCE_ID_OUTSIDE_RECEIPT', 'evidenceRefs', `Evidence IDs were not selected by the governed tool: ${outside.join(', ')}.`, 'agent_can_repair', ['remove_unselected_evidence', 'select_evidence_again']);
    const unused = evidenceReceipt.selectedEvidenceIds.filter((id) => !candidate.evidenceRefs.includes(id));
    if (unused.length) blocking('EVIDENCE_RECEIPT_MISMATCH', 'evidenceRefs', `The receipt contains evidence not declared by the candidate: ${unused.join(', ')}.`, 'agent_can_repair', ['revise_candidate_evidence', 'select_evidence_again']);
  }
  if (research.questions.some((question) => question.status === 'open' && question.blocking)) {
    blocking('RESEARCH_DECISION_STILL_OPEN', 'researchWorkspace', 'A blocking research question remains open.', 'needs_user_decision', ['return_to_research_dialogue']);
  }
  if (candidate.resources.offlineRequired && runtimeReadiness && !runtimeReadiness.ready) {
    blocking('RUNTIME_OFFLINE_NOT_READY', 'resources.offlineRequired', `The active environment is not ready for offline ${candidate.model.modelId} execution${runtimeReadiness.missing?.length ? `; missing: ${runtimeReadiness.missing.join(', ')}` : ''}.`, 'agent_can_repair', ['choose_ready_model', 'install_missing_dependency', 'change_offline_constraint']);
  }
  issues.push(...validateIntentAlignment(candidate, research));
  return dedupeIssues(issues);
};

const dedupeIssues = (issues: ValidationIssue[]): ValidationIssue[] => [...new Map(issues.map((issue) => [`${issue.code}:${issue.target}`, issue])).values()];
