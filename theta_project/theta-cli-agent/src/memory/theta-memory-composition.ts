import { MongoClient, type Db } from 'mongodb';
import { Redis } from 'ioredis';
import {
  DefaultContextInjectionGateway,
  DefaultMemoryContextBuilder,
  InMemoryLocalVectorStoreAdapter,
  MemoryManagementProviderRegistry,
  MemoryRuntimeFactory,
  MongoStructuredStoreProvider,
  createNativeMemoryManagementProviderFactory,
  type EmbeddingProvider,
  type MemoryApplicationService,
  type MemoryEventPublisher,
  type MemoryRuntime,
  type MemoryRuntimeCompositionReceipt,
  type MongoDatabaseLike,
  type NativeMemoryRuntimeResources,
  type ProviderHealth,
  type RedisLikeWorkingMemoryClient,
  type WorkingMemoryStore,
} from '@hypha/memory';
import { thetaMemoryRuntimeConfig } from './theta-memory-profile.js';

export interface ThetaMemoryCompositionOptions {
  mongoUri?: string;
  mongoDatabase?: string;
  redisUrl?: string;
  workingMemoryNamespace?: string;
  ownerId?: string;
  events?: MemoryEventPublisher;
}

export interface ThetaMemoryReadiness {
  ready: boolean;
  receipt: MemoryRuntimeCompositionReceipt;
  provider: ProviderHealth;
  working: ProviderHealth;
}

export class ThetaMemoryComposition {
  private constructor(
    private readonly runtime: MemoryRuntime,
    private readonly mongo: MongoClient,
    private readonly redis: Redis,
    readonly workingStore: WorkingMemoryStore,
  ) {}

  static async create(options: ThetaMemoryCompositionOptions = {}): Promise<ThetaMemoryComposition> {
    const mongoUri = options.mongoUri ?? process.env.MONGODB_URI?.trim() ??
      'mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true';
    const mongoDatabase = options.mongoDatabase ?? process.env.MONGODB_DATABASE?.trim() ?? 'theta_memory';
    const redisUrl = options.redisUrl ?? process.env.REDIS_URL?.trim() ?? 'redis://127.0.0.1:6379/0';
    const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 5_000,
      enableReadyCheck: true,
    });
    try {
      await mongo.connect();
      await redis.connect();
      await Promise.all([
        mongo.db(mongoDatabase).command({ ping: 1 }),
        redis.ping(),
      ]);
      const database = mongo.db(mongoDatabase);
      const structuredStore = new MongoStructuredStoreProvider({
        database: mongoDatabaseLike(database, mongo),
        collectionPrefix: 'theta_memory_',
        transactionMode: 'required',
      });
      const vectorStore = new InMemoryLocalVectorStoreAdapter('memory.vector.local');
      const registry = new MemoryManagementProviderRegistry().register(
        createNativeMemoryManagementProviderFactory({
          structuredStore,
          redisClient: redis as unknown as RedisLikeWorkingMemoryClient,
          embeddingProvider: new ThetaDeterministicEmbeddingProvider(),
          vectorStores: [vectorStore],
          ownerId: options.ownerId ?? `theta:${process.pid}`,
          workingMemoryNamespace: options.workingMemoryNamespace ?? 'theta:memory:working',
          workingMemoryTtlSeconds: 86_400,
          events: options.events ?? localMemoryEvents(),
        }),
      );
      const factory = new MemoryRuntimeFactory({
        registry,
        contextBuilder: new DefaultMemoryContextBuilder(),
        contextGateway: new DefaultContextInjectionGateway(),
        activities: {
          policy: {
            authorize: async (request) => ({
              allowed: !request.principal.userId || request.principal.userId === request.scope.userId,
              reason: request.principal.userId && request.principal.userId !== request.scope.userId
                ? 'Memory principal does not own the requested scope.'
                : undefined,
              policyRevision: 'policy.theta.memory.v1',
            }),
          },
          events: options.events ?? localMemoryEvents(),
          harness: { beforeExecute: async () => undefined, afterExecute: async () => undefined },
        },
        eventContext: (request) => ({
          runId: request.scope.runId ?? request.operationId,
          sessionId: request.scope.sessionId,
          workspaceId: request.scope.workspaceId,
          agentId: request.scope.agentId,
        }),
      });
      const runtime = await factory.create(thetaMemoryRuntimeConfig);
      const resources = runtime.resources as NativeMemoryRuntimeResources | undefined;
      if (!resources?.workingStore) throw new Error('Hypha Native Memory did not install Redis Working Memory.');
      return new ThetaMemoryComposition(runtime, mongo, redis, resources.workingStore);
    } catch (error) {
      await Promise.allSettled([mongo.close(), redis.quit()]);
      throw error;
    }
  }

  get service(): MemoryApplicationService {
    return this.runtime.service;
  }

  get receipt(): MemoryRuntimeCompositionReceipt {
    return this.runtime.compositionReceipt;
  }

  async health(): Promise<ThetaMemoryReadiness> {
    const [provider, working] = await Promise.all([
      this.runtime.service.providerHealth(),
      this.workingStore.health(),
    ]);
    return {
      ready: provider.status !== 'unhealthy' && working.status !== 'unhealthy',
      receipt: this.runtime.compositionReceipt,
      provider,
      working,
    };
  }

  async close(): Promise<void> {
    await this.runtime.close();
    await Promise.allSettled([this.mongo.close(), this.redis.quit()]);
  }
}

const mongoDatabaseLike = (database: Db, client: MongoClient): MongoDatabaseLike => ({
  collection: (name) => database.collection(name) as never,
  startSession: () => client.startSession() as never,
  command: (command) => database.command(command),
});

class ThetaDeterministicEmbeddingProvider implements EmbeddingProvider {
  async embed(inputs: string[]): Promise<number[][]> {
    return inputs.map((input) => deterministicVector(input));
  }
}

const deterministicVector = (input: string): number[] => {
  const values = Array.from({ length: 64 }, () => 0);
  for (let index = 0; index < input.length; index += 1) {
    values[index % values.length] += input.charCodeAt(index) / 65_535;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? values : values.map((value) => value / norm);
};

let memoryEventSequence = 0;
const localMemoryEvents = (): MemoryEventPublisher => ({
  publish: async (type, _payload, context) =>
    `theta-memory:${context.runId}:${type}:${++memoryEventSequence}`,
});
