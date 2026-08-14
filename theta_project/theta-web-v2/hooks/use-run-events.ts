'use client';

import { useEffect, useRef, useState } from 'react';
import { configuredTransportMode, streamRunEvents } from '@/lib/api/v3';
import type { RunViewStore } from '@/lib/agent/run-view-store';
import { defaultEvents } from '@/mocks/v3/fixtures/default-scenario';
import { simulateEvents } from '@/mocks/v3/event-simulator';

export type EventConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';

export const useRunEvents = ({
  runId,
  store,
  onSnapshotRequired,
}: {
  runId?: string;
  store: RunViewStore;
  onSnapshotRequired: () => Promise<void>;
}): EventConnectionStatus => {
  const [status, setStatus] = useState<EventConnectionStatus>('idle');
  const reconnectAttempt = useRef(0);
  const snapshotCallback = useRef(onSnapshotRequired);
  snapshotCallback.current = onSnapshotRequired;

  useEffect(() => {
    if (!runId) {
      setStatus('idle');
      return;
    }

    const controller = new AbortController();
    const mode = configuredTransportMode();
    let reconnectTimer: number | undefined;

    const connect = async (): Promise<void> => {
      setStatus(reconnectAttempt.current > 0 ? 'reconnecting' : 'connecting');
      try {
        const events = mode === 'mock'
          ? simulateEvents(defaultEvents.filter((event) => event.runId === runId), {
              intervalMs: 180,
              afterEventId: store.getSnapshot().lastEventId,
              signal: controller.signal,
            })
          : streamRunEvents(runId, {
              afterEventId: store.getSnapshot().lastEventId,
              signal: controller.signal,
            });
        setStatus('connected');
        for await (const event of events) store.applyEvent(event);
        if (mode === 'mock') {
          while (!controller.signal.aborted) {
            await abortableDelay(1_500, controller.signal);
            await snapshotCallback.current().catch(() => undefined);
          }
          return;
        }
        if (controller.signal.aborted) return;
        scheduleReconnect();
      } catch (cause) {
        if (controller.signal.aborted || isAbort(cause)) return;
        await snapshotCallback.current().catch(() => undefined);
        scheduleReconnect();
      }
    };

    const scheduleReconnect = (): void => {
      reconnectAttempt.current += 1;
      if (reconnectAttempt.current > 5) {
        setStatus('offline');
        return;
      }
      setStatus('reconnecting');
      const delay = Math.min(8_000, 500 * 2 ** (reconnectAttempt.current - 1));
      reconnectTimer = window.setTimeout(() => void connect(), delay);
    };

    reconnectAttempt.current = 0;
    void connect();
    return () => {
      controller.abort();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    };
  }, [runId, store]);

  return status;
};

const isAbort = (cause: unknown): boolean =>
  cause instanceof DOMException && cause.name === 'AbortError';

const abortableDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
