import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SQLiteDurableEventStore,
  SQLiteProjectionStore,
  SQLiteReActContinuationCheckpointStore,
  SQLiteRunLeaseStore,
  SQLiteStateExecutionClaimStore,
} from '@hypha/adapters-local';
import {
  DurableEventRuntime,
  InMemoryEventSchemaRegistry,
  ProjectionEngine,
  RuntimeHumanWaitService,
  registerRuntimeOrchestrationEventSchemas,
  type RuntimeOrchestrationProjection,
} from '@hypha/core';
import { DurableEventStoreBridge } from '@hypha/harness';
import { GovernedToolRunner, registerToolRuntimeEventSchemas } from '@hypha/tools';
import { createThetaHyphaToolRegistry } from '../tools/hypha-registry.js';
import { thetaV6PolicyEngine } from '../tools/policy-engine.js';
import { registerThetaWorkspaceEventSchemas } from '../workspaces/event-schemas.js';
import { registerThetaConversationEventSchemas } from '../messages/event-schemas.js';
import { registerThetaCheckpointEventSchemas } from '../checkpoints/event-schemas.js';
import { ThetaMemoryComposition } from '../memory/theta-memory-composition.js';
import { ThetaGovernedMemoryService } from '../memory/theta-memory-service.js';
import { registerThetaPlannerEventSchemas } from '../planner-v3/event-schemas.js';
import { registerThetaActivityEventSchemas } from '../activities/event-schemas.js';
import { registerThetaExecutionEventSchemas } from '../execution/event-schemas.js';

export interface ThetaRuntimeComposition {
  filename: string;
  events: DurableEventRuntime;
  projections: ProjectionEngine;
  projectionStore: SQLiteProjectionStore<RuntimeOrchestrationProjection>;
  runLeases: SQLiteRunLeaseStore;
  stateClaims: SQLiteStateExecutionClaimStore;
  reactCheckpoints: SQLiteReActContinuationCheckpointStore;
  eventBridge: DurableEventStoreBridge;
  toolRegistry: ReturnType<typeof createThetaHyphaToolRegistry>;
  toolRunner: GovernedToolRunner;
  humanWaits: RuntimeHumanWaitService;
  memoryComposition?: ThetaMemoryComposition;
  memory?: ThetaGovernedMemoryService;
  close(): Promise<void>;
}

export const defaultThetaV6RuntimeDb = (): string =>
  path.resolve(
    process.env.THETA_AGENT_EVENT_DB ?? path.join(process.cwd(), '.theta_agent', 'theta-agent-v3.sqlite'),
  );

export const createThetaRuntimeComposition = async (
  filename = defaultThetaV6RuntimeDb(),
  options: { memory?: boolean } = {},
): Promise<ThetaRuntimeComposition> => {
  const resolved = path.resolve(filename);
  const schemas = new InMemoryEventSchemaRegistry();
  await registerRuntimeOrchestrationEventSchemas(schemas);
  await registerToolRuntimeEventSchemas(schemas);
  await registerThetaWorkspaceEventSchemas(schemas);
  await registerThetaConversationEventSchemas(schemas);
  await registerThetaCheckpointEventSchemas(schemas);
  await registerThetaPlannerEventSchemas(schemas);
  await registerThetaActivityEventSchemas(schemas);
  await registerThetaExecutionEventSchemas(schemas);
  const eventStore = new SQLiteDurableEventStore({ filename: resolved, schemaRegistry: schemas });
  const events = new DurableEventRuntime({ store: eventStore });
  const projectionStore = new SQLiteProjectionStore<RuntimeOrchestrationProjection>({ filename: resolved });
  const projections = new ProjectionEngine({ events });
  const runLeases = new SQLiteRunLeaseStore({ filename: resolved });
  const stateClaims = new SQLiteStateExecutionClaimStore({ filename: resolved, runLeaseStore: runLeases });
  const reactCheckpoints = new SQLiteReActContinuationCheckpointStore({ filename: resolved });
  const eventBridge = new DurableEventStoreBridge({
    events,
    coordination: {
      runLeases,
      ownerId: 'theta-v6-run-manager',
      leaseTtlMs: 30_000,
      nextId: (namespace) => `${namespace}.${randomUUID()}`,
    },
  });
  const humanWaits = new RuntimeHumanWaitService({
    events,
    projections,
    projectionStore,
    runLeases,
    nextId: (namespace) => `${namespace}.${randomUUID()}`,
  });
  const toolRegistry = createThetaHyphaToolRegistry();
  const toolRunner = new GovernedToolRunner(toolRegistry, eventBridge, thetaV6PolicyEngine);
  const memoryComposition = options.memory === true
    ? await ThetaMemoryComposition.create()
    : undefined;
  const memory = memoryComposition === undefined
    ? undefined
    : new ThetaGovernedMemoryService(memoryComposition.service, memoryComposition.workingStore);
  let closed = false;
  return {
    filename: resolved,
    events,
    projections,
    projectionStore,
    runLeases,
    stateClaims,
    reactCheckpoints,
    eventBridge,
    toolRegistry,
    toolRunner,
    humanWaits,
    ...(memoryComposition === undefined ? {} : { memoryComposition }),
    ...(memory === undefined ? {} : { memory }),
    close: async () => {
      if (closed) return;
      closed = true;
      reactCheckpoints.close();
      stateClaims.close();
      runLeases.close();
      projectionStore.close();
      eventStore.close();
      await memoryComposition?.close();
    },
  };
};
