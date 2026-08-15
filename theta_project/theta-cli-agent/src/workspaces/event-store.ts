import { randomUUID } from 'node:crypto';
import {
  createFrameworkEvent,
  hashCanonicalJson,
  type EventStore,
  type FrameworkEvent,
} from '@hypha/core';
import type { ThetaWorkspace, ThetaWorkspaceDraft, ThetaWorkspaceType } from './contracts.js';
import { thetaWorkspaceHash, assertThetaWorkspaceHash } from './hash.js';
import { validateWorkspaceProvenance } from './provenance-validator.js';
import { THETA_WORKSPACE_EVENT_TYPE } from './event-schemas.js';

export const THETA_WORKSPACE_EVENT_TYPES = {
  transport: THETA_WORKSPACE_EVENT_TYPE,
  revised: 'theta.workspace.revised',
  invalidated: 'theta.workspace.downstream_invalidated',
} as const;

export interface WorkspaceRevisionRequest {
  runId: string;
  sessionId?: string;
  userId: string;
  expectedRevision: number;
  draft: ThetaWorkspaceDraft;
  reason: string;
  invalidates?: Array<'checkpoint' | 'plan' | 'approval' | 'dry_run' | 'training_approval'>;
}

export class ThetaWorkspaceEventRepository {
  constructor(
    private readonly events: EventStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async current(runId: string, workspaceType: ThetaWorkspaceType): Promise<ThetaWorkspace | null> {
    return projectWorkspace(await this.events.list({ runId }), workspaceType);
  }

  async revise(request: WorkspaceRevisionRequest): Promise<ThetaWorkspace> {
    const current = await this.current(request.runId, request.draft.workspaceType);
    const actualRevision = current?.revision ?? 0;
    if (actualRevision !== request.expectedRevision) {
      throw new Error(
        `Workspace revision conflict for ${request.draft.workspaceType}: expected ${request.expectedRevision}, actual ${actualRevision}.`,
      );
    }
    const revision = actualRevision + 1;
    const updatedAt = this.now();
    const hashable = { ...structuredClone(request.draft), revision };
    const workspace = {
      ...hashable,
      workspaceHash: thetaWorkspaceHash(hashable as Omit<ThetaWorkspace, 'workspaceHash' | 'updatedAt'>),
      updatedAt,
    } as ThetaWorkspace;
    assertWorkspace(request, workspace);
    await this.events.append(
      createFrameworkEvent({
        id: `theta-workspace:${request.runId}:${workspace.workspaceType}:${revision}:${randomUUID()}`,
        type: THETA_WORKSPACE_EVENT_TYPES.transport,
        runId: request.runId,
        sessionId: request.sessionId,
        userId: request.userId,
        timestamp: updatedAt,
        payload: {
          kind: THETA_WORKSPACE_EVENT_TYPES.revised,
          workspace,
          reason: request.reason,
          previousWorkspaceHash: current?.workspaceHash,
        },
        metadata: { userId: request.userId, workspaceType: workspace.workspaceType },
      }),
    );
    if (request.invalidates?.length) {
      await this.events.append(
        createFrameworkEvent({
          id: `theta-workspace-invalidation:${request.runId}:${workspace.workspaceType}:${revision}:${randomUUID()}`,
          type: THETA_WORKSPACE_EVENT_TYPES.transport,
          runId: request.runId,
          sessionId: request.sessionId,
          userId: request.userId,
          timestamp: updatedAt,
          payload: {
            kind: THETA_WORKSPACE_EVENT_TYPES.invalidated,
            causedByWorkspaceType: workspace.workspaceType,
            causedByWorkspaceHash: workspace.workspaceHash,
            invalidatedKinds: request.invalidates,
          },
          metadata: { userId: request.userId },
        }),
      );
    }
    return workspace;
  }
}

export const projectWorkspace = (
  events: readonly FrameworkEvent[],
  workspaceType: ThetaWorkspaceType,
): ThetaWorkspace | null => {
  let current: ThetaWorkspace | null = null;
  for (const event of events) {
    if (event.type !== THETA_WORKSPACE_EVENT_TYPES.transport) continue;
    if (recordValue(event.payload, 'kind') !== THETA_WORKSPACE_EVENT_TYPES.revised) continue;
    const workspace = workspaceFromEvent(event);
    if (!workspace || workspace.workspaceType !== workspaceType) continue;
    if (current && workspace.revision !== current.revision + 1) {
      throw new Error(`Workspace event stream is not contiguous for ${workspaceType}.`);
    }
    assertThetaWorkspaceHash(workspace);
    current = workspace;
  }
  return current;
};

export const workspaceProjectionDigest = (
  events: readonly FrameworkEvent[],
  workspaceType: ThetaWorkspaceType,
): string => hashCanonicalJson(projectWorkspace(events, workspaceType));

const workspaceFromEvent = (event: FrameworkEvent): ThetaWorkspace | null => {
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return null;
  const workspace = (event.payload as Record<string, unknown>).workspace;
  if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return null;
  return structuredClone(workspace) as ThetaWorkspace;
};

const assertWorkspace = (request: WorkspaceRevisionRequest, workspace: ThetaWorkspace): void => {
  if (workspace.runId !== request.runId) throw new Error('Workspace runId does not match request.');
  if (workspace.datasetHash.trim().length === 0) throw new Error('Workspace datasetHash is required.');
  if ('narrative' in workspace && workspace.narrative.trim().length === 0) throw new Error('Workspace narrative must be non-empty.');
  const issues = validateWorkspaceProvenance(workspace);
  if (issues.length > 0) {
    throw new Error(`Workspace provenance is invalid: ${issues.map((issue) => issue.code).join(', ')}`);
  }
  assertThetaWorkspaceHash(workspace);
};

const recordValue = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
