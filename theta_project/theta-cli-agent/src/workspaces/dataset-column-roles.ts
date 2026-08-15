import type { DatasetColumnRole, DatasetWorkspace, WorkspaceSourceRef } from './contracts.js';

export const isPrimaryTextRole = (role: Pick<DatasetColumnRole, 'proposedRole'>): boolean => {
  const normalized = role.proposedRole.trim().toLowerCase().replace(/[\s-]+/gu, '_');
  return normalized === 'text' || normalized === 'primary_text' || normalized.includes('primary_text');
};

export const primaryTextCandidates = (workspace: DatasetWorkspace): DatasetColumnRole[] =>
  workspace.columnRoles.filter(isPrimaryTextRole);

export const isConfirmedColumnRole = (role: DatasetColumnRole): boolean =>
  role.epistemicStatus === 'user_confirmed' ||
  // Backward compatibility is intentionally limited to old, exact-confidence
  // records. New tool output always carries epistemicStatus=proposed.
  (role.epistemicStatus === undefined && role.confidence === 1);

export const confirmedPrimaryTextColumns = (workspace: DatasetWorkspace): string[] =>
  primaryTextCandidates(workspace).filter(isConfirmedColumnRole).map((role) => role.column);

export const hasUniqueConfirmedPrimaryTextColumn = (workspace: DatasetWorkspace): boolean =>
  primaryTextCandidates(workspace).length === 1 && confirmedPrimaryTextColumns(workspace).length === 1;

export const confirmUniquePrimaryTextRole = (
  workspace: DatasetWorkspace,
  source: WorkspaceSourceRef,
): Omit<DatasetWorkspace, 'revision' | 'workspaceHash' | 'updatedAt'> => {
  const candidates = primaryTextCandidates(workspace);
  if (candidates.length !== 1) {
    throw new Error(`DatasetWorkspace requires exactly one primary text candidate before confirmation; found ${candidates.length}.`);
  }
  const sourceRefs = workspace.sourceRefs.some((item) => item.id === source.id)
    ? workspace.sourceRefs
    : [...workspace.sourceRefs, source];
  return {
    workspaceType: 'dataset',
    schemaVersion: workspace.schemaVersion,
    runId: workspace.runId,
    datasetHash: workspace.datasetHash,
    narrative: workspace.narrative,
    statements: workspace.statements,
    columnRoles: workspace.columnRoles.map((role) => isPrimaryTextRole(role)
      ? {
          ...role,
          confidence: 1,
          epistemicStatus: 'user_confirmed',
          sourceRefs: [...new Set([...role.sourceRefs, source.id])],
        }
      : role),
    risks: workspace.risks,
    sourceRefs,
  };
};
