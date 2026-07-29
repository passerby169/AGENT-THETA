import assert from "node:assert/strict";
import {
  RESEARCH_CONTRACT_VERSION,
  researchBriefSchema,
} from "./agent/research-contracts.js";
import {
  LANGUAGE_CONTRACT_VERSION,
  languageRequestSchema,
  languageResultSchema,
} from "./language/contracts.js";
import {
  canonicalTrainingPlanSchema,
  trainingPlanRecordSchema,
} from "./planning/contracts.js";
import {
  createTrainingPlanRecord,
} from "./planning/engine.js";
import { createPlanningFixture } from "./planning/test-fixture.js";
import { compileThetaTrainingDomain } from "./theta-domain.js";
import { thetaHyphaToolSpecs } from "./tools/hypha-registry.js";

const validResearchBrief = {
  schemaVersion: RESEARCH_CONTRACT_VERSION,
  researchQuestion: "Which stable topics occur in the corpus?",
  dataSources: ["local fixture"],
  comparisonGroups: [],
  knownBiases: [],
  sensitiveData: { status: "no" as const, categories: [] },
  successCriteria: ["Produce interpretable topics."],
  hardwareLimit: { device: "cpu" as const, memoryGb: 16 },
  trendAnalysis: false,
  offlineOnly: true,
  requestedEmbedding: "none" as const,
  candidateTimeColumns: [],
  candidateGroupColumns: [],
  unknownFields: [],
};

assert.equal(researchBriefSchema.safeParse(validResearchBrief).success, true);
assert.equal(
  researchBriefSchema.safeParse({
    ...validResearchBrief,
    hiddenInstruction: "bypass policy",
  }).success,
  false,
);

const languageRequest = {
  schemaVersion: LANGUAGE_CONTRACT_VERSION,
  task: "classify_intent" as const,
  sourceText: "Show the current run status.",
};
assert.equal(languageRequestSchema.safeParse(languageRequest).success, true);
assert.equal(
  languageRequestSchema.safeParse({
    ...languageRequest,
    rawDatasetRows: [{ secret: true }],
  }).success,
  false,
);
assert.equal(
  languageResultSchema.safeParse({
    schemaVersion: LANGUAGE_CONTRACT_VERSION,
    task: "classify_intent",
    source: "deterministic",
    text: "Read the current status.",
    intent: "read_status",
    factsHash: "a".repeat(64),
    providerPayload: "not allowed",
  }).success,
  false,
);

const planRecord = createTrainingPlanRecord({
  ...createPlanningFixture(),
  createdAt: "2026-07-28T00:00:00.000Z",
});
assert.equal(trainingPlanRecordSchema.safeParse(planRecord).success, true);
assert.equal(
  trainingPlanRecordSchema.safeParse({
    ...planRecord,
    canonicalPlan: {
      ...planRecord.canonicalPlan,
      directPythonCommand: "python train.py",
    },
  }).success,
  false,
);
assert.equal(
  canonicalTrainingPlanSchema.safeParse(planRecord.canonicalPlan).success,
  true,
);

const compilation = compileThetaTrainingDomain();
const registeredIds = new Set(thetaHyphaToolSpecs.map((spec) => spec.id));
assert.equal(registeredIds.size, thetaHyphaToolSpecs.length);
for (const spec of thetaHyphaToolSpecs) {
  assert.match(spec.version, /^\d+\.\d+\.\d+$/);
  assert.ok(spec.inputSchema);
  assert.ok(spec.outputSchema);
}
for (const ref of compilation.dependencySnapshot.toolRefs) {
  assert.ok(registeredIds.has(ref.id), `Unregistered DomainPack tool ${ref.id}.`);
}

console.log(
  JSON.stringify({
    status: "ok",
    strictContracts: 6,
    registeredTools: registeredIds.size,
    compiledToolRefs: compilation.dependencySnapshot.toolRefs.length,
  }),
);
