import type { ResearchBrief } from '../agent/research-contracts.js';
import type { CatalogModel } from './engine.js';

export type ResearchCapability =
  | 'temporal_topics'
  | 'metadata_effects'
  | 'offline_execution'
  | 'cpu_execution';

export interface ModelCapabilities {
  temporalTopics: boolean;
  metadataEffects: boolean;
  shortTextOptimized: boolean;
  offlineExecution: boolean;
  cpuExecution: boolean;
  nativeOutputs: string[];
}

export interface ResearchRequirements {
  required: ResearchCapability[];
  preferred: string[];
  reasons: Record<string, string>;
}

const explicitCapabilities: Readonly<
  Record<string, Partial<ModelCapabilities>>
> = {
  btm: {
    shortTextOptimized: true,
    nativeOutputs: ['static_topics', 'document_topic_distribution'],
  },
  dtm: {
    temporalTopics: true,
    nativeOutputs: ['temporal_topics', 'topic_evolution'],
  },
  stm: {
    metadataEffects: true,
    nativeOutputs: ['metadata_effects', 'group_topic_association'],
  },
  hdp: {
    nativeOutputs: ['nonparametric_static_topics'],
  },
  lda: {
    nativeOutputs: ['static_topics', 'document_topic_distribution'],
  },
  bertopic: {
    shortTextOptimized: true,
    nativeOutputs: ['embedding_clusters', 'document_topic_distribution'],
  },
};

export const capabilitiesForModel = (
  model: CatalogModel,
): ModelCapabilities => {
  const modelId = model.id.toLowerCase();
  const requires = model.requires.map((value) => value.toLowerCase());
  const explicit = explicitCapabilities[modelId] ?? {};
  const requiresRemoteAsset = requires.some((value) =>
    ['qwen', 'sbert', 'transformer'].includes(value),
  );
  return {
    temporalTopics:
      explicit.temporalTopics ?? requires.includes('time'),
    metadataEffects:
      explicit.metadataEffects ?? requires.includes('covariates'),
    shortTextOptimized: explicit.shortTextOptimized ?? false,
    offlineExecution: explicit.offlineExecution ?? !requiresRemoteAsset,
    cpuExecution: explicit.cpuExecution ?? true,
    nativeOutputs: explicit.nativeOutputs ?? ['static_topics'],
  };
};

export const deriveResearchRequirements = (
  brief: ResearchBrief | undefined,
): ResearchRequirements => {
  const required = new Set<ResearchCapability>();
  const preferred = new Set<string>();
  const reasons: Record<string, string> = {};
  if (brief?.trendAnalysis) {
    required.add('temporal_topics');
    reasons.temporal_topics =
      '研究档案明确要求分析主题随时间的变化。';
  }
  // Candidate columns describe what the dataset could support; they are not a
  // research requirement. Only an explicit comparison intent may force a
  // metadata-effects model such as STM.
  if ((brief?.comparisonGroups.length ?? 0) > 0) {
    required.add('metadata_effects');
    reasons.metadata_effects =
      '研究档案明确要求比较分组并利用元数据解释主题差异。';
  }
  if (brief?.offlineOnly) {
    required.add('offline_execution');
    reasons.offline_execution = '研究档案要求训练阶段离线运行。';
  }
  if (brief?.hardwareLimit.device === 'cpu') {
    required.add('cpu_execution');
    reasons.cpu_execution = '研究档案限定使用 CPU。';
  }
  if (brief?.topicGranularity) {
    preferred.add(`topic_granularity:${brief.topicGranularity}`);
  }
  return {
    required: [...required],
    preferred: [...preferred],
    reasons,
  };
};

export const unmetResearchCapabilities = (
  capabilities: ModelCapabilities,
  requirements: ResearchRequirements,
): ResearchCapability[] =>
  requirements.required.filter((requirement) => {
    switch (requirement) {
      case 'temporal_topics':
        return !capabilities.temporalTopics;
      case 'metadata_effects':
        return !capabilities.metadataEffects;
      case 'offline_execution':
        return !capabilities.offlineExecution;
      case 'cpu_execution':
        return !capabilities.cpuExecution;
    }
  });
