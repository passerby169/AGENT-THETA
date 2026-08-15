import { randomUUID } from 'node:crypto';
import { createFrameworkEvent, hashCanonicalJson, type EventStore, type FrameworkEvent } from '@hypha/core';
import type { ConversationDigest, ThetaConversationMessage } from './contracts.js';
import { THETA_CONVERSATION_EVENT_TYPE } from './event-schemas.js';

export interface AppendConversationMessageRequest {
  runId: string;
  sessionId: string;
  userId: string;
  role: ThetaConversationMessage['role'];
  content: string;
  messageId?: string;
  replyToMessageId?: string;
}

export class ThetaConversationEventRepository {
  constructor(
    private readonly events: EventStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async append(request: AppendConversationMessageRequest): Promise<ThetaConversationMessage> {
    const content = request.content.trim();
    if (!content) throw new Error('Conversation message content is required.');
    const messageId = request.messageId?.trim() || `message:${randomUUID()}`;
    const existing = (await this.list(request.runId)).find((message) => message.messageId === messageId);
    if (existing) {
      if (existing.content !== content || existing.role !== request.role || existing.userId !== request.userId) {
        throw new Error(`Conversation message id was reused with different content: ${messageId}.`);
      }
      return existing;
    }
    const message: ThetaConversationMessage = {
      messageId,
      runId: request.runId,
      userId: request.userId,
      role: request.role,
      content,
      contentHash: hashCanonicalJson({ runId: request.runId, userId: request.userId, role: request.role, content }),
      createdAt: this.now(),
      ...(request.replyToMessageId === undefined ? {} : { replyToMessageId: request.replyToMessageId }),
    };
    await this.events.append(createFrameworkEvent({
      id: `theta-message:${request.runId}:${randomUUID()}`,
      type: THETA_CONVERSATION_EVENT_TYPE,
      version: '1.0.0',
      runId: request.runId,
      sessionId: request.sessionId,
      userId: request.userId,
      timestamp: message.createdAt,
      payload: { kind: 'theta.conversation.message.appended', message },
      metadata: { messageId, role: request.role },
    }));
    return message;
  }

  async list(runId: string): Promise<ThetaConversationMessage[]> {
    return projectConversationMessages(await this.events.list({ runId }));
  }

  async require(runId: string, messageId: string): Promise<ThetaConversationMessage> {
    const message = (await this.list(runId)).find((candidate) => candidate.messageId === messageId);
    if (!message) throw new Error(`Conversation message was not found: ${messageId}.`);
    return message;
  }

  async digest(runId: string, limit = 30): Promise<ConversationDigest> {
    const all = await this.list(runId);
    return { runId, messageCount: all.length, messages: all.slice(-Math.max(1, limit)) };
  }
}

export const projectConversationMessages = (
  events: readonly FrameworkEvent[],
): ThetaConversationMessage[] => events
  .filter((event) => event.type === THETA_CONVERSATION_EVENT_TYPE)
  .map((event) => record(event.payload).message)
  .filter((value): value is ThetaConversationMessage => isMessage(value))
  .map((message) => structuredClone(message));

const isMessage = (value: unknown): value is ThetaConversationMessage => {
  const candidate = record(value);
  return typeof candidate.messageId === 'string' &&
    typeof candidate.runId === 'string' &&
    typeof candidate.userId === 'string' &&
    (candidate.role === 'user' || candidate.role === 'assistant') &&
    typeof candidate.content === 'string' &&
    typeof candidate.contentHash === 'string' &&
    typeof candidate.createdAt === 'string';
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
