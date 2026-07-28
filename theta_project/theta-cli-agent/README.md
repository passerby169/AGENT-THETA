# THETA CLI Agent

THETA CLI Agent is a local command-line surface over the THETA Python Bridge.
Every exposed operation is registered in Hypha's `ToolRegistry` and executed
through `GovernedToolRunner`. Read and write permissions, idempotency, audit
events, and human approval are therefore enforced before the bridge is called.

## Requirements

- Node.js 22.5 or newer. The local evidence index uses the built-in
  `node:sqlite` API and SQLite FTS5.
- Python available as `python`, or configured through
  `THETA_AGENT_BRIDGE_PYTHON`
- The sibling `../Hypha` checkout pinned by `../hypha.lock.json`

## Build

```powershell
npm install
npm run hypha:check
npm run build
```

Build or incrementally refresh the local evidence index before requesting
evidence-backed recommendations:

```powershell
npm run rag:build
```

The source allowlist is declared in `knowledge/manifest.yaml`. The generated
SQLite file is stored under the ignored `.theta_agent/` directory.

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

Run the governed planning preview. This may create a canonical plan record but
never starts training:

```powershell
npm run cli -- demo --approve
```

## Durable Workflow

The complete Agent path is the versioned `domain.theta.training@3.0.0`
DomainPack executed by Hypha's bounded FSM driver. Run state, transitions,
human decisions, waits, retries, plans, dry-run receipts, and terminal output
are persisted as SQLite events. Tool audit events use a separate durable JSONL
trace and share the same `runId`.

Compile and inspect the DomainPack before execution:

```powershell
npm run cli -- workflow compile
```

Start a Run. Research intake is deterministic and stops for structured
clarification when blocking facts are missing:

```powershell
npm run cli -- workflow run --file fixtures/recommendation-sample.jsonl --goal "Discover stable research topics" --run-id theta-run-001
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

Resolve each later human gate explicitly and continue from persisted events.
The first approval is `HumanPlanReview`; after dry-run, the second is
`HumanTrainingReview`:

```powershell
npm run cli -- workflow resume --run-id theta-run-001 --approve
```

`--approve-plans` and `--approve-training` apply only to their respective
human reviews. They never bypass research clarification, column confirmation,
plan validation, dry-run checks, or the pre-start dataset hash check:

```powershell
npm run cli -- workflow run --file fixtures/recommendation-sample.jsonl --approve-plans
npm run cli -- workflow run --file fixtures/recommendation-sample.jsonl --approve-plans --approve-training
```

Inspect evidence or derive a deterministic replay fixture:

```powershell
npm run cli -- workflow trace --run-id theta-run-001 --json
npm run cli -- workflow replay --run-id theta-run-001 --json
```

The default database is `.theta_agent/theta-workflow.sqlite`. Use
`--runtime-db <path>` on workflow commands to select another file.

## Canonical Plan And Approval Chain

TypeScript is authoritative for `TrainingPlan`. A canonical plan binds the
validated parameters to the dataset SHA-256, confirmed columns, research
brief, dataset profile, recommendation result, DomainPack version, resource
policy, and preprocessing policy. `planHash` is SHA-256 over canonical sorted
JSON and excludes observation fields such as `createdAt`, so equivalent plans
produce the same identity.

The executable chain is:

```text
Validated candidate
  -> HumanPlanReview
  -> canonical TrainingPlan
  -> dry-run checks and DryRunReceipt
  -> HumanTrainingReview bound to dryRunHash
  -> pre-start dataset hash verification
  -> training.start
```

The two approval receipts have different IDs and approval types. Training
cannot start if the plan hash, dry-run hash, dataset hash, or either receipt is
missing or stale. Python validates and executes the supplied chain, but it
does not decide plan identity, approval authority, or FSM state.

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

Recommend models from a normalized dataset profile. Recommendation is a
deterministic TypeScript decision: incompatible models are removed by hard
constraints before scoring, topic count is returned as a range, and each
parameter includes reason codes, confidence, effects, and evidence references:

```powershell
npm run cli -- recommend --profile fixtures/data-profile.json --goal "time trend topic modeling"
```

Validate a training plan:

```powershell
npm run cli -- plan validate --file fixtures/training-plan.json
```

Request canonical plan creation without approving the governed write:

```powershell
npm run cli -- plan create --file fixtures/training-plan.json
```

Create and print the canonical plan record after explicit tool approval:

```powershell
npm run cli -- plan create --file fixtures/training-plan.json --approve
```

`plan approve` remains available only as a legacy compatibility command. It is
not used by the DomainPack 2.0 workflow and is not an authority for training.

```powershell
npm run cli -- plan approve --plan-id <id> --plan-hash <hash> --approved-by local_user --approve
```

Preview the exact training commands and expected artifacts from a complete
request containing `plan`, `planReview`, and `datasetPath`:

```powershell
npm run cli -- training dry-run --file <dry-run-request.json>
```

Request a real training start from a complete request containing `plan`,
`planReview`, `dryRun`, and `trainingReview`. Without `--approve`, the command
stops at the Hypha external-effect gate and does not start a process:

```powershell
npm run cli -- training start --file <training-start-request.json>
```

After reviewing the canonical plan, both approval receipts, commands, checks,
and expected artifacts, repeat with `--approve`:

```powershell
npm run cli -- training start --file <training-start-request.json> --approve
```

The request `idempotencyKey` is bound to the plan, both approvals, and the
dry-run hash. Repeating a queued, running, completed, cancelled, or quarantined
request returns the existing `TrainingReceipt`. A failed run is never restarted
implicitly: create a new key and provide `retryOfTrainingRunId` plus a
`retryReason`.

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

Cancellation is an irreversible governed operation. Its receipt records the
operator, reason, request time, target PID, and graceful or forced termination
outcome. A non-terminal run whose recorded Runner is missing becomes
`quarantined`; it cannot restart automatically. Completed results bind each
expected artifact to its resolved path, existence, type, size, and SHA-256 when
the artifact is a file.

Add `--json` to any command for machine-readable output.

## Verification

```powershell
npm run hypha:check
npm run typecheck
npm run build
npm run smoke:research-agent
npm run smoke:recommendation-golden
npm run smoke:planning-chain
npm run smoke:theta-domain
npm run smoke:theta-workflow
npm run smoke:architecture-boundary
npm run test:python-runtime
npm run smoke:training-runtime
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
  -> local training process and artifacts
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

Evidence retrieval is an explicit governed read from a local SQLite FTS5
index. Every `EvidenceRef` records authority, relative path, source commit,
line range, content hash, excerpt, and final score. Missing evidence remains a
visible `NO_EVIDENCE_AVAILABLE` result and never causes fabricated citations.
The model catalog still comes from the THETA Bridge, while hard constraints,
ranking, topic ranges, parameter recommendations, and relative resource
estimates execute deterministically in TypeScript.

Dataset paths are resolved to their canonical filesystem location before the
Bridge starts. The governed handlers reject missing files, directory escapes,
symlink escapes, unsupported suffixes, non-regular files, and oversized files.
Raw sample rows and sample values are excluded from Hypha audit event payloads.

`plan create` is a governed write that returns a strict, immutable
`TrainingPlanRecord`. In the canonical workflow, `HumanPlanReview` is persisted
by Hypha before plan creation. `training dry-run` consumes that plan and review,
runs deterministic readiness checks, and returns a hash-bound receipt without
spawning a training process.

`training start` requires the canonical plan, `HumanPlanReview`,
`DryRunReceipt`, and a distinct `HumanTrainingReview`, plus the
`theta:training:write` permission, an idempotency key, and Hypha external-effect
approval. `training cancel` is irreversible and requires a separate Hypha
approval. `training status` is read-only and exposes the strict event-backed
`TrainingReceipt`. Unknown recovery state is terminally isolated as
`Quarantined` until an operator reconciles it.
