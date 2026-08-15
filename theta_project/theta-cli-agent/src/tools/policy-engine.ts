import type { PolicyEngine } from '@hypha/core';
import { THETA_TOOL_IDS } from './tool-ids.js';

export const thetaV6PolicyEngine: PolicyEngine = {
  async evaluate(context) {
    if (context.sideEffectLevel === 'irreversible') {
      return {
        allowed: false,
        policyId: 'policy.theta.v6.external-effects',
        ruleId: 'deny-irreversible-effects',
        reason: 'THETA never grants irreversible effects to a training Tool.',
      };
    }
    if (context.sideEffectLevel === 'external_effect') {
      const metadata = context.metadata ?? {};
      const state = String(metadata.fsmState ?? '');
      const policyRefs = Array.isArray(metadata.policyRefs) ? metadata.policyRefs.map(String) : [];
      const hasTrainingPolicy = policyRefs.includes('policy.theta.v6.training-control');
      const startAllowed = context.capabilityId === THETA_TOOL_IDS.trainingStart && state === 'StartTraining';
      const cancelAllowed = context.capabilityId === THETA_TOOL_IDS.trainingCancel && ['MonitorTraining', 'HumanRecovery'].includes(state);
      if (hasTrainingPolicy && (startAllowed || cancelAllowed)) {
        return { allowed: true, policyId: 'policy.theta.v6.training-control', ruleId: startAllowed ? 'allow-bound-start' : 'allow-bound-cancel' };
      }
      return { allowed: false, policyId: 'policy.theta.v6.training-control', ruleId: 'deny-out-of-state-training-effect', reason: 'Training effects require the exact governed FSM state and training-control policy.' };
    }
    return {
      allowed: true,
      policyId: 'policy.theta.v6.local-tools',
      ruleId: 'allow-governed-local-tool',
    };
  },
};
