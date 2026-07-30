import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResponse,
  PromptMessage,
} from '@hypha/inference';

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';
const DEFAULT_MODEL = 'MiniMax-M2.7';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface MiniMaxProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface MiniMaxProviderInput {
  messages: PromptMessage[];
}

export class MiniMaxInferenceProvider implements InferenceProvider {
  readonly id = 'minimax-openai-compatible';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MiniMaxProviderConfig) {
    this.apiKey = required(config.apiKey, 'MiniMax API key');
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL);
    this.model = required(config.model ?? DEFAULT_MODEL, 'MiniMax model');
    this.timeoutMs = positiveInteger(
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      'MiniMax timeout',
    );
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const input = providerInput(request.input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.model,
            messages: input.messages.map((message) => ({
              role: apiRole(message.role),
              content: message.content,
            })),
            temperature: request.options?.temperature ?? 0.2,
            max_completion_tokens: Math.min(
              request.options?.maxTokens ?? 800,
              2048,
            ),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new MiniMaxProviderError(
          'provider_error',
          `MiniMax request failed with HTTP ${response.status}.`,
        );
      }
      const payload = await responseJson(response);
      const content = responseContent(payload);
      const output = parseJsonObject(content);
      const usage = record(payload.usage);
      return {
        id:
          typeof payload.id === 'string'
            ? payload.id
            : `minimax-${Date.now()}`,
        output,
        usage: {
          inputTokens: optionalNumber(usage.prompt_tokens),
          outputTokens: optionalNumber(usage.completion_tokens),
          totalTokens: optionalNumber(usage.total_tokens),
        },
        metadata: {
          providerId: this.id,
          model: this.model,
        },
      };
    } catch (error) {
      if (error instanceof MiniMaxProviderError) throw error;
      if (isAbortError(error)) {
        throw new MiniMaxProviderError(
          'timeout',
          `MiniMax request exceeded ${this.timeoutMs} ms.`,
        );
      }
      throw new MiniMaxProviderError(
        'network_failure',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class MiniMaxProviderError extends Error {
  constructor(
    readonly code:
      | 'network_failure'
      | 'timeout'
      | 'provider_error'
      | 'non_json_response',
    message: string,
  ) {
    super(message);
  }
}

export const isMiniMaxConfigured = (): boolean =>
  Boolean(process.env.MINIMAX_API_KEY?.trim());

export const createMiniMaxProviderFromEnv = ():
  | MiniMaxInferenceProvider
  | undefined => {
  const apiKey = process.env.MINIMAX_API_KEY?.trim();
  if (!apiKey) return undefined;
  return new MiniMaxInferenceProvider({
    apiKey,
    baseUrl: process.env.MINIMAX_API_BASE,
    model: process.env.MINIMAX_MODEL,
    timeoutMs: environmentInteger(
      process.env.MINIMAX_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
    ),
  });
};

const providerInput = (value: unknown): MiniMaxProviderInput => {
  if (!value || typeof value !== 'object' || !('messages' in value)) {
    throw new MiniMaxProviderError(
      'provider_error',
      'MiniMax inference input must contain messages.',
    );
  }
  const messages = (value as { messages?: unknown }).messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    !messages.every(
      (message) =>
        Boolean(message) &&
        typeof message === 'object' &&
        typeof (message as PromptMessage).role === 'string' &&
        typeof (message as PromptMessage).content === 'string',
    )
  ) {
    throw new MiniMaxProviderError(
      'provider_error',
      'MiniMax inference messages are invalid.',
    );
  }
  return { messages: messages as PromptMessage[] };
};

const apiRole = (role: PromptMessage['role']): 'system' | 'user' | 'assistant' =>
  role === 'system' || role === 'assistant' ? role : 'user';

const responseJson = async (
  response: Response,
): Promise<Record<string, unknown>> => {
  try {
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Response is not an object.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new MiniMaxProviderError(
      'non_json_response',
      error instanceof Error ? error.message : String(error),
    );
  }
};

const responseContent = (payload: Record<string, unknown>): string => {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const first = record(choices[0]);
  const message = record(first.message);
  if (typeof message.content !== 'string' || !message.content.trim()) {
    throw new MiniMaxProviderError(
      'non_json_response',
      'MiniMax response did not contain message content.',
    );
  }
  return message.content;
};

const parseJsonObject = (content: string): Record<string, unknown> => {
  const withoutThinking = content
    .replace(/<think>[\s\S]*?<\/think>/giu, '')
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const start = withoutThinking.indexOf('{');
  const end = withoutThinking.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new MiniMaxProviderError(
      'non_json_response',
      'MiniMax response did not contain a JSON object.',
    );
  }
  try {
    const value = JSON.parse(withoutThinking.slice(start, end + 1));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Parsed response is not an object.');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new MiniMaxProviderError(
      'non_json_response',
      error instanceof Error ? error.message : String(error),
    );
  }
};

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(required(value, 'MiniMax API base URL'));
  if (url.protocol !== 'https:') {
    throw new Error('MiniMax API base URL must use HTTPS.');
  }
  return url.toString().replace(/\/+$/u, '');
};

const required = (value: string, name: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
};

const positiveInteger = (value: number, name: string): number => {
  if (!Number.isInteger(value) || value <= 0 || value > 120_000) {
    throw new Error(`${name} must be an integer between 1 and 120000.`);
  }
  return value;
};

const environmentInteger = (
  value: string | undefined,
  fallback: number,
): number => {
  if (!value?.trim()) return fallback;
  return positiveInteger(Number(value), 'MINIMAX_TIMEOUT_MS');
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';
