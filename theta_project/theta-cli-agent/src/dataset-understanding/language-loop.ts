import type { InferenceProvider, PromptMessage } from '@hypha/inference';
import { ZodError } from 'zod';
import {
  datasetUnderstandingDraftSchema,
  type DatasetFacts,
  type DatasetUnderstandingDraft,
} from './contracts.js';
import { buildDeterministicUnderstanding } from './service.js';
import type { ThetaDatasetExploreOutput } from '../tools/dataset-explore-tool.js';

export const DATASET_UNDERSTANDING_TOOL_ID = 'theta.dataset.explore';
export const MAX_DATASET_EXPLORATION_CALLS = 3;

export interface DatasetUnderstandingLanguageLoopOptions {
  provider?: InferenceProvider;
  explore: (input: {
    datasetRef: string;
    view: 'schema' | 'profile' | 'samples' | 'roles';
  }) => Promise<ThetaDatasetExploreOutput>;
  modelAlias?: string;
}

export interface DatasetUnderstandingLanguageLoopResult {
  draft: DatasetUnderstandingDraft;
  source: 'minimax' | 'deterministic';
  explorationCalls: number;
  fallbackReason?:
    | 'provider_not_configured'
    | 'provider_error'
    | 'invalid_output'
    | 'tool_budget_exhausted'
    | 'illegal_tool_request';
}

export class DatasetUnderstandingLanguageLoop {
  constructor(
    private readonly options: DatasetUnderstandingLanguageLoopOptions,
  ) {}

  async understand(
    facts: DatasetFacts,
    initial: ThetaDatasetExploreOutput,
  ): Promise<DatasetUnderstandingLanguageLoopResult> {
    if (!this.options.provider) {
      return this.fallback(facts, initial, 'provider_not_configured', 0);
    }
    const observations: Array<Record<string, unknown>> = [
      boundedObservation(initial),
    ];
    let explorationCalls = 0;
    let validationRetryUsed = false;
    while (explorationCalls <= MAX_DATASET_EXPLORATION_CALLS) {
      try {
        const response = await this.options.provider.infer({
          runId: `theta-understanding-${facts.datasetHash.slice(0, 16)}`,
          stepId: `understanding-${explorationCalls + 1}`,
          modelAlias: this.options.modelAlias ?? 'configured-language-model',
          input: { messages: promptMessages(facts, observations, validationRetryUsed) },
          tools: [datasetExploreDescriptor],
          options: { temperature: 0.1, maxTokens: 1000 },
          trace: true,
          metadata: {
            purpose: 'dataset_understanding',
            datasetRef: facts.datasetRef,
            explorationCalls,
          },
        });
        const output = record(response.output);
        if (output.kind === 'tool_calls') {
          const calls = Array.isArray(output.toolCalls) ? output.toolCalls : [];
          if (calls.length !== 1) {
            return this.fallback(facts, initial, 'illegal_tool_request', explorationCalls);
          }
          if (explorationCalls >= MAX_DATASET_EXPLORATION_CALLS) {
            return this.fallback(facts, initial, 'tool_budget_exhausted', explorationCalls);
          }
          const call = record(calls[0]);
          if (call.name !== DATASET_UNDERSTANDING_TOOL_ID) {
            return this.fallback(facts, initial, 'illegal_tool_request', explorationCalls);
          }
          const args = record(call.arguments);
          const view = exploreView(args.view);
          const observation = await this.options.explore({
            datasetRef: facts.datasetRef,
            view,
          });
          explorationCalls += 1;
          observations.push(boundedObservation(observation));
          continue;
        }
        try {
          const draft = datasetUnderstandingDraftSchema.parse({
            ...output,
            datasetRef: facts.datasetRef,
            datasetHash: facts.datasetHash,
            provenance: {
              source: 'minimax',
              toolIds: [DATASET_UNDERSTANDING_TOOL_ID],
              sampleSeed: initial.sampleSeed,
              generatedAt: new Date().toISOString(),
            },
          });
          return { draft, source: 'minimax', explorationCalls };
        } catch (error) {
          if (!(error instanceof ZodError) || validationRetryUsed) {
            return this.fallback(facts, initial, 'invalid_output', explorationCalls);
          }
          validationRetryUsed = true;
        }
      } catch {
        return this.fallback(facts, initial, 'provider_error', explorationCalls);
      }
    }
    return this.fallback(facts, initial, 'tool_budget_exhausted', explorationCalls);
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

const datasetExploreDescriptor = {
  id: DATASET_UNDERSTANDING_TOOL_ID,
  name: DATASET_UNDERSTANDING_TOOL_ID,
  description: 'Read one bounded, redacted view of the registered dataset.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      datasetRef: { type: 'string' },
      view: { enum: ['schema', 'profile', 'samples', 'roles'] },
    },
    required: ['datasetRef', 'view'],
  },
};

const promptMessages = (
  facts: DatasetFacts,
  observations: Array<Record<string, unknown>>,
  repair: boolean,
): PromptMessage[] => [
  {
    role: 'system',
    content: [
      'You are the bounded dataset-understanding component inside THETA.',
      `You may call only ${DATASET_UNDERSTANDING_TOOL_ID}, at most once per response.`,
      'Never request a file path, raw file, shell, network, memory write, plan, approval, or training action.',
      'Use only bounded observations. Return one JSON object matching DatasetUnderstandingDraft when sufficient.',
      repair ? 'The previous JSON was invalid. Return a smaller valid object without extra fields.' : '',
    ].filter(Boolean).join(' '),
  },
  {
    role: 'user',
    content: JSON.stringify({ facts, observations }),
  },
];

const boundedObservation = (
  output: ThetaDatasetExploreOutput,
): Record<string, unknown> => ({
  datasetRef: output.datasetRef,
  datasetHash: output.datasetHash,
  rowCount: output.rowCount,
  profiles: output.profiles.slice(0, 80),
  columnRoles: output.columnRoles,
  inferredDomain: output.inferredDomain,
  qualityWarnings: output.qualityWarnings.slice(0, 20),
  samples: output.sample.slice(0, 12),
});

const exploreView = (
  value: unknown,
): 'schema' | 'profile' | 'samples' | 'roles' => {
  if (value === 'schema' || value === 'profile' || value === 'samples' || value === 'roles') {
    return value;
  }
  throw new Error('Unsupported dataset exploration view.');
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
