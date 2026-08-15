import { hashCanonicalJson } from '@hypha/core';
import type { ThetaWorkspace } from './contracts.js';

type HashableWorkspace = Omit<ThetaWorkspace, 'workspaceHash' | 'updatedAt'>;

export const thetaWorkspaceHash = (workspace: HashableWorkspace): string =>
  hashCanonicalJson(workspace);

export const assertThetaWorkspaceHash = (workspace: ThetaWorkspace): void => {
  const { workspaceHash, updatedAt: _updatedAt, ...hashable } = workspace;
  const actual = thetaWorkspaceHash(hashable as HashableWorkspace);
  if (workspaceHash !== actual) {
    throw new Error(`Workspace hash mismatch: expected ${workspaceHash}, received ${actual}.`);
  }
};
