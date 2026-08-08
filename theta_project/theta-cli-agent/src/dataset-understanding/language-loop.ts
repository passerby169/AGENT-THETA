import { ZodError } from 'zod';
import {
  datasetUnderstandingDraftSchema,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
} from './contracts.js';
import { buildDeterministicUnderstanding } from './service.js';
import { validateDatasetUnderstanding } from './validator.js';
import type {
  DatasetUnderstandingLanguageRequest,
  DatasetUnderstandingLanguageResult,
} from '../tools/dataset-understanding-language-tool.js';
import type {
  DatasetExploreView,
  ThetaDatasetExploreOutput,
} from '../tools/dataset-explore-tool.js';

export const MAX_DATASET_EXPLORATION_CALLS = 3;

export interface DatasetUnderstandingLanguageLoopOptions {
  generate: (
    request: DatasetUnderstandingLanguageRequest,
  ) => Promise<DatasetUnderstandingLanguageResult>;
  explore: (input: {
    datasetRef: string;
    view: DatasetExploreView;
    selectedColumns?: string[];
  }) => Promise<ThetaDatasetExploreOutput>;
  allowRemoteSamples?: boolean;
}

export interface DatasetUnderstandingLanguageLoopResult {
  draft: DatasetUnderstandingDraft;
  source: 'minimax' | 'deterministic';
  explorationCalls: number;
  fallbackReason?:
    | 'provider_not_configured'
    | 'provider_error'
    | 'tool_error'
    | 'dataset_changed'
    | 'invalid_output'
    | 'tool_budget_exhausted'
    | 'illegal_tool_request';
  datasetHashChange?: {
    previousDatasetHash: string;
    detectedDatasetHash: string;
  };
}

export class DatasetUnderstandingLanguageLoop {
  constructor(
    private readonly options: DatasetUnderstandingLanguageLoopOptions,
  ) {}

  async understand(
    facts: DatasetFacts,
    initial: ThetaDatasetExploreOutput,
  ): Promise<DatasetUnderstandingLanguageLoopResult> {
    const observations: Array<Record<string, unknown>> = [
      boundedObservation(initial, this.options.allowRemoteSamples === true),
    ];
    let explorationCalls = 0;
    let validationRetryUsed = false;
    let validationErrors: string[] = [];

    while (explorationCalls <= MAX_DATASET_EXPLORATION_CALLS) {
      let turn: DatasetUnderstandingLanguageResult;
      try {
        turn = await this.options.generate({
          schemaVersion: '1.0.0',
          facts: languageFacts(facts, this.options.allowRemoteSamples === true),
          observations,
          allowRemoteSamples: this.options.allowRemoteSamples === true,
          remainingExplorationCalls:
            MAX_DATASET_EXPLORATION_CALLS - explorationCalls,
          validationErrors,
        });
      } catch {
        return this.fallback(facts, initial, 'provider_error', explorationCalls);
      }

      if (turn.source !== 'minimax' || turn.decision.kind === 'fallback') {
        return this.fallback(
          facts,
          initial,
          turn.fallbackReason ?? 'provider_not_configured',
          explorationCalls,
        );
      }

      if (turn.decision.kind === 'request_view') {
        if (explorationCalls >= MAX_DATASET_EXPLORATION_CALLS) {
          return this.fallback(
            facts,
            initial,
            'tool_budget_exhausted',
            explorationCalls,
          );
        }
        if (
          !this.options.allowRemoteSamples &&
          (turn.decision.view === 'head' || turn.decision.view === 'sample')
        ) {
          return this.fallback(
            facts,
            initial,
            'illegal_tool_request',
            explorationCalls,
          );
        }
        const available = new Set(facts.columns.map((column) => column.name));
        const selectedColumns = turn.decision.selectedColumns?.filter((column) =>
          available.has(column),
        );
        if (
          turn.decision.selectedColumns &&
          selectedColumns?.length !== turn.decision.selectedColumns.length
        ) {
          return this.fallback(
            facts,
            initial,
            'illegal_tool_request',
            explorationCalls,
          );
        }
        let observation: ThetaDatasetExploreOutput;
        try {
          observation = await this.options.explore({
            datasetRef: facts.datasetRef,
            view: turn.decision.view,
            selectedColumns,
          });
        } catch {
          return this.fallback(facts, initial, 'tool_error', explorationCalls);
        }
        if (observation.datasetHash !== facts.datasetHash) {
          return {
            ...this.fallback(
              facts,
              initial,
              'dataset_changed',
              explorationCalls,
            ),
            datasetHashChange: {
              previousDatasetHash: facts.datasetHash,
              detectedDatasetHash: observation.datasetHash,
            },
          };
        }
        explorationCalls += 1;
        observations.push(
          boundedObservation(
            observation,
            this.options.allowRemoteSamples === true,
          ),
        );
        continue;
      }

      try {
        const draft = datasetUnderstandingDraftSchema.parse({
          ...turn.decision.understanding,
          schemaVersion: '2.0.0',
          datasetRef: facts.datasetRef,
          datasetHash: facts.datasetHash,
          provenance: {
            source: 'minimax',
            toolIds: [
              'theta.dataset.understanding.language',
              'theta.dataset.explore',
            ],
            sampleSeed: initial.sampleSeed,
            generatedAt: new Date().toISOString(),
          },
        });
        const validation = validateDatasetUnderstanding(draft, facts);
        if (!validation.valid) {
          if (validationRetryUsed) {
            return this.fallback(
              facts,
              initial,
              'invalid_output',
              explorationCalls,
            );
          }
          validationRetryUsed = true;
          validationErrors = validation.errors;
          continue;
        }
        return { draft, source: 'minimax', explorationCalls };
      } catch (error) {
        if (!(error instanceof ZodError) || validationRetryUsed) {
          return this.fallback(
            facts,
            initial,
            'invalid_output',
            explorationCalls,
          );
        }
        validationRetryUsed = true;
        validationErrors = error.issues.map((issue) => issue.message);
      }
    }

    return this.fallback(
      facts,
      initial,
      'tool_budget_exhausted',
      explorationCalls,
    );
  }

  private fallback(
    facts: DatasetFacts,
    initial: ThetaDatasetExploreOutput,
    fallbackReason: NonNullable<DatasetUnderstandingLanguageLoopResult['fallbackReason']>,
    explorationCalls: number,
  ): DatasetUnderstandingLanguageLoopResult {
    return {
      draft: buildDeterministicUnderstanding(facts, initial),
      source: 'deterministic',
      explorationCalls,
      fallbackReason,
    };
  }
}

const boundedObservation = (
  output: ThetaDatasetExploreOutput,
  allowSamples: boolean,
): Record<string, unknown> => ({
  datasetRef: output.datasetRef,
  datasetHash: output.datasetHash,
  rowCount: output.rowCount,
  profiles: output.profiles.slice(0, 80).map((profile) => ({
    ...profile,
    sampleValues: allowSamples ? (profile.sampleValues ?? []).slice(0, 5) : [],
  })),
  columnRoles: output.columnRoles,
  inferredDomain: output.inferredDomain,
  qualityWarnings: output.qualityWarnings.slice(0, 20),
  ...(allowSamples
    ? {
        head: output.head.slice(0, 5),
        samples: output.sample.slice(0, 10),
      }
    : {}),
});

const languageFacts = (
  facts: DatasetFacts,
  allowSamples: boolean,
): DatasetFacts => ({
  ...facts,
  fileName: 'registered-dataset',
  columns: facts.columns.map((column) => ({
    ...column,
    sampleValues: allowSamples ? column.sampleValues : [],
  })),
});
