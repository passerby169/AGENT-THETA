import type { ProductRunEvent } from '../../lib/api/v3/contracts.generated';

export async function* simulateEvents(
  events: ProductRunEvent[],
  options: { intervalMs?: number; afterEventId?: string; signal?: AbortSignal } = {},
): AsyncGenerator<ProductRunEvent> {
  const startIndex = options.afterEventId
    ? Math.max(0, events.findIndex((event) => event.eventId === options.afterEventId) + 1)
    : 0;
  for (const event of events.slice(startIndex)) {
    if (options.signal?.aborted) return;
    const intervalMs = options.intervalMs ?? 120;
    if (intervalMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(resolve, intervalMs);
        options.signal?.addEventListener('abort', () => {
          window.clearTimeout(timeout);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    }
    yield structuredClone(event);
  }
}
