import type { CandidatePlan, EvidenceSelectionReceipt, PlanValidationReceipt } from './contracts.js';

export interface PlanCompletionGates {
  candidateCreated: boolean;
  intentAlignmentValid: boolean;
  evidenceBound: boolean;
  structuralValidationValid: boolean;
  runtimeValidationValid: boolean;
  presentationReady: boolean;
}

export interface PlanProgressSnapshot {
  phase: 'PlanDesign';
  completedGates: number;
  totalGates: number;
  percent: number;
  gates: PlanCompletionGates;
  unresolvedIssues: Array<{ code: string; target: string; message: string }>;
}

export const planCompletionProgress = (input: {
  candidate: CandidatePlan | null;
  evidenceReceipt: EvidenceSelectionReceipt | null;
  validationReceipt: PlanValidationReceipt | null;
}): PlanProgressSnapshot => {
  const { candidate, evidenceReceipt, validationReceipt } = input;
  const issues = validationReceipt?.issues ?? [];
  const alignmentBlocking = issues.some((issue) => issue.severity === 'blocking' && (
    issue.code.startsWith('RESEARCH_INTENT_') ||
    issue.code === 'BLOCKING_RESEARCH_INTENT_EXCLUDED'
  ));
  const runtimeBlocking = issues.some((issue) => issue.severity === 'blocking' && issue.code.startsWith('RUNTIME_'));
  const structuralBlocking = issues.some((issue) => issue.severity === 'blocking' && !(
    issue.code.startsWith('RESEARCH_INTENT_') ||
    issue.code === 'BLOCKING_RESEARCH_INTENT_EXCLUDED' ||
    issue.code.startsWith('RUNTIME_')
  ));
  const evidenceBound = Boolean(candidate && evidenceReceipt && evidenceReceipt.candidatePlanHash === candidate.candidatePlanHash);
  const gates: PlanCompletionGates = {
    candidateCreated: Boolean(candidate),
    intentAlignmentValid: Boolean(validationReceipt && !alignmentBlocking),
    evidenceBound,
    structuralValidationValid: Boolean(validationReceipt && !structuralBlocking),
    runtimeValidationValid: Boolean(validationReceipt && !runtimeBlocking),
    presentationReady: Boolean(validationReceipt?.valid && evidenceBound),
  };
  const values = Object.values(gates);
  const completedGates = values.filter(Boolean).length;
  return {
    phase: 'PlanDesign',
    completedGates,
    totalGates: values.length,
    percent: Math.round((completedGates / values.length) * 100),
    gates,
    unresolvedIssues: issues
      .filter((issue) => issue.severity === 'blocking')
      .map(({ code, target, message }) => ({ code, target, message })),
  };
};

export const planReady = (progress: PlanProgressSnapshot): boolean =>
  Object.values(progress.gates).every(Boolean);
