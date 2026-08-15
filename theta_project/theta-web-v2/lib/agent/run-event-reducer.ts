import type { ProductRunEvent } from '../api/v3/contracts.generated';
import type { RunViewState } from './run-view-store';

export interface EventReduction {
  accepted: boolean;
  reason?: 'duplicate_event' | 'stale_revision' | 'invalid_snapshot';
  state: RunViewState;
}

export const reduceRunEvent = (
  state: RunViewState,
  event: ProductRunEvent,
): EventReduction => {
  if (event.sequence <= state.lastEventSequence) {
    return { accepted: false, reason: 'duplicate_event', state };
  }
  if (state.view && event.runRevision < state.view.revision) {
    return { accepted: false, reason: 'stale_revision', state };
  }
  if (event.type === 'run.view.updated') {
    const view = event.payload as RunViewState['view'];
    if (!view || view.runId !== event.runId || view.revision !== event.runRevision) {
      return { accepted: false, reason: 'invalid_snapshot', state };
    }
    return {
      accepted: true,
      state: { ...state, view, lastEventId: event.eventId, lastEventSequence: event.sequence },
    };
  }
  return {
    accepted: true,
    state: { ...state, lastEventId: event.eventId, lastEventSequence: event.sequence },
  };
};
