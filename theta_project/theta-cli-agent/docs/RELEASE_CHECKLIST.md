# Release Checklist

Use this checklist for a THETA CLI Agent release candidate. Run all commands
from `theta_project/theta-cli-agent`.

## Source And Dependencies

- The outer repository is on the intended source branch.
- `git status --short` is empty before release packaging.
- `../hypha.lock.json` identifies the reviewed Hypha repository, branch, and
  commit.
- The CLI package retains `fast-json-stable-stringify` as a compatibility
  dependency for the pinned `@hypha/domain` runtime.
- `npm run hypha:check` passes.
- `.env`, API keys, runtime databases, model outputs, datasets, and
  `.theta_agent/` are not tracked.

## Deterministic Gates

Run:

```bash
npm run release:verify
```

The gate covers TypeScript compilation, strict public contracts, policy
decisions, event-derived Replay, RAG evaluation, architecture boundaries,
workflow behavior, training controls, CLI behavior, and the Python Bridge
test suite. It does not call MiniMax or start a real training process.

## Clean Installation

Run:

```bash
npm run release:clean-install
```

This creates a temporary project, checks out the exact Hypha commit from
`hypha.lock.json`, installs both dependency sets from their lock files, builds
Hypha packages, builds the CLI, and runs the release contract suites. The
temporary project is removed after the check.

## Manual Operator Check

```bash
npm run cli -- --help
npm run cli -- doctor --json
npm run cli -- rag build --json
npm run cli -- ask "show current run status" --json
```

Do not approve external language generation or training during a release
smoke check unless that external effect is explicitly part of the release
test plan.

## Release Evidence

Record:

- Outer repository commit.
- Hypha pinned commit.
- Node.js, npm, pnpm, and Python versions.
- `release:verify` result.
- `release:clean-install` result.
- Known environment-specific limitations.

Replay acceptance requires the versioned fixture to match the canonical
event stream and must not execute a tool, Python Bridge command, training
process, or language-provider request.
