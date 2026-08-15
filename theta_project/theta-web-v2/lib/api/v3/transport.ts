import type { ApiEnvelope } from './contracts.generated';
import { isApiFailure, ThetaApiError, transportFailure } from './errors';

export interface TransportRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface ThetaV3Transport {
  request<T>(request: TransportRequest): Promise<T>;
}

export interface HttpTransportOptions {
  basePath?: string;
  fetcher?: typeof fetch;
}

export class HttpTransport implements ThetaV3Transport {
  private readonly basePath: string;
  private readonly fetcher: typeof fetch;

  constructor(options: HttpTransportOptions = {}) {
    this.basePath = (options.basePath ?? '/api/agent-v3').replace(/\/$/u, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  async request<T>(request: TransportRequest): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.basePath}/${request.path.replace(/^\//u, '')}`, {
        method: request.method,
        cache: 'no-store',
        headers: request.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw transportFailure(0, error instanceof Error ? error.message : 'THETA Agent API 连接失败。');
    }

    const payload = await parseEnvelope<T>(response);
    if (!response.ok || isApiFailure(payload)) {
      if (isApiFailure(payload)) {
        throw new ThetaApiError(response.status, payload.error, payload.meta);
      }
      throw transportFailure(response.status, `THETA Agent API 返回 HTTP ${response.status}。`);
    }
    return payload.data;
  }
}

const parseEnvelope = async <T>(response: Response): Promise<ApiEnvelope<T>> => {
  try {
    return (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw transportFailure(response.status, 'THETA Agent API 返回了无效的 JSON 响应。');
  }
};
