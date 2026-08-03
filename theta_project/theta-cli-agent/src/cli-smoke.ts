import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path, { resolve } from "node:path";
import { parsePlanAdjustment } from "./conversation/turn-orchestrator.js";
import { parsePlanAdjustmentRequest } from "./conversation/plan-adjustment.js";

interface CommandCase {
  args: string[];
  verify(output: unknown): void;
}

const cliPath = resolve(process.cwd(), "dist", "cli.js");
const root = await mkdtemp(path.join(os.tmpdir(), "theta-agent-cli-smoke-"));
const runtimeDb = path.join(root, "workflow.sqlite");
const agentRunId = "theta-agent-cli-run";

const adjustableModels = [
  "bertopic",
  "btm",
  "ctm",
  "dtm",
  "etm",
  "gsm",
  "hdp",
  "lda",
  "nvdm",
  "prodlda",
  "stm",
  "theta",
] as const;

for (const modelId of adjustableModels) {
  const adjustment = parsePlanAdjustment(`将模型改为 ${modelId}`);
  if (adjustment.modelId !== modelId) {
    throw new Error(`Plan adjustment did not recognize model ${modelId}.`);
  }
}

const adjustmentCases = [
  ["主题数从 10 改为 8", { numTopics: 10 }, "numTopics", 8],
  ["把 10 个主题减少到 6 个", { numTopics: 10 }, "numTopics", 6],
  ["主题数改为 8", { numTopics: 10 }, "numTopics", 8],
  ["增加 2 个主题", { numTopics: 10 }, "numTopics", 12],
  ["迭代次数从1000改到1500", { iterations: 1000 }, "epochs", 1500],
] as const;

for (const [input, current, field, expected] of adjustmentCases) {
  const adjustment = parsePlanAdjustment(input, current);
  if (adjustment[field] !== expected) {
    throw new Error(
      `${input}: expected ${field}=${String(expected)}, got ${String(adjustment[field])}.`,
    );
  }
}

const staleOldValue = parsePlanAdjustmentRequest(
  "主题数从 10 改为 8",
  { numTopics: 7 },
);
if (
  Object.keys(staleOldValue.patch).length !== 0 ||
  staleOldValue.clarificationReasons.length !== 1
) {
  throw new Error("A stale old value must require clarification.");
}

const ambiguousAdjustment = parsePlanAdjustmentRequest(
  "主题数 10 还是 8",
  { numTopics: 10 },
);
if (
  Object.keys(ambiguousAdjustment.patch).length !== 0 ||
  ambiguousAdjustment.clarificationReasons.length !== 1
) {
  throw new Error("Ambiguous numeric input must not create an executable patch.");
}

const covariateAdjustment = parsePlanAdjustment(
  "协变量改为 source, region",
);
if (
  JSON.stringify(covariateAdjustment.covariateColumns) !==
  JSON.stringify(["source", "region"])
) {
  throw new Error("Covariate adjustment was not parsed deterministically.");
}

const compatibilityAdjustment = parsePlanAdjustment(
  "批大小改为 16，最大主题数改为 120",
);
if (
  compatibilityAdjustment.batchSize !== 16 ||
  compatibilityAdjustment.maxTopics !== 120
) {
  throw new Error("Existing batch-size and max-topic adjustments regressed.");
}

const runJsonCommand = (commandCase: CommandCase): void => {
  const result = spawnSync(
    process.execPath,
    [cliPath, ...commandCase.args, "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `CLI command failed (${commandCase.args.join(" ")}): ${result.stderr || result.stdout}`,
    );
  }
  commandCase.verify(JSON.parse(result.stdout) as unknown);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CLI JSON output must be an object.");
  }
  return value as Record<string, unknown>;
};

const cases: CommandCase[] = [
  {
    args: ["doctor"],
    verify: (output) => {
      const report = asRecord(output);
      if (
        !["ready", "degraded"].includes(String(report.status)) ||
        !Array.isArray(report.checks)
      ) {
        throw new Error("doctor did not return an actionable readiness report.");
      }
    },
  },
  {
    args: [
      "start",
      "--file",
      "fixtures/sample.jsonl",
      "--run-id",
      agentRunId,
      "--runtime-db",
      runtimeDb,
    ],
    verify: (output) => {
      const run = asRecord(output);
      if (
        run.runId !== agentRunId ||
        typeof run.currentState !== "string" ||
        typeof run.pendingActionRef !== "string"
      ) {
        throw new Error("top-level start did not create a durable waiting Run.");
      }
    },
  },
  {
    args: [
      "status",
      "--run-id",
      agentRunId,
      "--runtime-db",
      runtimeDb,
    ],
    verify: (output) => {
      const status = asRecord(output);
      if (
        status.runId !== agentRunId ||
        typeof status.eventCount !== "number" ||
        Number(status.eventCount) < 1
      ) {
        throw new Error("top-level status was not derived from Runtime events.");
      }
    },
  },
  {
    args: [
      "audit",
      "export",
      "--run-id",
      agentRunId,
      "--runtime-db",
      runtimeDb,
    ],
    verify: (output) => {
      const audit = asRecord(output);
      if (
        !Array.isArray(audit.orchestrationEvents) ||
        !Array.isArray(audit.toolEvents)
      ) {
        throw new Error("audit export did not return both event streams.");
      }
    },
  },
  {
    args: ["dataset", "inspect", "--file", "fixtures/sample.jsonl"],
    verify: (output) => {
      const profile = asRecord(output);
      if (
        profile.rowCount !== 3 ||
        !Array.isArray(profile.columns) ||
        typeof profile.datasetSha256 !== "string" ||
        profile.datasetSha256.length !== 64
      ) {
        throw new Error("dataset inspect command returned an invalid profile.");
      }
    },
  },
  {
    args: ["dataset", "detect-columns", "--file", "fixtures/sample.jsonl"],
    verify: (output) => {
      const detected = asRecord(output);
      if (detected.recommendedTextColumn !== "text") {
        throw new Error(
          "dataset detect-columns command returned the wrong recommendation.",
        );
      }
    },
  },
  {
    args: ["models"],
    verify: (output) => {
      const catalog = asRecord(output);
      if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
        throw new Error("models command returned an empty catalog.");
      }
    },
  },
  {
    args: [
      "recommend",
      "--profile",
      "fixtures/data-profile.json",
      "--columns",
      "fixtures/model-recommend-columns.json",
    ],
    verify: (output) => {
      const recommendation = asRecord(output);
      if (
        !Array.isArray(recommendation.recommendations) ||
        recommendation.recommendations.length === 0
      ) {
        throw new Error("recommend command returned no recommendations.");
      }
    },
  },
  {
    args: ["plan", "validate", "--file", "fixtures/training-plan.json"],
    verify: (output) => {
      if (asRecord(output).valid !== true) {
        throw new Error("plan validate command did not validate the fixture.");
      }
    },
  },
  {
    args: ["plan", "create", "--file", "fixtures/training-plan.json"],
    verify: (output) => {
      const gate = asRecord(output);
      if (
        gate.approvalRequired !== true ||
        gate.status !== "human_review_required"
      ) {
        throw new Error(
          "plan create command bypassed the Hypha approval gate.",
        );
      }
    },
  },
  {
    args: [
      "plan",
      "approve",
      "--plan-id",
      "plan_gate_only",
      "--plan-hash",
      "hash_gate_only",
      "--approved-by",
      "local_user",
    ],
    verify: (output) => {
      const gate = asRecord(output);
      if (
        gate.approvalRequired !== true ||
        gate.status !== "human_review_required"
      ) {
        throw new Error(
          "plan approve command bypassed the Hypha approval gate.",
        );
      }
    },
  },
  {
    args: [
      "training",
      "cancel",
      "--run-id",
      "run_gate_only",
      "--reason",
      "CLI gate verification",
    ],
    verify: (output) => {
      const gate = asRecord(output);
      if (
        gate.approvalRequired !== true ||
        gate.status !== "human_review_required" ||
        gate.cancellationRecorded !== false
      ) {
        throw new Error(
          "training cancel command bypassed the Hypha approval gate.",
        );
      }
    },
  },
  {
    args: ["demo"],
    verify: (output) => {
      const demo = asRecord(output);
      if (
        demo.runner !== "Hypha GovernedToolRunner" ||
        demo.canonicalPlanCreated !== false
      ) {
        throw new Error(
          "demo command did not preserve the default plan-creation gate.",
        );
      }
    },
  },
  {
    args: ["workflow", "compile"],
    verify: (output) => {
      const compilation = asRecord(output);
      if (
        typeof compilation.processHash !== "string" ||
        !Array.isArray(compilation.toolRefs) ||
        compilation.toolRefs.length === 0
      ) {
        throw new Error(
          "workflow compile command returned an invalid contract summary.",
        );
      }
    },
  },
];

for (const commandCase of cases) {
  runJsonCommand(commandCase);
}

const repl = spawnSync(process.execPath, [cliPath, "repl"], {
  cwd: process.cwd(),
  encoding: "utf8",
  input: "/exit\n",
});
if (
  repl.status !== 0 ||
  !repl.stdout.includes("THETA 研究训练助手") ||
  !repl.stdout.includes("直接用自然语言回答问题")
) {
  throw new Error(`Deterministic REPL failed: ${repl.stderr || repl.stdout}`);
}

await rm(root, { recursive: true, force: true });

console.log(
  JSON.stringify({
    status: "ok",
    commandCount: cases.length,
    writeBoundary: "human_review_required",
  }),
);
