import type { ManagedMemoryScope, MemoryPrincipal } from '@hypha/memory';
import { THETA_DOMAIN_PACK_ID } from '../domain-v6/workflow-states.js';

export const THETA_AGENT_ID = 'agent.theta.research-training';

export interface ThetaMemoryIdentity {
  userId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
}

export const thetaMemoryScope = (identity: ThetaMemoryIdentity): ManagedMemoryScope => ({
  userId: identity.userId,
  workspaceId: identity.workspaceId,
  sessionId: identity.sessionId,
  runId: identity.runId,
  agentId: THETA_AGENT_ID,
  domainPackId: THETA_DOMAIN_PACK_ID,
});

export const thetaMemoryPrincipal = (identity: ThetaMemoryIdentity): MemoryPrincipal => ({
  principalId: identity.userId,
  type: 'user',
  userId: identity.userId,
  agentId: THETA_AGENT_ID,
  permissionScopes: ['theta:memory:read', 'theta:memory:write'],
  metadata: { workspaceId: identity.workspaceId },
});
