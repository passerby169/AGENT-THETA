import { runThetaModelRecommend } from './tools/hypha-runner.js';

const result = await runThetaModelRecommend({
  dataProfile: {
    rowCount: 240,
    columns: ['content', 'created_at', 'source'],
    recommendedTextColumn: 'content',
    textColumns: [{ name: 'content' }],
    timeColumns: [{ name: 'created_at' }],
    metadataColumns: [{ name: 'source' }],
    columnProfiles: [{ name: 'content', avgLength: 92 }],
  },
  researchGoal: 'time trend topic modeling',
  researchBrief: {
    schemaVersion: '1.0.0',
    researchQuestion: 'How do topics evolve over time?',
    dataSources: ['local-csv'],
    analysisUnit: 'document',
    language: 'en',
    comparisonGroups: [],
    topicGranularity: 'medium',
    knownBiases: [],
    sensitiveData: { status: 'no', categories: [] },
    successCriteria: ['coherent temporal topics'],
    hardwareLimit: { device: 'cpu', memoryGb: 16 },
    textFieldIntent: 'document body',
    trendAnalysis: true,
    offlineOnly: true,
    requestedEmbedding: 'local',
    candidateTimeColumns: ['created_at'],
    candidateGroupColumns: [],
    unknownFields: [],
  },
  columnConfirmation: {
    schemaVersion: '1.0.0',
    datasetSha256: 'a'.repeat(64),
    textColumns: ['content'],
    timeColumn: 'created_at',
    idColumn: null,
    covariateColumns: [],
    metadataColumns: ['source'],
    groupingColumns: ['source'],
    evaluationLabelColumns: [],
    confirmedBy: 'model-recommend-smoke',
    confirmedAt: '2026-08-04T00:00:00.000Z',
  },
  constraints: {
    maxTopics: 12,
  },
});

if (result.status !== 'completed' || !result.output) {
  throw new Error(`theta.model.recommend did not complete: ${JSON.stringify(result.error ?? result.status)}`);
}

const topRecommendation = result.output.recommendations[0];
if (topRecommendation?.modelId !== 'dtm') {
  throw new Error(
    `Temporal offline research must select DTM, received ${topRecommendation?.modelId ?? 'none'}.`,
  );
}
if (
  topRecommendation.capabilityAssessment.offlineExecution !== true ||
  topRecommendation.capabilityAssessment.unmetResearchRequirements.length > 0
) {
  throw new Error(
    `DTM offline fallback was not preserved: ${JSON.stringify(topRecommendation.capabilityAssessment)}.`,
  );
}

console.log(
  JSON.stringify({
    status: 'ok',
    runner: 'GovernedToolRunner',
    toolId: result.toolId,
    recommendationCount: result.output.recommendations.length,
    topModelId: result.output.recommendations[0]?.modelId,
  })
);
