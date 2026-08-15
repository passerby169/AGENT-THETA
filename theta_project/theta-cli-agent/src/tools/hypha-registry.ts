import { ToolRegistry, type ToolSpec } from "@hypha/tools";
import {
  thetaDatasetCategoricalProfileHandler,
  thetaDatasetCategoricalProfileToolSpec,
  thetaDatasetColumnProfileHandler,
  thetaDatasetColumnProfileToolSpec,
  thetaDatasetDuplicatesHandler,
  thetaDatasetDuplicatesToolSpec,
  thetaDatasetMissingnessHandler,
  thetaDatasetMissingnessToolSpec,
  thetaDatasetOverviewHandler,
  thetaDatasetOverviewToolSpec,
  thetaDatasetRelationshipsHandler,
  thetaDatasetRelationshipsToolSpec,
  thetaDatasetSampleHandler,
  thetaDatasetSampleToolSpec,
  thetaDatasetSubmitUnderstandingHandler,
  thetaDatasetSubmitUnderstandingToolSpec,
  thetaDatasetTextProfileHandler,
  thetaDatasetTextProfileToolSpec,
  thetaDatasetTimeProfileHandler,
  thetaDatasetTimeProfileToolSpec,
} from './dataset-analysis-tools.js';
import {
  thetaDatasetApplyUserRevisionHandler,
  thetaDatasetApplyUserRevisionToolSpec,
} from './dataset-revision-tool.js';
import {
  thetaResearchReadWorkspaceHandler,
  thetaResearchReadWorkspaceToolSpec,
  thetaResearchUpdateUnderstandingHandler,
  thetaResearchUpdateUnderstandingToolSpec,
} from './research-understanding-tools.js';
import {
  thetaModelCompareHandler,
  thetaModelCompareToolSpec,
  thetaModelGetCapabilityHandler,
  thetaModelGetCapabilityToolSpec,
  thetaModelGetParameterContractHandler,
  thetaModelGetParameterContractToolSpec,
  thetaModelListAvailableHandler,
  thetaModelListAvailableToolSpec,
} from './model-planning-tools.js';
import {
  thetaRuntimeCheckDependenciesHandler,
  thetaRuntimeCheckDependenciesToolSpec,
  thetaRuntimeCheckModelAssetsHandler,
  thetaRuntimeCheckModelAssetsToolSpec,
  thetaRuntimeCheckOfflineReadinessHandler,
  thetaRuntimeCheckOfflineReadinessToolSpec,
  thetaRuntimeEstimateCandidateHandler,
  thetaRuntimeEstimateCandidateToolSpec,
  thetaRuntimeProfileHardwareHandler,
  thetaRuntimeProfileHardwareToolSpec,
} from './runtime-planning-tools.js';
import {
  thetaRagCheckClaimSupportHandler,
  thetaRagCheckClaimSupportToolSpec,
  thetaRagCompareModelsHandler,
  thetaRagCompareModelsToolSpec,
  thetaRagFindConflictsHandler,
  thetaRagFindConflictsToolSpec,
  thetaRagGetEvidenceHandler,
  thetaRagGetEvidenceToolSpec,
} from './rag-planning-tools.js';
import {
  thetaPlannerCompareCandidatesHandler,
  thetaPlannerCompareCandidatesToolSpec,
  thetaPlannerCreateCandidateHandler,
  thetaPlannerCreateCandidateToolSpec,
  thetaPlannerEstimateProtocolHandler,
  thetaPlannerEstimateProtocolToolSpec,
  thetaPlannerGetCandidateHandler,
  thetaPlannerGetCandidateToolSpec,
  thetaPlannerSelectEvidenceHandler,
  thetaPlannerSelectEvidenceToolSpec,
  thetaPlannerSubmitRevisionHandler,
  thetaPlannerSubmitRevisionToolSpec,
  thetaPlannerValidatePreviewHandler,
  thetaPlannerValidatePreviewToolSpec,
} from './planner-v3-tools.js';
import { thetaAgentProtocolFeedbackHandler, thetaAgentProtocolFeedbackToolSpec } from './agent-protocol-feedback-tool.js';
import {
  thetaModelShortlistHandler,
  thetaModelShortlistToolSpec,
  thetaPlannerEvaluateCandidateHandler,
  thetaPlannerEvaluateCandidateToolSpec,
  thetaPlannerInspectCaseHandler,
  thetaPlannerInspectCaseToolSpec,
  thetaPlannerValidateAlignmentHandler,
  thetaPlannerValidateAlignmentToolSpec,
} from './planning-workbench-tools.js';
import {
  thetaModelCatalogHandler,
  thetaModelCatalogToolSpec,
} from "./model-catalog-tool.js";
import {
  thetaRagIndexHandler,
  thetaRagIndexToolSpec,
} from "./rag-index-tool.js";
import {
  thetaRagSearchHandler,
  thetaRagSearchToolSpec,
} from "./rag-search-tool.js";
import {
  thetaRagStatusHandler,
  thetaRagStatusToolSpec,
} from "./rag-status-tool.js";
import {
  thetaPlanCreateHandler,
  thetaPlanCreateToolSpec,
  thetaTrainingDryRunHandler,
  thetaTrainingDryRunToolSpec,
} from './execution-preparation-tools.js';
import {
  thetaArtifactsVerifyHandler,
  thetaArtifactsVerifyToolSpec,
  thetaDatasetVerifyForTrainingHandler,
  thetaDatasetVerifyForTrainingToolSpec,
  thetaResultsGetSummaryHandler,
  thetaResultsGetSummaryToolSpec,
  thetaResultsListArtifactsHandler,
  thetaResultsListArtifactsToolSpec,
  thetaTrainingCancelHandler,
  thetaTrainingCancelToolSpec,
  thetaTrainingStartHandler,
  thetaTrainingStartToolSpec,
  thetaTrainingStatusHandler,
  thetaTrainingStatusToolSpec,
} from './training-execution-tools.js';

export const registerThetaModelCatalogTool = (
  registry: ToolRegistry,
): ToolRegistry => {
  registry.register(thetaModelCatalogToolSpec, thetaModelCatalogHandler, {
    replace: true,
  });
  return registry;
};

export const thetaHyphaToolSpecs: readonly ToolSpec[] = Object.freeze([
  thetaAgentProtocolFeedbackToolSpec,
  thetaDatasetOverviewToolSpec,
  thetaDatasetSampleToolSpec,
  thetaDatasetColumnProfileToolSpec,
  thetaDatasetTextProfileToolSpec,
  thetaDatasetTimeProfileToolSpec,
  thetaDatasetCategoricalProfileToolSpec,
  thetaDatasetMissingnessToolSpec,
  thetaDatasetDuplicatesToolSpec,
  thetaDatasetRelationshipsToolSpec,
  thetaDatasetSubmitUnderstandingToolSpec,
  thetaDatasetApplyUserRevisionToolSpec,
  thetaResearchReadWorkspaceToolSpec,
  thetaResearchUpdateUnderstandingToolSpec,
  thetaModelListAvailableToolSpec,
  thetaModelGetCapabilityToolSpec,
  thetaModelCompareToolSpec,
  thetaModelGetParameterContractToolSpec,
  thetaRuntimeProfileHardwareToolSpec,
  thetaRuntimeCheckDependenciesToolSpec,
  thetaRuntimeCheckModelAssetsToolSpec,
  thetaRuntimeCheckOfflineReadinessToolSpec,
  thetaRuntimeEstimateCandidateToolSpec,
  thetaRagGetEvidenceToolSpec,
  thetaRagFindConflictsToolSpec,
  thetaRagCompareModelsToolSpec,
  thetaRagCheckClaimSupportToolSpec,
  thetaPlannerCreateCandidateToolSpec,
  thetaPlannerGetCandidateToolSpec,
  thetaPlannerCompareCandidatesToolSpec,
  thetaPlannerSubmitRevisionToolSpec,
  thetaPlannerEstimateProtocolToolSpec,
  thetaPlannerSelectEvidenceToolSpec,
  thetaPlannerValidatePreviewToolSpec,
  thetaPlannerInspectCaseToolSpec,
  thetaModelShortlistToolSpec,
  thetaPlannerEvaluateCandidateToolSpec,
  thetaPlannerValidateAlignmentToolSpec,
  thetaModelCatalogToolSpec,
  thetaRagIndexToolSpec,
  thetaRagStatusToolSpec,
  thetaRagSearchToolSpec,
  thetaPlanCreateToolSpec,
  thetaTrainingDryRunToolSpec,
  thetaDatasetVerifyForTrainingToolSpec,
  thetaTrainingStartToolSpec,
  thetaTrainingStatusToolSpec,
  thetaTrainingCancelToolSpec,
  thetaArtifactsVerifyToolSpec,
  thetaResultsListArtifactsToolSpec,
  thetaResultsGetSummaryToolSpec,
]);

export const createThetaHyphaToolRegistry = (): ToolRegistry => {
  const registry = new ToolRegistry();
  registry.register(thetaAgentProtocolFeedbackToolSpec, thetaAgentProtocolFeedbackHandler, { replace: true });
  registry.register(thetaDatasetOverviewToolSpec, thetaDatasetOverviewHandler, { replace: true });
  registry.register(thetaDatasetSampleToolSpec, thetaDatasetSampleHandler, { replace: true });
  registry.register(thetaDatasetColumnProfileToolSpec, thetaDatasetColumnProfileHandler, { replace: true });
  registry.register(thetaDatasetTextProfileToolSpec, thetaDatasetTextProfileHandler, { replace: true });
  registry.register(thetaDatasetTimeProfileToolSpec, thetaDatasetTimeProfileHandler, { replace: true });
  registry.register(thetaDatasetCategoricalProfileToolSpec, thetaDatasetCategoricalProfileHandler, { replace: true });
  registry.register(thetaDatasetMissingnessToolSpec, thetaDatasetMissingnessHandler, { replace: true });
  registry.register(thetaDatasetDuplicatesToolSpec, thetaDatasetDuplicatesHandler, { replace: true });
  registry.register(thetaDatasetRelationshipsToolSpec, thetaDatasetRelationshipsHandler, { replace: true });
  registry.register(thetaDatasetSubmitUnderstandingToolSpec, thetaDatasetSubmitUnderstandingHandler, { replace: true });
  registry.register(thetaDatasetApplyUserRevisionToolSpec, thetaDatasetApplyUserRevisionHandler, { replace: true });
  registry.register(thetaResearchReadWorkspaceToolSpec, thetaResearchReadWorkspaceHandler, { replace: true });
  registry.register(thetaResearchUpdateUnderstandingToolSpec, thetaResearchUpdateUnderstandingHandler, { replace: true });
  registry.register(thetaModelListAvailableToolSpec, thetaModelListAvailableHandler, { replace: true });
  registry.register(thetaModelGetCapabilityToolSpec, thetaModelGetCapabilityHandler, { replace: true });
  registry.register(thetaModelCompareToolSpec, thetaModelCompareHandler, { replace: true });
  registry.register(thetaModelGetParameterContractToolSpec, thetaModelGetParameterContractHandler, { replace: true });
  registry.register(thetaRuntimeProfileHardwareToolSpec, thetaRuntimeProfileHardwareHandler, { replace: true });
  registry.register(thetaRuntimeCheckDependenciesToolSpec, thetaRuntimeCheckDependenciesHandler, { replace: true });
  registry.register(thetaRuntimeCheckModelAssetsToolSpec, thetaRuntimeCheckModelAssetsHandler, { replace: true });
  registry.register(thetaRuntimeCheckOfflineReadinessToolSpec, thetaRuntimeCheckOfflineReadinessHandler, { replace: true });
  registry.register(thetaRuntimeEstimateCandidateToolSpec, thetaRuntimeEstimateCandidateHandler, { replace: true });
  registry.register(thetaRagGetEvidenceToolSpec, thetaRagGetEvidenceHandler, { replace: true });
  registry.register(thetaRagFindConflictsToolSpec, thetaRagFindConflictsHandler, { replace: true });
  registry.register(thetaRagCompareModelsToolSpec, thetaRagCompareModelsHandler, { replace: true });
  registry.register(thetaRagCheckClaimSupportToolSpec, thetaRagCheckClaimSupportHandler, { replace: true });
  registry.register(thetaPlannerCreateCandidateToolSpec, thetaPlannerCreateCandidateHandler, { replace: true });
  registry.register(thetaPlannerGetCandidateToolSpec, thetaPlannerGetCandidateHandler, { replace: true });
  registry.register(thetaPlannerCompareCandidatesToolSpec, thetaPlannerCompareCandidatesHandler, { replace: true });
  registry.register(thetaPlannerSubmitRevisionToolSpec, thetaPlannerSubmitRevisionHandler, { replace: true });
  registry.register(thetaPlannerEstimateProtocolToolSpec, thetaPlannerEstimateProtocolHandler, { replace: true });
  registry.register(thetaPlannerSelectEvidenceToolSpec, thetaPlannerSelectEvidenceHandler, { replace: true });
  registry.register(thetaPlannerValidatePreviewToolSpec, thetaPlannerValidatePreviewHandler, { replace: true });
  registry.register(thetaPlannerInspectCaseToolSpec, thetaPlannerInspectCaseHandler, { replace: true });
  registry.register(thetaModelShortlistToolSpec, thetaModelShortlistHandler, { replace: true });
  registry.register(thetaPlannerEvaluateCandidateToolSpec, thetaPlannerEvaluateCandidateHandler, { replace: true });
  registry.register(thetaPlannerValidateAlignmentToolSpec, thetaPlannerValidateAlignmentHandler, { replace: true });
  registerThetaModelCatalogTool(registry);
  registry.register(thetaRagIndexToolSpec, thetaRagIndexHandler, {
    replace: true,
  });
  registry.register(thetaRagStatusToolSpec, thetaRagStatusHandler, {
    replace: true,
  });
  registry.register(thetaRagSearchToolSpec, thetaRagSearchHandler, {
    replace: true,
  });
  registry.register(thetaPlanCreateToolSpec, thetaPlanCreateHandler, { replace: true });
  registry.register(thetaTrainingDryRunToolSpec, thetaTrainingDryRunHandler, { replace: true });
  registry.register(thetaDatasetVerifyForTrainingToolSpec, thetaDatasetVerifyForTrainingHandler, { replace: true });
  registry.register(thetaTrainingStartToolSpec, thetaTrainingStartHandler, { replace: true });
  registry.register(thetaTrainingStatusToolSpec, thetaTrainingStatusHandler, { replace: true });
  registry.register(thetaTrainingCancelToolSpec, thetaTrainingCancelHandler, { replace: true });
  registry.register(thetaArtifactsVerifyToolSpec, thetaArtifactsVerifyHandler, { replace: true });
  registry.register(thetaResultsListArtifactsToolSpec, thetaResultsListArtifactsHandler, { replace: true });
  registry.register(thetaResultsGetSummaryToolSpec, thetaResultsGetSummaryHandler, { replace: true });
  return registry;
};
