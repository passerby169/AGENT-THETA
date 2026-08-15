export const THETA_WORKSPACE_SCHEMA_VERSION = '3.1.0' as const;
export type EpistemicStatus = 'observed' | 'user_stated' | 'inferred' | 'proposed' | 'user_confirmed';
export interface WorkspaceSourceRef { id: string; kind: 'tool_observation' | 'user_message' | 'user_decision' | 'agent_decision' | 'artifact'; hash: string; }
export interface DatasetStatement { id: string; semanticLabel: string; statement: string; epistemicStatus: EpistemicStatus; confidence: number; sourceRefs: string[]; supersedes?: string[]; }
export interface DatasetColumnRole {
  column: string;
  proposedRole: string;
  confidence: number;
  sourceRefs: string[];
  /**
   * Older persisted workspaces do not contain this field. New dataset
   * observations are always `proposed`; only an explicit user correction or
   * acceptance of the Agent's recommendation may promote a role.
   */
  epistemicStatus?: EpistemicStatus;
}
export interface DatasetWorkspace {
  workspaceType: 'dataset'; schemaVersion: typeof THETA_WORKSPACE_SCHEMA_VERSION; runId: string; datasetHash: string; revision: number;
  narrative: string; statements: DatasetStatement[];
  columnRoles: DatasetColumnRole[];
  risks: string[]; sourceRefs: WorkspaceSourceRef[]; workspaceHash: string; updatedAt: string;
}
export interface ResearchStatement { id: string; semanticLabel: string; statement: string; importance: 'blocking' | 'important' | 'optional'; epistemicStatus: EpistemicStatus; confidence: number; sourceRefs: string[]; supersedes?: string[]; }
export interface AgentOpenQuestion { id: string; question: string; whyItMatters: string; status: 'open' | 'answered' | 'declined' | 'superseded'; blocking: boolean; sourceRefs: string[]; }
export interface AgentAssumption { id: string; statement: string; status: 'proposed' | 'accepted' | 'rejected' | 'superseded'; sourceRefs: string[]; }
export interface AgentContradiction { id: string; statementRefs: string[]; description: string; status: 'open' | 'resolved' | 'accepted_risk'; resolution?: string; }
export interface AgentDecisionRecord { id: string; decision: string; rationale: string; status: 'proposed' | 'accepted' | 'rejected' | 'superseded'; sourceRefs: string[]; }
export interface UserPreference { id: string; preference: string; sourceRefs: string[]; }
export interface ResearchBoundary { id: string; boundary: string; sourceRefs: string[]; }
export interface ResearchWorkspace { workspaceType: 'research'; schemaVersion: typeof THETA_WORKSPACE_SCHEMA_VERSION; runId: string; datasetHash: string; revision: number; narrative: string; statements: ResearchStatement[]; questions: AgentOpenQuestion[]; assumptions: AgentAssumption[]; contradictions: AgentContradiction[]; decisions: AgentDecisionRecord[]; preferences: UserPreference[]; boundaries: ResearchBoundary[]; sourceRefs: WorkspaceSourceRef[]; workspaceHash: string; updatedAt: string; }
export interface PlanWorkspace { workspaceType: 'plan'; schemaVersion: typeof THETA_WORKSPACE_SCHEMA_VERSION; runId: string; datasetHash: string; researchWorkspaceHash: string; revision: number; candidateRefs: string[]; activeCandidateRef?: string; validationReceiptRefs: string[]; evidenceRefs: string[]; sourceRefs: WorkspaceSourceRef[]; workspaceHash: string; updatedAt: string; }
export type ThetaWorkspace = DatasetWorkspace | ResearchWorkspace | PlanWorkspace;
export type ThetaWorkspaceType = ThetaWorkspace['workspaceType'];
export type ThetaWorkspaceDraft = Omit<DatasetWorkspace, 'revision' | 'workspaceHash' | 'updatedAt'> | Omit<ResearchWorkspace, 'revision' | 'workspaceHash' | 'updatedAt'> | Omit<PlanWorkspace, 'revision' | 'workspaceHash' | 'updatedAt'>;
