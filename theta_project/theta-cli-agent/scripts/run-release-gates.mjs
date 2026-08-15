import { spawnSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("release:verify must be started through npm.");
}
const checks = [
  "hypha:check",
  "typecheck",
  "build",
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
