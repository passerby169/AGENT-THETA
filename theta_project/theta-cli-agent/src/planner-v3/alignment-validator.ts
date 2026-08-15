import { hashCanonicalJson } from '@hypha/core';
import type { ResearchWorkspace } from '../workspaces/contracts.js';
import type { CandidatePlan, IntentPlanBinding, ValidationIssue } from './contracts.js';

export interface ResearchAlignmentItem {
  id: string;
  kind: 'statement' | 'decision' | 'preference' | 'boundary' | 'assumption';
  text: string;
  importance: 'blocking' | 'important' | 'optional';
}

export const GOVERNED_PLAN_TARGET_PATHS = [
  'model.modelId',
  'model.mode',
  'model.parameters',
  'experimentProtocol.seeds',
] as const;

const PLAN_TARGET_PATHS = new Set<string>(GOVERNED_PLAN_TARGET_PATHS);

export const researchAlignmentItems = (research: ResearchWorkspace): ResearchAlignmentItem[] => [
  ...research.statements.map((item) => ({
    id: item.id,
    kind: 'statement' as const,
    text: item.statement,
    importance: item.importance,
  })),
  ...research.decisions
    .filter((item) => item.status === 'accepted')
    .map((item) => ({ id: item.id, kind: 'decision' as const, text: item.decision, importance: 'important' as const })),
  ...research.preferences.map((item) => ({
    id: item.id,
    kind: 'preference' as const,
    text: item.preference,
    importance: 'important' as const,
  })),
  ...research.boundaries.map((item) => ({
    id: item.id,
    kind: 'boundary' as const,
    text: item.boundary,
    importance: 'blocking' as const,
  })),
  ...research.assumptions
    .filter((item) => item.status === 'accepted')
    .map((item) => ({ id: item.id, kind: 'assumption' as const, text: item.statement, importance: 'important' as const })),
];

export const validateIntentAlignment = (
  candidate: CandidatePlan,
  research: ResearchWorkspace,
): ValidationIssue[] => {
  const issues: ValidationIssue[] = [];
  const items = researchAlignmentItems(research);
  const known = new Map(items.map((item) => [item.id, item]));
  const bindings = new Map<string, IntentPlanBinding[]>();
  for (const binding of candidate.intentBindings) {
    const values = bindings.get(binding.researchItemId) ?? [];
    values.push(binding);
    bindings.set(binding.researchItemId, values);
    if (!known.has(binding.researchItemId)) {
      issues.push(issue('UNKNOWN_RESEARCH_ITEM_BINDING', 'blocking', `intentBindings.${binding.researchItemId}`, `Binding refers to an item that is not in the current ResearchWorkspace: ${binding.researchItemId}.`, 'agent_can_repair', ['read_alignment_context', 'remove_unknown_binding']));
    }
  }

  for (const item of items) {
    if (item.importance === 'optional') continue;
    const matches = bindings.get(item.id) ?? [];
    if (matches.length === 0) {
      issues.push(issue('RESEARCH_INTENT_UNCOVERED', 'blocking', `intentBindings.${item.id}`, `The ${item.kind} '${item.text}' is not traceably implemented or explicitly excluded by the candidate.`, 'agent_can_repair', ['bind_research_item', 'revise_candidate']));
      continue;
    }
    if (matches.length > 1) {
      issues.push(issue('RESEARCH_INTENT_DUPLICATE_BINDING', 'blocking', `intentBindings.${item.id}`, `Research item ${item.id} has multiple dispositions.`, 'agent_can_repair', ['retain_one_binding']));
      continue;
    }
    validateBinding(candidate, item, matches[0], issues);
  }
  return issues;
};

const validateBinding = (
  candidate: CandidatePlan,
  item: ResearchAlignmentItem,
  binding: IntentPlanBinding,
  issues: ValidationIssue[],
): void => {
  if (binding.disposition === 'needs_user_decision') {
    issues.push(issue('RESEARCH_INTENT_NEEDS_USER_DECISION', 'blocking', `intentBindings.${item.id}`, `Research item '${item.text}' still needs a user decision.`, 'needs_user_decision', ['return_to_research_dialogue']));
    return;
  }
  if (binding.disposition === 'intentionally_excluded') {
    if (item.importance === 'blocking') {
      issues.push(issue(
        'BLOCKING_RESEARCH_INTENT_EXCLUDED',
        'blocking',
        `intentBindings.${item.id}`,
        `Blocking research boundary '${item.text}' is already an instruction from the ResearchWorkspace and must be implemented as an exact plan constraint rather than excluded.`,
        'agent_can_repair',
        ['bind_boundary_to_exact_plan_target', 'revise_candidate'],
      ));
    }
    return;
  }
  if (binding.disposition === 'inherited_workspace') {
    if (binding.planTargets.length > 0) {
      issues.push(issue('INHERITED_WORKSPACE_TARGET_FORBIDDEN', 'blocking', `intentBindings.${item.id}`, `Inherited dataset fact '${item.text}' must not be re-planned. Remove its plan targets.`, 'agent_can_repair', ['remove_plan_targets', 'retain_inherited_workspace_disposition']));
    }
    return;
  }
  if (binding.disposition === 'pipeline_managed' || binding.disposition === 'post_training_only') {
    if (binding.planTargets.length > 0) {
      issues.push(issue('PIPELINE_MANAGED_TARGET_FORBIDDEN', 'blocking', `intentBindings.${item.id}`, `Automatic output '${item.text}' is owned by the Python pipeline and must not be represented as a Planner target.`, 'agent_can_repair', ['remove_plan_targets', 'use_pipeline_managed_disposition']));
    }
    return;
  }
  if (binding.planTargets.length === 0) {
    issues.push(issue('RESEARCH_INTENT_TARGET_REQUIRED', 'blocking', `intentBindings.${item.id}`, `Implemented research item '${item.text}' has no exact CandidatePlan target.`, 'agent_can_repair', ['add_exact_plan_target']));
    return;
  }
  for (const target of binding.planTargets) {
    if (!PLAN_TARGET_PATHS.has(target.path) && !target.path.startsWith('model.parameters.')) {
      issues.push(issue('RESEARCH_INTENT_TARGET_PATH_INVALID', 'blocking', `intentBindings.${item.id}.${target.path}`, `Plan target path is not governed: ${target.path}.`, 'agent_can_repair', ['use_governed_plan_path']));
      continue;
    }
    const actual = readPath(candidate as unknown as Record<string, unknown>, target.path);
    const matches = actual !== undefined && hashCanonicalJson(actual) === hashCanonicalJson(target.value);
    if (!matches) {
      issues.push(issue('RESEARCH_INTENT_TARGET_MISMATCH', 'blocking', `intentBindings.${item.id}.${target.path}`, `Research item '${item.text}' claims ${target.path}=${JSON.stringify(target.value)}, but the candidate contains ${JSON.stringify(actual ?? null)}.`, 'agent_can_repair', ['revise_candidate_value', 'correct_intent_binding']));
    }
  }
};

const readPath = (root: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, root);

const issue = (
  code: string,
  severity: ValidationIssue['severity'],
  target: string,
  message: string,
  repairability: ValidationIssue['repairability'],
  allowedRepairs: string[],
): ValidationIssue => ({ code, severity, target, message, evidenceRefs: [], repairability, allowedRepairs });
