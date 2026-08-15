export interface ExploreColumnProfile {
  name: string;
  inferredType: 'empty' | 'number' | 'datetime' | 'text' | 'string';
  missingRatio: number;
  uniqueCount: number;
  uniqueRatio?: number;
  averageLength: number;
  maximumLength: number;
  parseSuccessRatio?: number;
  sampleValues?: string[];
}

export interface ExploreColumnCandidate {
  name: string;
  score: number;
  reason: string;
}

export interface ThetaDatasetExploreOutput {
  datasetRef: string;
  datasetHash: string;
  fileName: string;
  format: string;
  sizeBytes: number;
  encoding?: string;
  delimiter?: string | null;
  sheets?: string[];
  selectedSheet?: string | null;
  rowCount: number;
  columns: string[];
  columnProfiles: ExploreColumnProfile[];
  sampleRows: Array<Record<string, unknown>>;
  sampleSeed: string;
  samplePolicy?: {
    method: 'deterministic_reservoir';
    requestedRows: number;
    returnedRows: number;
    profileRows: number;
    profileTruncated: boolean;
  };
  sampleTruncated: boolean;
  outputTruncated?: boolean;
  redactionSummary: { applied: boolean; redactedValueCount: number; rules: string[] };
  candidateRoles: {
    text: ExploreColumnCandidate[];
    time: ExploreColumnCandidate[];
    id: ExploreColumnCandidate[];
    group?: ExploreColumnCandidate[];
    covariate?: ExploreColumnCandidate[];
    evaluation?: ExploreColumnCandidate[];
    metadata: ExploreColumnCandidate[];
    ignored?: ExploreColumnCandidate[];
  };
  languageDistribution: Array<{ language: string; ratio: number }>;
  duplicateRatio: number;
  timeCoverage: { start: string | null; end: string | null };
  inferredDomain: { label: string; confidence: number; evidence: string[] };
  qualityWarnings: string[];
}
