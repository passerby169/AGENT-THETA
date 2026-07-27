# THETA CLI Agent

THETA CLI Agent is a local command-line surface over the THETA Python Bridge.
Every exposed operation is registered in Hypha's `ToolRegistry` and executed
through `GovernedToolRunner`. Read and write permissions, idempotency, audit
events, and human approval are therefore enforced before the bridge is called.

## Requirements

- Node.js 18 or newer
- Python available as `python`, or configured through
  `THETA_AGENT_BRIDGE_PYTHON`
- The sibling `../Hypha` checkout pinned by `../hypha.lock.json`

## Build

```powershell
npm install
npm run hypha:check
npm run build
```

## Run

Show the command reference:

```powershell
npm run cli -- --help
```

Run the safe end-to-end demonstration. This stops at the human-review gate and
does not write plan state:

```powershell
npm run demo
```

After reviewing the example plan, explicitly approve the local write:

```powershell
npm run cli -- demo --approve
```

Run the complete planning lifecycle. This approves the stored plan and derives
training commands, but still does not start training:

```powershell
npm run cli -- demo --approve --approve-plan
```

## Commands

List the THETA model catalog:

```powershell
npm run cli -- models
```

Recommend models from a normalized dataset profile:

```powershell
npm run cli -- recommend --profile fixtures/data-profile.json --goal "time trend topic modeling"
```

Validate a training plan:

```powershell
npm run cli -- plan validate --file fixtures/training-plan.json
```

Request plan creation without writing state:

```powershell
npm run cli -- plan create --file fixtures/training-plan.json
```

Create the plan after explicit approval:

```powershell
npm run cli -- plan create --file fixtures/training-plan.json --approve
```

Approve the stored business plan. Use the `planId` and `planHash` returned by
the previous command:

```powershell
npm run cli -- plan approve --plan-id <id> --plan-hash <hash> --approved-by local_user --approve
```

Preview the exact training commands and expected artifacts:

```powershell
npm run cli -- training dry-run --plan-id <id> --plan-hash <hash>
```

Request a real training start. The first command stops at the Hypha approval
gate and does not start a process:

```powershell
npm run cli -- training start --plan-id <id> --plan-hash <hash> --approval-id <id>
```

After reviewing the resolved plan, approval, commands, and expected artifacts,
repeat with `--approve` to start the background process:

```powershell
npm run cli -- training start --plan-id <id> --plan-hash <hash> --approval-id <id> --approve
```

Read training progress, recent logs, artifacts, and events:

```powershell
npm run cli -- training status --run-id <id> --log-limit 80
```

Request cancellation. Cancellation is not recorded until `--approve` is
explicit:

```powershell
npm run cli -- training cancel --run-id <id> --reason "User requested cancellation"
npm run cli -- training cancel --run-id <id> --reason "User requested cancellation" --approve
```

Add `--json` to any command for machine-readable output.

## Governance Boundary

The command line does not call THETA Python functions directly:

```text
CLI command
  -> Hypha ToolRegistry
  -> GovernedToolRunner
  -> permission, validation, idempotency, approval, and audit
  -> THETA Python Bridge
  -> local THETA state
```

`plan create` is a write operation. Without `--approve`, it returns
`human_review_required` and no local state is written.

`plan approve` is a separate governed write. It records business approval for
the immutable `planId + planHash` pair. `training dry-run` reads that record and
returns commands and artifacts without spawning a training process.

`training start` and `training cancel` are external-effect tools. Both require
the `theta:training:write` permission, an idempotency key, and Hypha human
approval. `training status` is read-only and exposes the event-backed run view.
