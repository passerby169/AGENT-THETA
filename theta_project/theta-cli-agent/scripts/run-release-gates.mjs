import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("release:verify must be started through npm.");
}
const checks = [
  "hypha:check",
  "typecheck",
  "build",
  "test:contracts",
  "test:policy",
  "test:replay",
  "test:rag-eval",
  "smoke:architecture-boundary",
  "smoke:theta-domain",
  "smoke:research-agent",
  "smoke:recommendation-golden",
  "smoke:golden-transcripts",
  "smoke:planning-chain",
  "smoke:hypha-runner",
  "smoke:hypha-training-controls",
  "smoke:training-runtime",
  "smoke:operator-commands",
  "smoke:conversation-ux",
  "smoke:ux-recovery",
  "smoke:web-api",
  "smoke:rag-governance",
  "smoke:language-governance",
  "smoke:cli",
  "test:python-runtime",
];

for (const check of checks) {
  console.log(`\n[release] npm run ${check}`);
  const result = spawnSync(process.execPath, [npmCli, "run", check], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(
  JSON.stringify({
    status: "ok",
    releaseChecks: checks.length,
  }),
);
