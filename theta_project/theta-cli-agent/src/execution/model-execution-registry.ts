import { CapabilityRegistry } from '../capabilities/registry.js';
import type { ModelCapabilityCard } from '../capabilities/contracts.js';
import type { CandidatePlan } from '../planner-v3/contracts.js';
import type { ExecutableModel } from './contracts.js';

export interface ModelExecutionContract {
  modelId: string;
  requiredColumns: { time: boolean; covariates: boolean };
  topicCountMode: ModelCapabilityCard['capabilities']['topicCountMode'];
  offlineExecution: ModelCapabilityCard['capabilities']['offlineExecution'];
  cpuExecution: ModelCapabilityCard['capabilities']['cpuExecution'];
  parameterIds: string[];
  requiredArtifactIds: string[];
  artifacts: ModelCapabilityCard['artifacts'];
}

// Capability cards call the classical THETA preparation route "baseline".
// Planner language may legitimately carry that audited label into a primary
// BTM/LDA/HDP candidate; execution normalizes it to unsupervised mode.
const STATIC_ALIASES = new Set(['static', 'unsupervised', 'baseline']);
const DYNAMIC_ALIASES = new Set(['dynamic', 'temporal', 'unsupervised']);
const STRUCTURAL_ALIASES = new Set(['structural', 'covariate', 'metadata', 'unsupervised']);
const BERTOPIC_ALIASES = new Set(['static', 'unsupervised', 'auto', 'target_reduction']);

export class ModelExecutionRegistry {
  readonly capabilities: CapabilityRegistry;

  constructor(capabilities = new CapabilityRegistry()) {
    this.capabilities = capabilities;
  }

  require(modelId: string): ModelExecutionContract {
    const card = this.capabilities.require(modelId);
    if (!this.capabilities.plannerEligibleModelIds().includes(card.modelId)) {
      throw new Error(`Model '${card.modelId}' is not eligible for governed execution.`);
    }
    return {
      modelId: card.modelId,
      requiredColumns: {
        time: card.capabilities.temporalTopics,
        covariates: card.capabilities.metadataEffects,
      },
      topicCountMode: card.capabilities.topicCountMode,
      offlineExecution: card.capabilities.offlineExecution,
      cpuExecution: card.capabilities.cpuExecution,
      parameterIds: card.parameters
        .filter((parameter) => parameter.exposure === 'agent_compiled' && parameter.usedByTraining)
        .map((parameter) => parameter.parameterId),
      requiredArtifactIds: card.artifacts
        .filter((artifact) => artifact.required)
        .map((artifact) => artifact.artifactId),
      artifacts: card.artifacts,
    };
  }

  compilePrimary(candidate: CandidatePlan): ExecutableModel {
    const card = this.capabilities.require(candidate.model.modelId);
    this.require(card.modelId);
    const supplied = candidate.model.parameters;
    const known = new Set(card.parameters.map((parameter) => parameter.parameterId));
    const unknown = Object.keys(supplied).filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(`Unsupported candidate parameters for '${card.modelId}': ${unknown.sort().join(', ')}.`);
    }
    const values = new Map<string, string | number | boolean | null>();
    for (const parameter of card.parameters) {
      if (parameter.exposure !== 'agent_compiled' || !parameter.usedByTraining) continue;
      const value = supplied[parameter.parameterId] ?? parameter.defaultValue;
      values.set(parameter.parameterId, value);
    }
    return compileExecutableModel(card, values, candidate.model.mode);
  }

  compileBaseline(modelId: string): ExecutableModel {
    const card = this.capabilities.require(modelId);
    this.require(card.modelId);
    const values = new Map<string, string | number | boolean | null>();
    for (const parameter of card.parameters) {
      if (parameter.exposure === 'agent_compiled' && parameter.usedByTraining) {
        values.set(parameter.parameterId, parameter.defaultValue);
      }
    }
    return compileExecutableModel(card, values, card.modelId === 'bertopic' ? 'auto' : 'unsupervised');
  }
}

const compileExecutableModel = (
  card: ModelCapabilityCard,
  values: ReadonlyMap<string, string | number | boolean | null>,
  requestedMode: string,
): ExecutableModel => {
  const normalizedMode = requestedMode.trim().toLowerCase();
  const mode = executableMode(card, normalizedMode, values);
  let topicCountMode: ExecutableModel['topicCountMode'];
  let numTopics: number | null = null;
  let maxTopics: number | null = null;
  if (card.capabilities.topicCountMode === 'fixed') {
    topicCountMode = 'fixed';
    numTopics = integerValue(values.get('num_topics'), `${card.modelId}.num_topics`);
  } else if (card.capabilities.topicCountMode === 'inferred') {
    topicCountMode = 'auto';
    maxTopics = integerValue(values.get('max_topics'), `${card.modelId}.max_topics`);
  } else if (normalizedMode === 'auto') {
    topicCountMode = 'auto';
  } else {
    topicCountMode = 'target_reduction';
    numTopics = integerValue(values.get('topic_target'), `${card.modelId}.topic_target`);
  }
  const parameters: Record<string, string | number | boolean | null> = {};
  for (const parameter of card.parameters) {
    if (parameter.exposure !== 'agent_compiled' || !parameter.usedByTraining || !parameter.planField) continue;
    if (['numTopics', 'maxTopics', 'mode'].includes(parameter.planField)) continue;
    const value = values.get(parameter.parameterId);
    if (value !== undefined) parameters[parameter.planField] = value;
  }
  return { modelId: card.modelId, mode, topicCountMode, numTopics, maxTopics, parameters };
};

const executableMode = (
  card: ModelCapabilityCard,
  requested: string,
  values: ReadonlyMap<string, string | number | boolean | null>,
): ExecutableModel['mode'] => {
  if (card.modelId === 'theta') {
    const resolved = ['zero_shot', 'supervised', 'unsupervised'].includes(requested)
      ? requested
      : String(values.get('mode') ?? '').trim().toLowerCase();
    if (!['zero_shot', 'supervised', 'unsupervised'].includes(resolved)) {
      throw new Error(`THETA execution mode is not supported: ${requested}.`);
    }
    return resolved as ExecutableModel['mode'];
  }
  const aliases = card.modelId === 'dtm'
    ? DYNAMIC_ALIASES
    : card.modelId === 'stm'
      ? STRUCTURAL_ALIASES
      : card.modelId === 'bertopic'
        ? BERTOPIC_ALIASES
        : STATIC_ALIASES;
  if (!aliases.has(requested)) {
    throw new Error(`Model '${card.modelId}' cannot compile planner mode '${requested}'.`);
  }
  return 'unsupervised';
};

const integerValue = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  return value;
};
