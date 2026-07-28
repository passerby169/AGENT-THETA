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

## Durable Workflow

The complete Agent path is a compiled THETA DomainPack executed by Hypha's
bounded FSM driver. Run, state transitions, approvals, waits, retries, and
terminal output are persisted to SQLite events. Tool audit events use a
separate durable JSONL trace and share the same `runId`.

Compile and inspect the DomainPack before execution:

```powershell
npm run cli -- workflow compile
```

Start a Run. Research intake is deterministic and stops for structured
clarification when blocking facts are missing:

```powershell
npm run cli -- workflow run --file fixtures/sample.jsonl --goal "Discover stable research topics" --run-id theta-run-001
```

Submit research answers through the durable HumanWait:

```powershell
npm run cli -- workflow resume --run-id theta-run-001 --answers fixtures/research-answers.json
```

Dataset inspection records only a sanitized `DatasetProfile`. Confirm the
detected column roles explicitly before model recommendation:

```powershell
npm run cli -- workflow resume --run-id theta-run-001 --columns fixtures/column-confirmation.json
```

Resolve each later approval gate explicitly and continue from persisted
events:

```powershell
npm run cli -- workflow resume --run-id theta-run-001 --approve
```

`--approve-plans` and `--approve-training` apply only to plan and training
approval gates. They never bypass research clarification or column
confirmation:

```powershell
npm run cli -- workflow run --file fixtures/sample.jsonl --approve-plans
npm run cli -- workflow run --file fixtures/sample.jsonl --approve-plans --approve-training
```

Inspect evidence or derive a deterministic replay fixture:

```powershell
npm run cli -- workflow trace --run-id theta-run-001 --json
npm run cli -- workflow replay --run-id theta-run-001 --json
```

The default database is `.theta_agent/theta-workflow.sqlite`. Use
`--runtime-db <path>` on workflow commands to select another file.

## Commands

Inspect an allowed local dataset:

```powershell
npm run cli -- dataset inspect --file fixtures/sample.jsonl
```

Detect text, time, and metadata column candidates:

```powershell
npm run cli -- dataset detect-columns --file fixtures/sample.jsonl
```

Dataset reads default to `fixtures/` and `../THETA/data/`. Add trusted roots
explicitly with the platform path delimiter, and optionally lower the file-size
limit from its 100 MB default:

```powershell
$env:THETA_ALLOWED_DATA_ROOTS = 'E:\trusted-data;E:\research-inputs'
$env:THETA_MAX_DATASET_BYTES = '52428800'
```

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

## Verification

```powershell
npm run hypha:check
npm run typecheck
npm run build
npm run smoke:research-agent
npm run smoke:theta-domain
npm run smoke:theta-workflow
npm run smoke:architecture-boundary
npm run smoke:cli
```

## Governance Boundary

The command line does not call THETA Python functions directly:

```text
CLI command
  -> THETA DomainPack -> FSMProcessSpec
  -> Hypha fenced bounded FSM driver -> SQLite EventRuntime
  -> state-scoped Hypha ToolRegistry
  -> GovernedToolRunner
  -> permission, validation, idempotency, approval, and audit
  -> THETA Python Bridge
  -> local THETA state
```

The Run is event-first: current state and recovery data are rebuilt from
canonical events rather than CLI memory. Human decisions use Hypha runtime
human waits, and training polling uses durable timer waits. Raw dataset rows
and sample values are removed before any tool result is copied into canonical
Run transition events.

Research intake uses strict `ResearchBrief` contracts plus deterministic gap,
conflict, and question-priority rules. It does not call an LLM. Dataset
inspection calculates a SHA-256 identity and stores only bounded observation
data in canonical events. Column confirmations are bound to that hash; a hash
change invalidates the confirmation. The hash is checked again immediately
before training, and a mismatch invalidates the current plan and approvals and
returns the FSM to dataset inspection.

Dataset paths are resolved to their canonical filesystem location before the
Bridge starts. The governed handlers reject missing files, directory escapes,
symlink escapes, unsupported suffixes, non-regular files, and oversized files.
Raw sample rows and sample values are excluded from Hypha audit event payloads.

`plan create` is a write operation. Without `--approve`, it returns
`human_review_required` and no local state is written.

`plan approve` is a separate governed write. It records business approval for
the immutable `planId + planHash` pair. `training dry-run` reads that record and
returns commands and artifacts without spawning a training process.

`training start` and `training cancel` are external-effect tools. Both require
the `theta:training:write` permission, an idempotency key, and Hypha human
approval. `training status` is read-only and exposes the event-backed run view.
