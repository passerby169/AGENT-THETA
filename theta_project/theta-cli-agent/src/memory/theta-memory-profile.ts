import type { ContextProfileSpec, MemoryProfileSpec, MemoryRuntimeConfig } from '@hypha/memory';

export const THETA_MEMORY_PROFILE_ID = 'theta-native-default';
export const THETA_MEMORY_PROFILE_REVISION = 'theta-native-default-v1';
export const THETA_CONTEXT_PROFILE_ID = 'context.theta.reality.v1';
export const THETA_CONTEXT_PROFILE_REVISION = 'context-theta-reality-v1';

const capabilities = {
  add: true,
  search: true,
  get: true,
  list: true,
  update: true,
  delete: true,
  deleteByFilter: true,
  history: true,
  summarize: false,
  consolidate: false,
  decay: false,
  reinforce: false,
  conflictDetection: true,
  hybridSearch: true,
  graphRelations: false,
  asyncWrite: true,
  batchOperations: true,
} as const;

export const thetaMemoryProfile: MemoryProfileSpec = {
  id: THETA_MEMORY_PROFILE_ID,
  version: '1.0.0',
  revision: THETA_MEMORY_PROFILE_REVISION,
  name: 'THETA Hypha Native Memory',
  enabled: true,
  managementProviderRef: { id: 'memory.provider.theta-native', version: '1.0.0' },
  workingStoreRef: { id: 'memory.store.working.redis', version: '1.0.0' },
  recordStoreRef: { id: 'memory.store.record.mongodb', version: '1.0.0' },
  vectorStoreRefs: [{ id: 'memory.vector.local', version: '1.0.0' }],
  artifactStoreRef: { id: 'memory.artifact.local', version: '1.0.0' },
  embeddingProviderRef: { id: 'memory.embedding.local', version: '1.0.0' },
  contextProfileRef: {
    id: THETA_CONTEXT_PROFILE_ID,
    version: '1.0.0',
    revision: THETA_CONTEXT_PROFILE_REVISION,
  },
  scopePolicy: {
    requiredDimensions: ['userId'],
    allowedReadScopes: ['userId', 'workspaceId', 'sessionId', 'runId', 'agentId', 'domainPackId'],
    allowedWriteScopes: ['userId', 'workspaceId', 'sessionId', 'runId', 'agentId', 'domainPackId'],
    crossUserRead: 'deny',
    crossWorkspaceRead: 'deny',
    enforceTenantBoundary: true,
  },
  retrievalPolicy: {
    defaultMode: 'hybrid',
    maxCandidates: 100,
    defaultTopK: 12,
    recencyWeight: 0.2,
    importanceWeight: 0.15,
    confidenceWeight: 0.2,
    reinforcementWeight: 0.05,
    deduplication: 'hash',
    conflictHandling: 'prefer_verified',
    rerank: 'score_fusion',
  },
  writePolicy: {
    allowedTypes: ['working', 'episodic', 'semantic', 'procedural', 'preference', 'artifact'],
    deduplicateBeforeWrite: true,
    conflictDetection: true,
    maxContentBytes: 256 * 1024,
    sensitiveDataMode: 'reject',
  },
  retentionPolicy: {
    ttlByType: { working: 86_400 },
    retainHistory: true,
    maxVersions: 50,
    legalHoldSupported: true,
    deletionMode: 'soft',
  },
  conflictPolicy: {
    detectOnWrite: true,
    matchingMode: 'same_key',
    resolution: 'prefer_latest',
    markRelations: true,
  },
  fallbackPolicy: {
    onProviderUnavailable: 'fail',
    onVectorUnavailable: 'structured_only',
    onRerankerUnavailable: 'score_fusion',
    maxFallbackDepth: 1,
  },
  indexingPolicy: {
    mode: 'async_outbox',
    batchSize: 25,
    maxAttempts: 5,
    retryDelayMs: 1_000,
    deadLetterAfterAttempts: 5,
    rebuildable: true,
  },
  metadata: { owner: 'theta-cli-agent', topology: 'mongodb-redis-local' },
};

export const thetaMemoryRuntimeConfig: MemoryRuntimeConfig = {
  activeProfile: THETA_MEMORY_PROFILE_ID,
  profiles: {
    [THETA_MEMORY_PROFILE_ID]: {
      profile: thetaMemoryProfile,
      management: {
        id: 'memory.provider.theta-native',
        version: '1.0.0',
        revision: THETA_MEMORY_PROFILE_REVISION,
        type: 'native',
        deployment: 'local',
        connectionRef: 'memory.connection.theta-native',
        config: {
          workingStoreRef: 'memory.store.working.redis',
          recordStoreRef: 'memory.store.record.mongodb',
          vectorStoreRef: 'memory.vector.local',
          embeddingProviderRef: 'memory.embedding.local',
          outboxStoreRef: 'memory.store.outbox.mongodb',
        },
        capabilities,
        timeoutPolicy: { timeoutMs: 15_000 },
        metadata: { persistence: 'durable', coordination: 'redis' },
      },
    },
  },
};

export const thetaRealityContextProfile: ContextProfileSpec = {
  id: THETA_CONTEXT_PROFILE_ID,
  version: '1.0.0',
  revision: THETA_CONTEXT_PROFILE_REVISION,
  name: 'THETA Reality Context',
  sources: [
    { id: 'theta.system', type: 'system', required: true, priority: 100, maxItems: 2, maxTokens: 3_000, overflowPolicy: 'fail' },
    { id: 'theta.workflow', type: 'workflow_state', required: true, priority: 98, maxItems: 2, maxTokens: 3_000, overflowPolicy: 'truncate' },
    { id: 'theta.workspace', type: 'custom', required: true, priority: 96, maxItems: 4, maxTokens: 8_000, overflowPolicy: 'truncate' },
    { id: 'theta.messages', type: 'messages', priority: 92, maxItems: 20, maxTokens: 8_000, overflowPolicy: 'truncate' },
    { id: 'theta.working', type: 'working_memory', priority: 82, maxItems: 12, maxTokens: 4_000, overflowPolicy: 'drop' },
    { id: 'theta.durable', type: 'long_term_memory', priority: 84, maxItems: 12, maxTokens: 6_000, overflowPolicy: 'drop' },
    { id: 'theta.observations', type: 'tool_observation', priority: 75, maxItems: 8, maxTokens: 4_000, overflowPolicy: 'drop' },
  ],
  maxItems: 48,
  maxCharacters: 100_000,
  maxSerializedBytes: 300_000,
  maxTokens: 32_000,
  reservedOutputTokens: 4_000,
  reservedSystemTokens: 2_000,
  deduplication: 'hash',
  ranking: { method: 'score_fusion', relevanceWeight: 8, recencyWeight: 2, importanceWeight: 2, confidenceWeight: 2, provenanceWeight: 2 },
  truncation: { method: 'hybrid', preserveRequiredSources: true, preserveLatestMessages: 8, minItemTokens: 32, truncationMarker: '\n[context truncated]' },
  conflictPolicy: 'prefer_verified',
  includeProvenance: true,
  includeScores: true,
  instructionBoundary: 'strict',
  untrustedContentPolicy: 'tag',
  compactionPolicy: { enabled: true, triggerRatio: 0.78, preserveLastMessages: 8, persistSummaryAsMemory: false },
  metadata: { owner: 'theta-cli-agent', realityScoped: true },
};
