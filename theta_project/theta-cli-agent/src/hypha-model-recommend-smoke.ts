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

console.log(
  JSON.stringify({
    status: 'ok',
    runner: 'GovernedToolRunner',
    toolId: result.toolId,
    recommendationCount: result.output.recommendations.length,
    topModelId: result.output.recommendations[0]?.modelId,
  })
);
