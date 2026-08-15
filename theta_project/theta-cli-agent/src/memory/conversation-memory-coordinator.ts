import type { ThetaIntelligentPhase } from '../agent-runtime/contracts.js';
import {
  ThetaConversationEventRepository,
  type AppendConversationMessageRequest,
} from '../messages/message-event-store.js';
import type { ThetaConversationMessage } from '../messages/contracts.js';
import type { ThetaMemoryIdentity } from './theta-memory-scope.js';
import {
  ThetaGovernedMemoryService,
  type PhaseHandoffMemory,
} from './theta-memory-service.js';

export class ConversationMemoryCoordinator {
  constructor(
    private readonly messages: ThetaConversationEventRepository,
    private readonly memory: ThetaGovernedMemoryService,
    private readonly identity: ThetaMemoryIdentity,
  ) {}

  async append(
    phase: ThetaIntelligentPhase,
    request: AppendConversationMessageRequest,
  ): Promise<ThetaConversationMessage> {
    const message = await this.messages.append(request);
    await this.memory.rememberMessage(this.identity, phase, message);
    return message;
  }

  async synchronize(
    phase: ThetaIntelligentPhase,
    messages: ThetaConversationMessage[],
  ): Promise<void> {
    for (const message of messages) await this.memory.rememberMessage(this.identity, phase, message);
  }

  async handoff(
    request: Omit<PhaseHandoffMemory, 'messages' | 'conversationRevision'> & {
      messages?: ThetaConversationMessage[];
    },
  ): Promise<void> {
    const messages = request.messages ?? await this.messages.list(this.identity.runId);
    await this.memory.rememberPhaseHandoff(this.identity, {
      ...request,
      messages,
      conversationRevision: messages.length,
    });
  }
}
