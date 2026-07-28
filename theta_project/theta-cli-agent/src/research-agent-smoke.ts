import { decideResearchGrilling } from './agent/grilling-engine.js';
import { researchBriefSchema } from './agent/research-contracts.js';
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
  analysisUnit: 'one research document',
  textFieldIntent: 'analyze the primary document body',
  sensitiveData: { status: 'no', categories: [] },
  successCriteria: ['Produce stable, interpretable topics.'],
  hardwareLimit: { device: 'cpu', memoryGb: 16 },
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

console.log(
  JSON.stringify({
    status: 'ok',
    blockingGapCount: blockingFields.length,
    firstQuestion: firstQuestion.activeQuestion,
    completeBlocking: complete.blocking,
    conflictCount: conflict.conflicts.length,
    strictContractRejected,
  }),
);
