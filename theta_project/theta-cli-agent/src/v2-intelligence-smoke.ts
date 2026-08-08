import assert from 'node:assert/strict';
import { applyDecisionGapAnswer, createInitialResearchIntent, deriveDecisionGaps, emptyInterviewMemory, selectNextDecisionGap } from './agent/decision-gap.js';
import { DatasetUnderstandingLanguageLoop, MAX_DATASET_EXPLORATION_CALLS } from './dataset-understanding/language-loop.js';
import { buildDatasetFacts, buildDeterministicUnderstanding } from './dataset-understanding/service.js';
import { plannerInputV2Hash, type PlannerDecisionV2, type PlannerInputV2 } from './planner/v2-contracts.js';
import { presentPlanV2 } from './planner/v2-presenter.js';
import { buildPlannerDecisionV2, buildPlannerInputV2 } from './planner/v2-runtime.js';
import { validatePlannerDecisionV2 } from './planner/v2-validator.js';
import { validateDatasetConfirmation, validateDatasetUnderstanding } from './dataset-understanding/validator.js';
import type { ThetaDatasetExploreOutput } from './tools/dataset-explore-tool.js';

const output = {
  datasetRef: 'dataset_test', datasetHash: 'a'.repeat(64), fileName: 'dataset.csv', format: 'csv', sizeBytes: 1000,
  rowCount: 80, columns: ['text', 'timestamp'], sampleSeed: 'seed', profiles: [
    { name: 'text', inferredType: 'text', missingRatio: 0, uniqueCount: 80, averageLength: 40, maximumLength: 80 },
    { name: 'timestamp', inferredType: 'datetime', missingRatio: 0, uniqueCount: 20, averageLength: 10, maximumLength: 10 },
  ], languageDistribution: [{ language: 'zh', ratio: 1 }], duplicateRatio: 0,
  timeCoverage: { start: '2026-01-01', end: '2026-02-01' }, head: [{ text: '已脱敏样本' }], sample: [{ text: '已脱敏样本' }],
  exceptionalSample: [{ text: '已脱敏异常样本' }], columnSamples: [{ text: '已脱敏列样本' }],
  sampleTruncated: false, redaction: { applied: true, redactedValueCount: 0, rules: ['email', 'phone', 'id'] },
  columnRoles: {
    text: [{ name: 'text', score: 0.96, reason: '文本列' }],
    time: [{ name: 'timestamp', score: 0.9, reason: '时间列' }], id: [], metadata: [],
  }, inferredDomain: { label: '社会文本研究', confidence: 0.72, evidence: ['文本样本'] }, qualityWarnings: [],
} as ThetaDatasetExploreOutput;
const facts = buildDatasetFacts(output);
let calls = 0;
const loop = new DatasetUnderstandingLanguageLoop({
  generate: async () => ({
    schemaVersion: '1.0.0', source: 'minimax', factsHash: 'b'.repeat(64),
    decision: { kind: 'request_view', view: 'profiles', reason: 'need profiles' }, telemetry: {},
  }),
  explore: async () => { calls += 1; return output; },
});
const bounded = await loop.understand(facts, output);
assert.equal(calls, MAX_DATASET_EXPLORATION_CALLS);
assert.equal(bounded.source, 'deterministic');
assert.equal(bounded.fallbackReason, 'tool_budget_exhausted');

let sanitizedRequest = '';
const noSampleLoop = new DatasetUnderstandingLanguageLoop({
  generate: async (request) => {
    sanitizedRequest = JSON.stringify(request);
    return {
      schemaVersion: '1.0.0', source: 'minimax', factsHash: 'c'.repeat(64),
      decision: { kind: 'request_view', view: 'sample', reason: 'need samples' }, telemetry: {},
    };
  },
  explore: async () => { throw new Error('Sample exploration must not run without consent.'); },
});
const noSample = await noSampleLoop.understand(facts, output);
assert.equal(noSample.fallbackReason, 'illegal_tool_request');
assert.equal(sanitizedRequest.includes('已脱敏样本'), false);

const understanding = buildDeterministicUnderstanding(facts, output);
assert.equal(validateDatasetUnderstanding(understanding, facts).valid, true);
assert.equal(validateDatasetUnderstanding({
  ...understanding,
  evidenceReferences: [{ kind: 'sample_row', sampleIndex: 99, claim: 'invalid sample' }],
}, facts).valid, false);
const confirmation = {
  schemaVersion: '2.0.0' as const, datasetRef: facts.datasetRef, datasetHash: facts.datasetHash,
  status: 'confirmed' as const, domainLabel: understanding.domain.label, analysisUnit: understanding.analysisUnit,
  textColumns: ['text'], timeColumns: ['timestamp'], idColumns: [], metadataColumns: [],
  confirmedBy: 'owner', confirmedAt: new Date().toISOString(),
};
const initialIntent = createInitialResearchIntent();
const gaps = deriveDecisionGaps(understanding, confirmation, initialIntent);
const first = selectNextDecisionGap(gaps, emptyInterviewMemory());
assert.ok(first);
const turn = applyDecisionGapAnswer(initialIntent, first, '不知道', emptyInterviewMemory());
assert.ok(!turn.intent.unknowns.includes(first.id));
assert.equal(turn.appliedDefaults.length, 1);
const gapAfterDefault = selectNextDecisionGap(
  deriveDecisionGaps(understanding, confirmation, turn.intent),
  turn.memory,
);
assert.notEqual(gapAfterDefault?.id, first.id);

const multiIntentAnswer = [
  '我希望识别主要主题，比较不同来源，并分析按月的时间趋势。',
  '成功标准是每个主题有关键词、代表文本和可解释的趋势图。',
  '使用 CPU 离线运行，可用内存 16GB。',
].join('');
const multiIntentTurn = applyDecisionGapAnswer(
  initialIntent,
  first,
  multiIntentAnswer,
  emptyInterviewMemory(),
);
assert.equal(multiIntentTurn.intent.temporalAnalysis, true);
assert.ok(multiIntentTurn.intent.comparisonDimensions.length > 0);
assert.ok(multiIntentTurn.intent.successCriteria.length > 0);
assert.ok(multiIntentTurn.intent.constraints.some((item) => /CPU/iu.test(item)));
assert.ok(!multiIntentTurn.intent.unknowns.includes('research_goal'));
assert.ok(!multiIntentTurn.intent.unknowns.includes('comparison'));
assert.ok(!multiIntentTurn.intent.unknowns.includes('temporal'));
assert.ok(!multiIntentTurn.intent.unknowns.includes('success'));
assert.equal(validateDatasetConfirmation(confirmation, facts).valid, true);
assert.equal(validateDatasetConfirmation({
  ...confirmation,
  textColumns: ['missing-column'],
}, facts).valid, false);

const plannerInput: PlannerInputV2 = {
  schemaVersion: '2.0.0', facts, confirmation,
  intent: { ...turn.intent, temporalAnalysis: true, unknowns: [] },
  hardware: { device: 'cpu', memoryGb: 16, offlineOnly: true }, catalogVersion: 'test',
  candidates: [{ modelId: 'dtm', runnable: true, capabilities: ['temporal_topics'], estimatedMemoryGb: 4 }],
  evidenceRefs: ['evidence-1'], userOverrides: {},
};
const decision: PlannerDecisionV2 = {
  schemaVersion: '2.0.0', inputHash: plannerInputV2Hash(plannerInput), modelId: 'dtm', parameters: { numTopics: 5 },
  evaluation: ['主题一致性与人工可解释性'], visualizations: ['主题随时间变化图'], warnings: [], assumptions: [],
};
const validation = validatePlannerDecisionV2(plannerInput, decision);
assert.equal(validation.valid, true);
const presentedPlan = presentPlanV2(plannerInput, decision, validation);
assert.equal(presentedPlan.approvalRequired, true);
assert.equal(presentedPlan.researchGoal, plannerInput.intent.researchQuestion);
assert.ok(presentedPlan.dataBasis.some((item) => item.includes('80 行')));
assert.equal(presentedPlan.keyParameters[0]?.source, 'validated_default');
const runtimeRecommendation = {
  schemaVersion: '1.0.0' as const,
  deterministic: true as const,
  recommendationVersion: '1.0.0' as const,
  catalogSource: 'smoke-catalog',
  dataProfileSummary: { rowCount: 80, textColumnCount: 1, timeColumnCount: 1, metadataColumnCount: 0, averageTextLength: 40 },
  recommendations: [{
    rank: 1, modelId: 'dtm', modelName: 'DTM', maturity: 'production' as const, score: 90, confidence: 'high' as const,
    reasonCodes: ['temporal_fit'], warnings: [], requirements: [],
    topicRecommendation: { range: [2, 20] as [number, number], firstRun: 5, alternatives: [4, 6] },
    parameters: [],
    resourceEstimate: { cpu: 'medium' as const, gpu: 'none' as const, memory: 'medium' as const, disk: 'low' as const, relativeRuntime: 'medium' as const, network: 'none' as const },
    evidenceRefs: [],
    capabilityAssessment: { temporalTopics: true, metadataEffects: false, shortTextOptimized: false, offlineExecution: true, cpuExecution: true, nativeOutputs: ['topic_trends'], unmetResearchRequirements: [] },
    recommendedPlanPatch: { modelId: 'dtm', mode: 'unsupervised' as const, topicCountMode: 'fixed' as const, numTopics: 5 },
  }],
  skipped: [], warnings: [],
  constraintsApplied: { preferredModelIds: [], forbiddenModelIds: [], unavailableRequirements: [], mode: null, maxTopics: null },
  researchRequirements: { required: ['temporal_topics'], preferred: [], reasons: { temporal_topics: 'time trend' } },
  degradation: { required: false, unmetRequirements: [], message: null }, noEvidence: false,
};
const runtimeInput = buildPlannerInputV2({
  facts,
  confirmation,
  intent: plannerInput.intent,
  recommendation: runtimeRecommendation,
  constraints: { device: 'cpu', memoryGb: 16, offlineOnly: true },
});
const runtimeDecision = buildPlannerDecisionV2({
  input: runtimeInput,
  plan: { datasetId: 'dataset', modelId: 'dtm', mode: 'unsupervised', numTopics: 5 },
  proposal: {
    schemaVersion: '1.0.0', source: 'deterministic', fallbackReason: 'planner_not_enabled', factsHash: 'b'.repeat(64),
    inputSnapshot: { schemaVersion: '1.0.0', researchBriefHash: '1'.repeat(64), datasetProfileHash: '2'.repeat(64), columnConfirmationHash: '3'.repeat(64), recommendationHash: '4'.repeat(64), evidenceBundleHash: '5'.repeat(64), factsHash: '6'.repeat(64), snapshotHash: '7'.repeat(64) },
    evidenceSelectionReceipts: [],
    draft: {
      schemaVersion: '1.0.0', summary: 'DTM temporal plan',
      primary: { role: 'primary', modelId: 'dtm', choice: 'Use DTM', evidenceRefs: [], confidence: 'high', assumptions: [], risks: [], alternativesConsidered: [], parameterCandidates: [] },
      baseline: null, alternatives: [],
      experimentProtocol: { mode: 'quick', primarySeeds: [42], baselineModelId: null, baselineSeeds: [], rationale: 'Smoke', evidenceRefs: [], confidence: 'high' },
      preprocessing: [{ choice: 'Normalize text', evidenceRefs: [], confidence: 'high', assumptions: [], risks: [], alternativesConsidered: [] }],
      evaluation: [{ choice: 'Temporal coherence', evidenceRefs: [], confidence: 'high', assumptions: [], risks: [], alternativesConsidered: [] }],
      visualizations: ['Topic trend chart'], requestedTools: [], openQuestions: [],
    },
  },
  recommendation: runtimeRecommendation,
});
const runtimeValidation = validatePlannerDecisionV2(runtimeInput, runtimeDecision);
assert.equal(runtimeValidation.valid, true);
assert.equal(runtimeDecision.inputHash, plannerInputV2Hash(runtimeInput));
const invalidDecision = { ...runtimeDecision, modelId: 'missing-model' };
assert.equal(validatePlannerDecisionV2(runtimeInput, invalidDecision).valid, false);
console.log(JSON.stringify({
  status: 'ok',
  explorationCalls: calls,
  defaultedGap: first.id,
  nextGapAfterDefault: gapAfterDefault?.id ?? null,
  multiIntentFields: multiIntentTurn.extractedFields,
  plannerValid: validation.valid,
  runtimePlannerValid: runtimeValidation.valid,
}));
