import type { ReActAgentSpec } from '@hypha/kernel';
import type { ThetaIntelligentPhase } from './contracts.js';
import { thetaToolsForPhase } from '../domain-v6/tool-scopes.js';
import { datasetDiscoveryPromptV4 } from './prompts/dataset-discovery-v4.js';
import { researchDialoguePromptV1 } from './prompts/research-dialogue-v1.js';
import { planDesignPromptV1 } from './prompts/plan-design-v1.js';
import { planConfirmationPromptV1 } from './prompts/plan-confirmation-v1.js';
import { THETA_AGENT_ID } from '../memory/theta-memory-scope.js';

const phaseInstructions: Record<ThetaIntelligentPhase, string> = {
  DatasetDiscovery: datasetDiscoveryPromptV4,
  ResearchDialogue: researchDialoguePromptV1,
  PlanDesign: planDesignPromptV1,
  PlanConfirmation: planConfirmationPromptV1,
};

export const thetaAgentSpecForPhase = (phase: ThetaIntelligentPhase): ReActAgentSpec => ({
  id: THETA_AGENT_ID,
  version: '3.0.0',
  name: 'THETA Research Training Agent',
  modelAlias: process.env.MINIMAX_MODEL?.trim() || 'MiniMax-M2.7',
  systemInstructions: [
    phaseInstructions[phase],
    'Use native function calls for tool actions and theta_finish_phase for completion. Do not hand-write an abbreviated finish JSON object.',
    'A finish action is only a phase-completion proposal; the business FSM guard decides transitions.',
    'Never claim user confirmation and never expose hidden chain-of-thought.',
  ].join(' '),
  toolRefs: [...thetaToolsForPhase(phase)],
  memoryProfileRef: 'theta-native-default',
  contextSpecRef: { id: 'context.theta.reality.v1', version: '1.0.0' },
  reasoning: {
    thinkingMode: 'structured',
    agenticMode: 'fsm_react',
    maxSteps: 8,
    persist: 'summary_only',
  },
});
