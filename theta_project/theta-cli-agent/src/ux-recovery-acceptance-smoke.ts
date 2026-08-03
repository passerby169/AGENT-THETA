import {
  evidenceSelectionReceiptSchema,
  plannerProgressEventSchema,
} from './planner/contracts.js';
import {
  createTrainingPlanRecord,
  sha256Canonical,
  upgradeTrainingPlanRecord,
} from './planning/engine.js';
import { createPlanningFixture } from './planning/test-fixture.js';
import {
  trainingPhaseContextSchema,
  trainingPhaseSchema,
} from './training/contracts.js';

const progress = plannerProgressEventSchema.parse({
  stage: 'select_evidence',
  status: 'completed',
  attempt: 1,
  occurredAt: '2026-08-04T00:00:00.000Z',
  elapsedMs: 1250,
});

const receipt = evidenceSelectionReceiptSchema.parse({
  schemaVersion: '1.0.0',
  receiptId: `evidence_selection_${'a'.repeat(20)}`,
  evidenceBundleHash: 'b'.repeat(64),
  factsHash: 'c'.repeat(64),
  attempt: 1,
  provider: 'minimax',
  model: 'configured-planner-model',
  outcome: 'rejected',
  availableEvidenceIds: ['evidence.available'],
  acceptedEvidenceIds: [],
  rejectedEvidence: [{
    targetId: 'model.primary',
    evidenceId: 'E99',
    code: 'EVIDENCE_ID_NOT_IN_RETRIEVAL_SET',
    message: 'Evidence was outside the bounded retrieval set.',
  }],
  bindings: [{
    targetId: 'model.primary',
    evidenceIds: [],
    compatible: false,
  }],
  issues: [{
    targetId: 'model.primary',
    evidenceId: 'E99',
    code: 'EVIDENCE_ID_NOT_IN_RETRIEVAL_SET',
    message: 'Evidence was outside the bounded retrieval set.',
  }],
  createdAt: '2026-08-04T00:00:01.000Z',
});

const fixture = createPlanningFixture();
const current = createTrainingPlanRecord({
  ...fixture,
  createdAt: fixture.createdAt ?? '2026-08-04T00:00:00.000Z',
});
const legacyCanonical = {
  ...current.canonicalPlan,
  schemaVersion: '1.0.0' as const,
};
const legacyHash = sha256Canonical(legacyCanonical);
const legacy = {
  ...current,
  schemaVersion: '1.0.0' as const,
  planId: `plan_${legacyHash.slice(0, 16)}`,
  planHash: legacyHash,
  canonicalPlan: legacyCanonical,
};
const upgraded = upgradeTrainingPlanRecord(
  legacy,
  '2026-08-04T00:00:02.000Z',
);
if (
  upgraded.schemaVersion !== '2.0.0' ||
  upgraded.revisionOfPlanId !== legacy.planId ||
  upgraded.revisionOfPlanHash !== legacy.planHash ||
  upgraded.planVersion !== legacy.planVersion + 1 ||
  upgraded.planHash === legacy.planHash
) {
  throw new Error('Plan V1 to V2 upgrade did not create an immutable revision.');
}

trainingPhaseSchema.parse('training');
trainingPhaseContextSchema.parse({
  modelId: 'dtm',
  seed: 42,
  runIndex: 1,
  totalRuns: 3,
});

console.log(JSON.stringify({
  status: 'ok',
  plannerStage: progress.stage,
  evidenceOutcome: receipt.outcome,
  evidenceErrorCode: receipt.issues[0]?.code,
  upgradedPlanVersion: upgraded.planVersion,
  trainingPhase: 'training',
}));
