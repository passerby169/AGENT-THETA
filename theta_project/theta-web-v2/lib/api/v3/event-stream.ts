import type { ProductRunEvent } from './contracts.generated';
import { transportFailure } from './errors';

export interface RunEventStreamOptions {
  basePath?: string;
  afterEventId?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}

export async function* streamRunEvents(
  runId: string,
  options: RunEventStreamOptions = {},
): AsyncGenerator<ProductRunEvent> {
  const basePath = (options.basePath ?? '/api/agent-v3/events').replace(/\/$/u, '');
  const query = options.afterEventId
    ? `?afterEventId=${encodeURIComponent(options.afterEventId)}`
    : '';
  const response = await (options.fetcher ?? fetch)(
    `${basePath}/${encodeURIComponent(runId)}${query}`,
    { cache: 'no-store', headers: { Accept: 'text/event-stream' }, signal: options.signal },
  );
  if (!response.ok || !response.body) {
    throw transportFailure(response.status, `THETA Agent 事件流连接失败（HTTP ${response.status}）。`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value.replace(/\r\n/gu, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(block);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const parseEventBlock = (block: string): ProductRunEvent | undefined => {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return undefined;
  return JSON.parse(data) as ProductRunEvent;
};
