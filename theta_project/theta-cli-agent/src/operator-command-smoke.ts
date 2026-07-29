import type { ThetaWorkflowService } from './theta-workflow-service.js';
import { ThetaOperatorCommandService } from './operator-command-service.js';
import { THETA_APPROVAL_KEYS } from './theta-domain.js';
import { LANGUAGE_CONTRACT_VERSION } from './language/contracts.js';
import type { LanguageRequest } from './language/contracts.js';

let pendingActionRef: string = THETA_APPROVAL_KEYS.planReview;
let resumeCount = 0;
const workflow = {
  plan: async () => ({
    runId: 'run-001',
    runtimeDb: 'runtime.sqlite',
    source: 'canonical_events' as const,
    pendingActionRef,
    approvalReady: pendingActionRef === THETA_APPROVAL_KEYS.planReview,
  }),
  status: async () => ({
    runId: 'run-001',
    runtimeDb: 'runtime.sqlite',
    status: 'waiting_human' as const,
    pendingActionRef,
    statePath: [],
    eventCount: 1,
    lastEventType: 'fsm.wait.started',
    lastEventAt: '2026-07-29T00:00:00.000Z',
  }),
  resume: async () => {
    resumeCount += 1;
    return {
      runId: 'run-001',
      runtimeDb: 'runtime.sqlite',
      disposition: 'waiting' as const,
      status: 'waiting_human' as const,
      statePath: [],
    };
  },
  evidence: async () => ({
    runId: 'run-001',
    runtimeDb: 'runtime.sqlite',
    orchestrationEvents: [],
    toolEvents: [],
  }),
} as unknown as Pick<
  ThetaWorkflowService,
  'plan' | 'status' | 'resume' | 'evidence'
>;

const service = new ThetaOperatorCommandService({ workflow });
const plan = await service.execute({
  kind: 'planShow',
  runId: 'run-001',
  json: false,
});
if (
  !plan ||
  typeof plan !== 'object' ||
  (plan as { approvalReady?: boolean }).approvalReady !== true
) {
  throw new Error('Plan projection was not delegated to Runtime events.');
}

await service.execute({
  kind: 'planApprove',
  runId: 'run-001',
  approvedBy: 'operator-001',
  json: false,
});
if (resumeCount !== 1) {
  throw new Error('HumanPlanReview was not resumed exactly once.');
}

pendingActionRef = THETA_APPROVAL_KEYS.trainingReview;
let rejectedWrongGate = false;
try {
  await service.execute({
    kind: 'planApprove',
    runId: 'run-001',
    approvedBy: 'operator-001',
    json: false,
  });
} catch {
  rejectedWrongGate = true;
}
if (!rejectedWrongGate || resumeCount !== 1) {
  throw new Error('Plan approval escaped its HumanPlanReview boundary.');
}

const languageRequest: LanguageRequest = {
  schemaVersion: LANGUAGE_CONTRACT_VERSION,
  task: 'classify_intent' as const,
  sourceText: 'Show status.',
};
const fallbackLanguage = await new ThetaOperatorCommandService({
  workflow,
  languageProviderConfigured: () => false,
}).execute({
  kind: 'languageGenerate',
  request: languageRequest,
  approve: false,
  json: false,
});
if (
  !fallbackLanguage ||
  typeof fallbackLanguage !== 'object' ||
  (fallbackLanguage as { source?: string }).source !== 'deterministic'
) {
  throw new Error('Unconfigured language provider did not fall back locally.');
}

const languageCalls = {
  requested: 0,
  approved: 0,
};
const governedLanguage = new ThetaOperatorCommandService({
  workflow,
  languageProviderConfigured: () => true,
  requestLanguageGenerate: async () => {
    languageCalls.requested += 1;
    return {
      status: 'human_review_required',
      toolId: 'theta.language.generate',
    } as never;
  },
  approveLanguageGenerate: async () => {
    languageCalls.approved += 1;
    return {
      status: 'completed',
      toolId: 'theta.language.generate',
      output: {
        schemaVersion: LANGUAGE_CONTRACT_VERSION,
        task: 'classify_intent',
        source: 'minimax',
        intent: 'read_status',
        text: 'Read-only status request.',
        factsHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    } as never;
  },
});
const gate = await governedLanguage.execute({
  kind: 'languageGenerate',
  request: languageRequest,
  approve: false,
  json: false,
});
if (
  languageCalls.requested !== 1 ||
  languageCalls.approved !== 0 ||
  (gate as { approvalRequired?: boolean }).approvalRequired !== true
) {
  throw new Error('External language request bypassed its approval gate.');
}
const approvedResult = await governedLanguage.execute({
  kind: 'languageGenerate',
  request: languageRequest,
  approve: true,
  json: false,
});
if (
  !approvedResult ||
  typeof approvedResult !== 'object' ||
  (approvedResult as { source?: string }).source !== 'minimax'
) {
  throw new Error('Approved language request did not use governed execution.');
}

console.log(
  JSON.stringify({
    status: 'ok',
    approvedGate: THETA_APPROVAL_KEYS.planReview,
    rejectedGate: THETA_APPROVAL_KEYS.trainingReview,
    languageFallback: 'deterministic',
    languageApprovalGate: true,
  }),
);
