import { hashCanonicalJson, type EventSchemaRegistry, type JsonSchema } from '@hypha/core';

export const THETA_CONVERSATION_EVENT_TYPE = 'runtime.observation.theta-conversation';
export const THETA_CONVERSATION_EVENT_SCHEMA_VERSION = '1.0.0';

const schema: JsonSchema = {
  type: 'object',
  required: ['kind', 'message'],
  properties: {
    kind: { const: 'theta.conversation.message.appended' },
    message: { type: 'object', additionalProperties: true },
  },
  additionalProperties: false,
};

export const registerThetaConversationEventSchemas = async (
  registry: EventSchemaRegistry,
): Promise<void> => {
  await registry.register({
    eventType: THETA_CONVERSATION_EVENT_TYPE,
    version: THETA_CONVERSATION_EVENT_SCHEMA_VERSION,
    schema,
    schemaHash: hashCanonicalJson(schema),
    sensitivePaths: ['/message/content'],
  });
};
