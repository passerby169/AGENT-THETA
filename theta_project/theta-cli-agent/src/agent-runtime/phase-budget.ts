import type { ThetaIntelligentPhase, ThetaPhaseBudget } from './contracts.js';

// Hypha's kernel contract requires finite numeric guards. These schema maxima are
// used as an effectively-unbounded ceiling; THETA does not impose a phase-level
// model/tool/iteration/token budget. Safety comes from quantum yielding,
// no-progress detection, provider timeouts, Tool policies and FSM checkpoints.
const HYPHA_EFFECTIVELY_UNBOUNDED = {
  iterations: 1_000_000,
  modelCalls: 1_000_000,
  toolCalls: 1_000_000,
  tokens: 1_000_000_000,
} as const;

const integer = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const thetaPhaseBudget = (phase: ThetaIntelligentPhase): ThetaPhaseBudget => {
  void phase;
  return {
    maxIterations: HYPHA_EFFECTIVELY_UNBOUNDED.iterations,
    maxModelCalls: HYPHA_EFFECTIVELY_UNBOUNDED.modelCalls,
    maxToolCalls: HYPHA_EFFECTIVELY_UNBOUNDED.toolCalls,
    maxTotalTokens: HYPHA_EFFECTIVELY_UNBOUNDED.tokens,
    maxConsecutiveNoProgress: integer('THETA_AGENT_MAX_NO_PROGRESS', 3),
    quantumIterations: integer('THETA_AGENT_QUANTUM_ITERATIONS', 4),
  };
};
