export interface ThetaConversationMessage {
  messageId: string;
  runId: string;
  userId: string;
  role: 'user' | 'assistant';
  content: string;
  contentHash: string;
  createdAt: string;
  replyToMessageId?: string;
}

export interface ConversationDigest {
  runId: string;
  messageCount: number;
  messages: ThetaConversationMessage[];
}
