import type { ThetaWorkflowService } from './theta-workflow-service.js';
import { ThetaOperatorCommandService } from './operator-command-service.js';
import { THETA_APPROVAL_KEYS } from './theta-domain.js';

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

console.log(
  JSON.stringify({
    status: 'ok',
    approvedGate: THETA_APPROVAL_KEYS.planReview,
    rejectedGate: THETA_APPROVAL_KEYS.trainingReview,
  }),
);
