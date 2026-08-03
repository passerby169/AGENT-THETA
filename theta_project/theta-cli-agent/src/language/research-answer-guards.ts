import type { ResearchBriefPatch } from '../agent/research-contracts.js';

export interface GuardedResearchPatch {
  patch: ResearchBriefPatch;
  correctedFields: string[];
  confirmationFields: string[];
}

const explicitlyNoGpu =
  /(?:不|不要|不用|禁止|无法|没有|无)\s*(?:使用|可用|支持)?\s*(?:GPU|显卡|CUDA)/iu;
const explicitlyNoCpu =
  /(?:不|不要|不用|禁止|无法|没有|无)\s*(?:使用|可用|支持)?\s*CPU/iu;

export const guardCriticalResearchPatch = (
  field: string,
  answer: string,
  providerPatch: ResearchBriefPatch,
  confidenceByField: Readonly<Record<string, number>> = {},
): GuardedResearchPatch => {
  const authoritativeField = field.split(',')[0] ?? field;
  const patch: ResearchBriefPatch = { ...providerPatch };
  const correctedFields: string[] = [];
  const confirmationFields: string[] = [];

  const shortNo =
    authoritativeField === 'sensitiveData' &&
    /^(?:否|no|不包含|不含|没有|无|不存在)[。.]?$/iu.test(answer.trim());
  const shortYes =
    authoritativeField === 'sensitiveData' &&
    /^(?:是|有|包含|yes)[。.]?$/iu.test(answer.trim());
  const explicitNo =
    shortNo ||
    /(?:不包含|不含|不存在|没有|无).{0,16}(?:个人|隐私|机密|敏感|医疗|商业)(?:信息|内容|数据)?|(?:个人|隐私|机密|敏感|医疗|商业)(?:信息|内容|数据)?.{0,16}(?:不包含|不含|不存在|没有|无)|完全.{0,8}模拟|人工.{0,8}模拟|合成数据|无敏感|does\s+not\s+contain.{0,20}(?:personal|sensitive|confidential)|without\s+(?:personal|sensitive|confidential)|synthetic|simulated|mock\s+data/iu.test(
      answer,
    );
  const explicitYes =
    (shortYes ||
      /(包含|含有|存在|涉及).{0,12}(个人|隐私|机密|敏感|医疗|商业)|contains?.{0,20}(personal|sensitive|confidential|medical)|\byes\b.{0,12}(sensitive|personal|confidential)/iu.test(
        answer,
      )) &&
    !explicitNo;
  if (explicitNo || explicitYes) {
    const guarded = {
      status: explicitNo ? ('no' as const) : ('yes' as const),
      categories: patch.sensitiveData?.categories ?? [],
    };
    if (patch.sensitiveData?.status !== guarded.status) {
      correctedFields.push('sensitiveData');
    }
    patch.sensitiveData = guarded;
  } else if (patch.sensitiveData !== undefined) {
    delete patch.sensitiveData;
    confirmationFields.push('sensitiveData');
  }

  if (authoritativeField === 'hardwareLimit' || patch.hardwareLimit) {
    const memory = answer.match(/(\d+(?:\.\d+)?)\s*(?:GB|G)\b/iu);
    let device: 'cpu' | 'gpu' | 'unknown' | undefined;
    if (
      explicitlyNoGpu.test(answer) ||
      (/CPU/iu.test(answer) && !explicitlyNoCpu.test(answer))
    ) {
      device = 'cpu';
    } else if (
      /(?:GPU|显卡|CUDA)/iu.test(answer) &&
      !explicitlyNoGpu.test(answer)
    ) {
      device = 'gpu';
    }
    if (device) {
      if (patch.hardwareLimit?.device !== device) {
        correctedFields.push('hardwareLimit');
      }
      patch.hardwareLimit = {
        device,
        ...(memory
          ? { memoryGb: Number(memory[1]) }
          : patch.hardwareLimit?.memoryGb === undefined
            ? {}
            : { memoryGb: patch.hardwareLimit.memoryGb }),
      };
    }
  }

  if (authoritativeField === 'trendAnalysis' || patch.trendAnalysis !== undefined) {
    const explicitNo =
      /(不|否|no|不要|无需|不需要|不分析|不研究).{0,16}(时间|趋势|变化|temporal|trend|time)|^(不|否|no|不要|无需|不需要)$/iu.test(
        answer.trim(),
      );
    if (explicitNo) {
      if (patch.trendAnalysis !== false) correctedFields.push('trendAnalysis');
      patch.trendAnalysis = false;
    }
  }

  if (authoritativeField === 'comparisonGroups' || patch.comparisonGroups) {
    const explicitNo =
      /^(不|否|no|不要|无需|不需要|没有|无|不适用).{0,20}(比较|分组|对比|group|comparison)?[。.]?$/iu.test(
        answer.trim(),
      );
    if (explicitNo) {
      if ((patch.comparisonGroups?.length ?? 0) > 0) {
        correctedFields.push('comparisonGroups');
      }
      patch.comparisonGroups = [];
      patch.comparisonIntent = 'none';
    } else if ((patch.comparisonGroups?.length ?? 0) > 0) {
      patch.comparisonIntent = 'groups';
    }
  }

  for (const patchField of Object.keys(patch)) {
    const threshold = patchField === authoritativeField ? 0.5 : 0.78;
    const confidence =
      correctedFields.includes(patchField) ||
      (patchField === 'sensitiveData' && (explicitNo || explicitYes))
        ? 1
        : (confidenceByField[patchField] ?? 0);
    if (confidence < threshold) {
      delete patch[patchField as keyof ResearchBriefPatch];
      confirmationFields.push(patchField);
    }
  }

  return {
    patch,
    correctedFields: [...new Set(correctedFields)],
    confirmationFields: [...new Set(confirmationFields)],
  };
};
