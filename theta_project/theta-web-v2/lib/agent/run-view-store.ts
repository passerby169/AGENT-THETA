import type {
  CommandReceipt,
  ConversationMessage,
  ProductRunEvent,
  ThetaRunViewV3,
} from '../api/v3/contracts.generated';

export interface RunViewState {
  view: ThetaRunViewV3 | null;
  messages: ConversationMessage[];
  commands: Record<string, CommandReceipt>;
  lastEventId?: string;
  lastEventSequence: number;
}

export type RunViewStoreListener = (state: Readonly<RunViewState>) => void;

const initialState = (): RunViewState => ({
  view: null,
  messages: [],
  commands: {},
  lastEventSequence: 0,
});

export class RunViewStore {
  private state: RunViewState = initialState();
  private readonly listeners = new Set<RunViewStoreListener>();

  getSnapshot = (): Readonly<RunViewState> => this.state;

  subscribe = (listener: RunViewStoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reset(): void {
    this.replace(initialState());
  }

  hydrateView(view: ThetaRunViewV3): boolean {
    if (this.state.view && view.revision < this.state.view.revision) return false;
    this.replace({ ...this.state, view });
    return true;
  }

  mergeMessages(messages: ConversationMessage[]): void {
    const byId = new Map(this.state.messages.map((message) => [message.messageId, message]));
    for (const message of messages) {
      const existing = byId.get(message.messageId);
      if (!existing || message.status !== existing.status) byId.set(message.messageId, message);
    }
    const merged = [...byId.values()].sort((left, right) => left.sequence - right.sequence);
    this.replace({ ...this.state, messages: merged });
  }

  trackCommand(command: CommandReceipt): void {
    const current = this.state.commands[command.commandId];
    if (current && commandRank(command.status) < commandRank(current.status)) return;
    this.replace({
      ...this.state,
      commands: { ...this.state.commands, [command.commandId]: command },
    });
  }

  applyEvent(event: ProductRunEvent): boolean {
    if (event.sequence <= this.state.lastEventSequence) return false;
    if (this.state.view && event.runRevision < this.state.view.revision) return false;

    let next = {
      ...this.state,
      lastEventId: event.eventId,
      lastEventSequence: event.sequence,
    };
    if (event.type === 'run.view.updated') {
      const view = event.payload as ThetaRunViewV3;
      if (view.runId !== event.runId || view.revision !== event.runRevision) return false;
      next = { ...next, view };
    } else if (event.type === 'conversation.message.created') {
      const message = event.payload as ConversationMessage;
      const byId = new Map(next.messages.map((item) => [item.messageId, item]));
      byId.set(message.messageId, message);
      next = { ...next, messages: [...byId.values()].sort((a, b) => a.sequence - b.sequence) };
    } else if (isViewPatch(event.payload)) {
      const current = next.view;
      if (current) {
        next = {
          ...next,
          view: { ...current, ...event.payload.view, revision: event.runRevision },
        };
      }
    }
    this.replace(next);
    return true;
  }

  private replace(next: RunViewState): void {
    this.state = next;
    for (const listener of this.listeners) listener(this.state);
  }
}

const commandRank = (status: CommandReceipt['status']): number => ({
  accepted: 0,
  running: 1,
  waiting_user: 2,
  completed: 3,
  failed: 3,
})[status];

const isViewPatch = (value: unknown): value is { view: Partial<ThetaRunViewV3> } =>
  Boolean(value && typeof value === 'object' && 'view' in value);
