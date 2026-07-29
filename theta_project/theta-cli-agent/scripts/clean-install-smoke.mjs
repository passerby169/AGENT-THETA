import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const projectRoot = path.dirname(packageRoot);
const repositoryRoot = path.dirname(projectRoot);
const currentHypha = path.join(projectRoot, "Hypha");
const root = await mkdtemp(path.join(os.tmpdir(), "theta-clean-install-"));
const cleanRepository = path.join(root, "THETA-main");
const cleanProject = path.join(cleanRepository, "theta_project");
const cleanAgent = path.join(cleanProject, "theta-cli-agent");
const cleanHypha = path.join(cleanProject, "Hypha");
const knowledgeSources = [
  path.join("THETA", "src", "models", "models_config", "models.yaml"),
  path.join("THETA", "doc", "models", "comparison.md"),
  path.join("THETA", "doc", "appendix", "hardware-requirements.md"),
];
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("release:clean-install must be started through npm.");
}

const run = (command, args, cwd) => {
  console.log(`[clean-install] ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      MINIMAX_API_KEY: "",
    },
    stdio: "inherit",
    shell: process.platform === "win32" && command === pnpm,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? "signal"}.`,
    );
  }
};

const runNpm = (args, cwd) => run(process.execPath, [npmCli, ...args], cwd);

try {
  await mkdir(cleanProject, { recursive: true });
  await cp(packageRoot, cleanAgent, {
    recursive: true,
    filter(source) {
      const relative = path.relative(packageRoot, source);
      const topLevel = relative.split(path.sep)[0];
      return !new Set([
        "node_modules",
        "dist",
        ".theta_agent",
        "package-lock.json",
      ]).has(topLevel);
    },
  });
  await mkdir(path.join(cleanProject, "scripts"), { recursive: true });
  await cp(
    path.join(projectRoot, "scripts", "check-hypha-version.mjs"),
    path.join(cleanProject, "scripts", "check-hypha-version.mjs"),
  );
  await cp(
    path.join(projectRoot, "hypha.lock.json"),
    path.join(cleanProject, "hypha.lock.json"),
  );
  for (const relativePath of knowledgeSources) {
    const destination = path.join(cleanProject, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(projectRoot, relativePath), destination);
  }
  const lock = JSON.parse(
    await readFile(path.join(cleanProject, "hypha.lock.json"), "utf8"),
  );

  run(
    "git",
    ["clone", "--no-hardlinks", "--quiet", currentHypha, cleanHypha],
    cleanProject,
  );
  run("git", ["switch", "--quiet", lock.branch], cleanHypha);
  run("git", ["remote", "set-url", "origin", lock.repository], cleanHypha);
  runNpm(["ci", "--ignore-scripts"], cleanHypha);
  runNpm(["run", "build:packages"], cleanHypha);
  run(pnpm, ["install", "--frozen-lockfile"], cleanAgent);
  runNpm(["run", "hypha:check"], cleanAgent);
  runNpm(["run", "typecheck"], cleanAgent);
  runNpm(["run", "build"], cleanAgent);
  runNpm(["run", "test:contracts"], cleanAgent);
  runNpm(["run", "test:policy"], cleanAgent);
  runNpm(["run", "test:replay"], cleanAgent);
  runNpm(["run", "test:rag-eval"], cleanAgent);

  console.log(
    JSON.stringify({
      status: "ok",
      cleanInstall: true,
      hyphaCommit: lock.commit,
    }),
  );
} finally {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()))) {
    throw new Error("Refusing to remove a clean-install path outside temp.");
  }
  await rm(root, { recursive: true, force: true });
}
