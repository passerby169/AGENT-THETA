import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
} from '@hypha/inference';
import {
  LANGUAGE_CONTRACT_VERSION,
  type LanguageRequest,
} from './language/contracts.js';
import { ThetaLanguageService } from './language/service.js';
import { sanitizeLanguageRequest } from './language/sanitizer.js';
import { MiniMaxInferenceProvider } from './providers/minimax.js';

function fakeProvider(output: unknown): InferenceProvider {
  return {
    id: 'fake-provider',
    async infer(
      _request: InferenceRequest,
    ): Promise<InferenceResponse> {
      return {
        id: 'fake-response',
        output,
      };
    },
  };
}

const request: LanguageRequest = {
  schemaVersion: LANGUAGE_CONTRACT_VERSION,
  task: 'explain_recommendation',
  recommendation: {
    modelId: 'theta',
    score: 84,
    confidence: 'high',
    reasonCodes: ['THETA_NATIVE_MODEL', 'EVIDENCE_SUPPORTED'],
    warnings: [],
  },
  evidence: [
    {
      evidenceId: 'ev-001',
      authority: 'L1',
      excerpt: 'Read C:\\private\\dataset.csv with api_key=abcdefghijklmnop.',
    },
  ],
};

const sanitized = sanitizeLanguageRequest(request);
const serialized = JSON.stringify(sanitized);
if (
  serialized.includes('C:\\private') ||
  serialized.includes('abcdefghijklmnop')
) {
  throw new Error('Language sanitizer leaked a local path or API key.');
}

const fallback = await new ThetaLanguageService().generate(request);
if (
  fallback.source !== 'deterministic' ||
  fallback.fallbackReason !== 'provider_not_configured'
) {
  throw new Error('Missing provider did not produce deterministic fallback.');
}

const valid = await new ThetaLanguageService({
  provider: fakeProvider({
    task: 'explain_recommendation',
    text: 'THETA ranks first because local rules and evidence support it.',
  }),
}).generate(request);
if (valid.source !== 'minimax') {
  throw new Error('Valid provider output was not accepted.');
}

let requestedUrl = '';
let requestedBody = '';
const miniMaxProvider = new MiniMaxInferenceProvider({
  apiKey: 'test-key-not-a-secret',
  model: 'MiniMax-test',
  timeoutMs: 150_000,
  fetchImpl: (async (input, init) => {
    requestedUrl = String(input);
    requestedBody = String(init?.body ?? '');
    return new Response(
      JSON.stringify({
        id: 'minimax-test-response',
        choices: [
          {
            message: {
              content: JSON.stringify({
                task: 'explain_recommendation',
                text: 'The deterministic rules and local evidence support THETA.',
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch,
});
const adapterResult = await new ThetaLanguageService({
  provider: miniMaxProvider,
  modelAlias: miniMaxProvider.model,
}).generate(request);
if (
  adapterResult.source !== 'minimax' ||
  requestedUrl !== 'https://api.minimax.io/v1/chat/completions' ||
  !requestedBody.includes('"model":"MiniMax-test"') ||
  requestedBody.includes('C:\\private') ||
  requestedBody.includes('abcdefghijklmnop')
) {
  throw new Error('MiniMax adapter or sanitization boundary is invalid.');
}

const rejected = await new ThetaLanguageService({
  provider: fakeProvider({
    task: 'explain_recommendation',
    text: 'Set the training parameter to 50 and approve the plan.',
  }),
}).generate(request);
if (
  rejected.source !== 'deterministic' ||
  rejected.fallbackReason !== 'output_rejected'
) {
  throw new Error('Control-seeking provider output was not rejected.');
}

const illegalIntentRequest: LanguageRequest = {
  schemaVersion: LANGUAGE_CONTRACT_VERSION,
  task: 'classify_intent',
  sourceText: 'Please start training now.',
};
const illegalIntent = await new ThetaLanguageService({
  provider: fakeProvider({
    task: 'classify_intent',
    intent: 'start_training',
    text: 'Start training.',
  }),
}).generate(illegalIntentRequest);
if (
  illegalIntent.source !== 'deterministic' ||
  illegalIntent.fallbackReason !== 'schema_validation_failed'
) {
  throw new Error('Illegal intent did not trigger deterministic fallback.');
}

console.log(
  JSON.stringify({
    status: 'ok',
    providerBoundary: 'optional',
    fallback: fallback.fallbackReason,
    rejected: rejected.fallbackReason,
    sanitized: true,
    adapter: 'openai-compatible',
  }),
);
