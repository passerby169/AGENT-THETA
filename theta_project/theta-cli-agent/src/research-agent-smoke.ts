import { decideResearchGrilling } from './agent/grilling-engine.js';
import { planResearchQuestions } from './agent/question-planner.js';
import {
  RESEARCH_CONTRACT_VERSION,
  researchBriefSchema,
  type DatasetProfile,
  type InformationGap,
} from './agent/research-contracts.js';
import { ResearchService } from './agent/research-service.js';

const service = new ResearchService();

const incomplete = service.assess(
  service.createBrief({
    filePath: 'C:\\datasets\\research.csv',
    researchGoal: 'Discover stable research topics.',
  }),
);
const blockingFields = incomplete.gaps
  .filter((gap) => gap.severity === 'blocking')
  .map((gap) => gap.field);
for (const expected of [
  'domainConfirmed',
  'analysisUnit',
  'textFieldIntent',
  'sensitiveData',
]) {
  if (!blockingFields.includes(expected)) {
    throw new Error(`Missing deterministic gap rule for ${expected}.`);
  }
}
const firstQuestion = decideResearchGrilling(incomplete, 1);
if (
  firstQuestion.kind !== 'ask' ||
  firstQuestion.candidateQuestions.length < 1 ||
  firstQuestion.candidateQuestions.length > 3
) {
  throw new Error('Research grilling did not return one to three candidates.');
}

const completeBrief = service.applyAnswers(incomplete.brief, {
  researchDomain: 'public news and social discussion',
  domainConfirmed: true,
  collectionMethod: 'existing CSV records collected from public sources',
  analysisUnit: 'one research document',
  textFieldIntent: 'analyze the primary document body',
  sensitiveData: { status: 'no', categories: [] },
  successCriteria: ['Produce stable, interpretable topics.'],
  hardwareLimit: { device: 'cpu', memoryGb: 16 },
  comparisonIntent: 'none',
  comparisonGroups: [],
  topicGranularity: 'medium',
  knownBiases: ['No additional known biases beyond the small sample size.'],
});
const complete = service.assess(completeBrief);
if (complete.blocking) {
  throw new Error(
    `Complete research brief retained blocking gaps: ${complete.gaps
      .map((gap) => gap.id)
      .join(', ')}.`,
  );
}

const conflict = service.assess(
  service.applyAnswers(completeBrief, {
    offlineOnly: true,
    requestedEmbedding: 'remote',
  }),
);
if (
  !conflict.conflicts.some(
    (item) => item.id === 'conflict.offline-remote-embedding',
  ) ||
  !conflict.blocking
) {
  throw new Error('Offline and remote embedding conflict was not blocking.');
}

let strictContractRejected = false;
try {
  researchBriefSchema.parse({
    ...completeBrief,
    unexpectedProperty: true,
  });
} catch {
  strictContractRejected = true;
}
if (!strictContractRejected) {
  throw new Error('ResearchBrief contract accepted an unknown property.');
}

const repeated = service.assess(incomplete.brief);
if (
  JSON.stringify(repeated.questions) !== JSON.stringify(incomplete.questions)
) {
  throw new Error('Research question planning is not deterministic.');
}

const datasetProfile: DatasetProfile = {
  schemaVersion: RESEARCH_CONTRACT_VERSION,
  datasetSha256: 'a'.repeat(64),
  fileName: 'research.csv',
  fileSizeBytes: 4096,
  format: 'csv',
  encoding: 'utf-8',
  rowCount: 80,
  sampledRowCount: 80,
  profileScope: 'full',
  estimationWarnings: [],
  columnCount: 4,
  columns: ['id', 'text', 'timestamp', 'source'],
  columnProfiles: [],
  missingRatio: 0,
  duplicateRatio: 0,
  textLengthDistribution: { average: 42, maximum: 160 },
  languageDistribution: [{ language: 'zh', ratio: 1 }],
  timeCoverage: {
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-03-31T00:00:00.000Z',
  },
  columnCandidates: {
    text: [{ name: 'text', score: 0.98, reason: 'long natural language' }],
    time: [{ name: 'timestamp', score: 0.96, reason: 'datetime values' }],
    metadata: [{ name: 'source', score: 0.82, reason: 'categorical values' }],
  },
  sensitiveRiskCodes: [],
  inferredDomain: {
    label: 'news and public discussion',
    confidence: 0.86,
    evidence: ['keyword: news', 'keyword: policy'],
  },
};
const domainFirst = service.assess(incomplete.brief, {
  currentState: 'ResearchClarification',
  datasetProfile,
});
const domainQuestion = domainFirst.questions.find(
  (question) => question.field === 'domainConfirmed',
);
if (
  !domainQuestion?.question.includes('news and public discussion') ||
  domainFirst.questions[0]?.field !== 'domainConfirmed'
) {
  throw new Error('The inferred dataset domain was not presented as the first confirmation.');
}
const dataAware = service.assess(
  service.applyAnswers(incomplete.brief, {
    researchDomain: datasetProfile.inferredDomain?.label,
    domainConfirmed: true,
    sensitiveData: { status: 'no', categories: [] },
  }),
  {
    currentState: 'ResearchClarification',
    datasetProfile,
  },
);
const analysisUnitQuestion = dataAware.questions.find(
  (question) => question.field === 'analysisUnit',
);
if (!analysisUnitQuestion?.question.includes('80 行')) {
  throw new Error('Research questions did not use the inspected row count.');
}
const textIntentQuestion = dataAware.questions.find(
  (question) => question.field === 'textFieldIntent',
);
if (!textIntentQuestion?.question.includes('text')) {
  throw new Error('Research questions did not use detected column candidates.');
}

const blockingGap: InformationGap = {
  id: 'gap.blocking-repeat',
  field: 'analysisUnit',
  severity: 'blocking',
  reason: 'Required for deterministic planning.',
  question: 'What does one row represent?',
  informationGain: 10,
};
const optionalGap: InformationGap = {
  id: 'gap.optional-new',
  field: 'knownBiases',
  severity: 'optional',
  reason: 'Useful but not required.',
  question: 'Are there known biases?',
  informationGain: 100,
};
const repeatedBlocking = planResearchQuestions(
  [blockingGap, optionalGap],
  {
    currentState: 'ResearchClarification',
    askedCounts: { [blockingGap.id]: 10 },
    recentlyAskedGapId: blockingGap.id,
  },
  2,
);
if (repeatedBlocking[0]?.gapId !== blockingGap.id) {
  throw new Error('An optional question displaced an unresolved blocking gap.');
}

console.log(
  JSON.stringify({
    status: 'ok',
    blockingGapCount: blockingFields.length,
    firstQuestion: firstQuestion.activeQuestion,
    completeBlocking: complete.blocking,
    conflictCount: conflict.conflicts.length,
    strictContractRejected,
    dataAwareQuestions: 'verified',
    blockingPriority: 'verified',
  }),
);
