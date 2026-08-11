# THETA CLI Agent

## UX 2.0

The default CLI is now researcher-facing: it renders concise Chinese
explanations, progress, warnings, and an explicit next action instead of
printing Runtime JSON. Use `--json` for automation and `/details` in the REPL
for the previous raw response.

On Windows, build once and use the local launcher:

```cmd
pnpm run build
theta doctor
theta repl
```

The conversational flow includes a two-layer research interview, natural
column confirmation, a readable recommendation card, natural parameter
adjustment, separately named plan/training approvals, automatic training
follow, and a result center:

```text
/next
/brief
/done
/plan
/adjust 把主题数改成 8
/adjust 只运行一次，随机种子 42
/adjust 用 LDA 做对照，种子 42、73
/adjust 做稳定性复验，种子 17、42、73
/approve-plan
/start-training
/follow
/logs
/results
/open-results
/summary
```

See [`docs/UX_V2.md`](docs/UX_V2.md) for the presentation and interaction
contracts.

THETA CLI Agent is a local command-line surface over the THETA Python Bridge.
Every exposed operation is registered in Hypha's `ToolRegistry` and executed
through `GovernedToolRunner`. Read and write permissions, idempotency, audit
events, and human approval are therefore enforced before the bridge is called.

## Validator V2 and automatic topic counts

Training plans are checked against the local Model Catalog and audited
Capability Cards at four boundaries: `plan.validate`, `plan.create`,
`training.dry_run`, and `training.start`. Model-specific parameters cannot be
passed to another model, and the Python Bridge recomputes plan/dry-run hashes
and training commands before starting a process.

HDP and BERTopic use explicit topic-count semantics:

```json
{"modelId":"hdp","topicCountMode":"auto","numTopics":null,"maxTopics":80}
{"modelId":"bertopic","topicCountMode":"auto","numTopics":null}
{"modelId":"bertopic","topicCountMode":"target_reduction","numTopics":12}
```

Model selection and experiment scheduling are separate decisions. Every
canonical plan contains an `experimentProtocol`: `quick` runs the selected
primary model once, `comparative` runs an explicitly selected baseline, and
`stability` repeats the primary model with at least three distinct seeds.
MiniMax may propose that protocol, but the Catalog Resolver and Validator V2
bound its models, seeds, evidence, and maximum run count. The Python Bridge
executes only the approved protocol; it never adds an LDA baseline or extra
random seeds implicitly.

For offline BERTopic runs, `SBERT_MODEL_PATH` must point to an existing local
model directory; the Dry Run blocks training when that asset cannot be
verified.

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
evidence-backed recommendations. The operator command executes the index write
through Hypha policy, schema validation, trace, and Harness hooks:

```powershell
npm run cli -- rag build
npm run cli -- rag status
```

The source allowlist is declared in `knowledge/manifest.yaml`. Structured
Knowledge V1 is split across `knowledge/structured/v1.yaml`,
`papers-models-v1.yaml`, and `papers-evaluation-v1.yaml`. Together they cover
88 auditable objects across models, parameters, rules, recipes, metrics,
failure modes, implementation capabilities, project constraints, conflicts,
and paper sources. The generated SQLite file is stored under the ignored `.theta_agent/`
directory. Retrieval combines exact scoped aliases, raw FTS, Chinese token FTS,
and Chinese n-gram FTS with weighted RRF, authority adjustment, source caps,
and model/parameter/preprocessing/evaluation/resource/failure/paper coverage.
`npm run rag:build` is a convenience alias for the same governed command.

Before planning, Hybrid RAG derives separate queries for model selection,
hyperparameters, preprocessing, evaluation, resources, and failure diagnosis.
It then performs a second candidate-specific retrieval pass and compiles the
results into a hashed `EvidenceBundle`. The bundle records query traces,
authority coverage, paper/implementation conflicts, and unresolved evidence
gaps. MiniMax receives this bundle instead of an unstructured excerpt list.
L1/L2 implementation evidence controls executability; L3/L4 papers can justify
research choices but cannot override Capability Cards or Validator V2. The
formal TrainingPlan binds hashes for the EvidenceBundle, Planner proposal, and
Resolver decision so the approval can be audited later.

## Run

Show the command reference:

```powershell
npm run cli -- --help
```

Check the complete local environment before starting a Run:

```powershell
npm run cli -- doctor
```

`doctor` reports `PASS`, `WARN`, or `FAIL` for Node.js, pnpm workspace
metadata, the pinned Hypha build, DomainPack compilation, Runtime SQLite,
artifact and dataset roots, THETA configuration, the governed Python model
catalog, GPU visibility, and optional MiniMax configuration. Every failed
check includes a concrete remediation.

MiniMax is optional. Its bounded Planner first returns a compact decision
skeleton: model roles, at most three parameter candidates per model, and the
experiment protocol. Preprocessing, evaluation, visualizations, defaults, and
all executable fields are expanded locally from the catalog. This keeps the
provider response small enough to parse reliably without transferring local
authority to the model. A malformed skeleton receives one smaller JSON repair
attempt. A mandatory second inference stage must call the local
`select_evidence` function tool exactly once; each decision target's tool
schema exposes only semantically compatible aliases from the current Evidence
Bundle and returns canonical evidence IDs. Missing calls, unknown aliases,
duplicate targets, or incomplete target coverage invalidate only the evidence
stage and trigger one compact evidence retry; the accepted decision skeleton
is not regenerated. MiniMax
cannot make an unrelated citation valid merely by choosing an in-bundle ID:
every binding is checked locally against the target model, parameter, purpose,
THETA support status, and authority level. Accepted and rejected attempts emit
an `EvidenceSelectionReceipt` that is stored with the plan review. An empty
selection lowers confidence; the recommender never falls back to unrelated
evidence to award `EVIDENCE_SUPPORTED`.
MiniMax cannot resolve executable parameters, generate a
command, set hashes or permissions, approve a plan, or start training. A
deterministic Catalog Resolver projects the draft onto Capability Registry
fields, then Validator V2 remains authoritative at plan validation, plan
creation, Dry Run, and training start. With no key, network
failure, timeout, invalid JSON, schema failure, illegal intent, an invented
column, or a tool outside the state allowlist, the language layer falls back
to deterministic behavior. It may interpret research answers, word the next
Grilling question, parse column confirmation, propose an allowlisted read-only
tool, and compose an evidence-grounded response. The FSM, field authority,
tool policy, plan approval, and training controls remain deterministic.

Configure the optional provider in `../.env`:

```dotenv
MINIMAX_API_KEY=
MINIMAX_API_BASE=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M2.7
MINIMAX_TIMEOUT_MS=60000
MINIMAX_PLANNER_TIMEOUT_MS=120000
THETA_RESULT_ANALYSIS_TIMEOUT_MS=120000
```

`MINIMAX_TIMEOUT_MS` controls normal conversational language calls.
`MINIMAX_PLANNER_TIMEOUT_MS` controls only the bounded Planner and defaults to
120 seconds, so a slow plan does not loosen the latency budget for ordinary
Grilling turns.
`THETA_RESULT_ANALYSIS_TIMEOUT_MS` controls the result-analysis assistant only
and defaults to 120 seconds because selected result attachments require a
longer explanation budget than workflow clarification turns.

The key is ignored by Git. The compiled CLI loads `../.env` at startup, or the
file selected by `THETA_ENV_FILE`. Existing process environment variables keep
their precedence. `doctor` only reports whether the key is present and never
prints it.

The operator-facing aliases keep CLI responsibilities limited to arguments,
terminal I/O, and confirmation:

```powershell
npm run cli -- start --file fixtures/recommendation-sample.jsonl --run-id theta-run-001
npm run cli -- status --run-id theta-run-001
npm run cli -- resume --run-id theta-run-001 --columns fixtures/column-confirmation.json
npm run cli -- audit export --run-id theta-run-001 --json
npm run cli -- plan show --run-id theta-run-001
npm run cli -- evidence show --run-id theta-run-001
```

These aliases delegate to `ThetaWorkflowService`; they do not read Runtime
SQLite, call Python, create approvals, or execute tools directly.

Research clarification and column confirmation also have natural-language
operator aliases:

```powershell
npm run cli -- answer --run-id theta-run-001 --text "我想研究不同来源的风险主题如何变化"
npm run cli -- columns --run-id theta-run-001 --text "text 是正文，created_at 是时间，source 是元数据"
```

Review and approve only the canonical Runtime plan gate:

```powershell
npm run cli -- plan show --run-id theta-run-001
npm run cli -- plan approve --run-id theta-run-001 --approved-by local_user
```

`plan approve --run-id` fails unless the Run is currently waiting at
`HumanPlanReview`. It cannot approve column confirmation, training review, or
another HumanWait.

Read or cancel a training process through governed operator commands:

```powershell
npm run cli -- train status --run-id <training-run-id> --log-limit 80
npm run cli -- train cancel --run-id <training-run-id> --reason "Operator request"
npm run cli -- train cancel --run-id <training-run-id> --reason "Operator request" --approve
```

The first cancellation command only returns the approval gate. No cancellation
is recorded until the operator repeats the same request with `--approve`.

Use the bounded language surface. When MiniMax is configured, the first command
returns a Hypha human-review gate because sanitized context would leave the
local machine. Repeat the same command with `--approve` only after reviewing
that transfer. Without MiniMax, the same commands complete deterministically
without an external call:

```powershell
npm run cli -- language intent --text "show the current status"
npm run cli -- language question --text "What is the analysis unit" --field analysisUnit --reason "required for comparison"
npm run cli -- language explain --model-id theta --score 84 --confidence high --reason-codes "THETA_NATIVE_MODEL,EVIDENCE_SUPPORTED"
```

MiniMax output is candidate-only and schema-bound. A tool proposal is checked
against a fixed read-only allowlist before local execution. MiniMax cannot
mutate an FSM transition, alter system-observed dataset fields, approve a
plan, or start training.

For a persistent conversational loop:

```powershell
npm run cli -- repl --run-id theta-run-001
```

Normal text is automatically routed to the FSM action currently waiting:
ResearchClarification becomes a research answer and ColumnConfirmation becomes
a column answer. Outside a structured wait, normal text is classified and may
invoke only status, evidence, local RAG search, or model catalog reads.

Column roles are deliberately separate. `covariateColumns` are the only
columns passed into STM or another covariate-aware model;
`groupingColumns` are only for post-hoc comparison and presentation;
`metadataColumns` are descriptive; `evaluationLabelColumns` are held out from
training. One physical column may be both an explicitly confirmed training
covariate and display group, but the CLI never promotes a display group into a
covariate automatically. With MiniMax disabled, the first deterministic parse
is only a review draft. Submit a second statement beginning with `确认：` before
the FSM accepts it. Both provider and deterministic drafts are checked against
sampled inferred types, text length, ID uniqueness, datetime parseability, and
low-cardinality covariate/group characteristics.

Use `/llm on` to grant bounded MiniMax consent for the current persisted
session and `/llm off` to revoke it. `/answer`, `/columns`, `/history`, and
`/brief` expose the conversational workflow explicitly. Existing `/start`,
`/status`, `/why`, `/evidence`, `/plan`, `/approve`, `/save`, `/back`, and
`/exit` commands remain available. Language consent never counts as plan or
training approval. When `/llm on` precedes `/start`, the same session consent
also enables `theta.plan.propose`; otherwise the FSM records a deterministic
Planner draft with an explicit fallback reason.

Use `/why model`, `/why parameters`, `/why protocol`, or `/why evidence` to
inspect one decision layer without opening raw JSON. `/plan` shows the selected
model's maturity, the reasons alternatives were not selected, uncertainty,
and evidence-binding receipts. Long language/planning turns display staged
progress while raw provider payloads remain in technical details.

Capability Cards distinguish `production`, `experimental`, `incomplete`, and
`unavailable` models. The current DTM is an executable but experimental dynamic
neural implementation; plans must disclose that boundary and still require
human approval.

Conversation messages, structured interpretations, turn recovery metadata,
and immutable ResearchBrief revisions share the selected Runtime SQLite file.
They are restored when the CLI restarts. Canonical workflow Replay still
derives only from Runtime events and never calls MiniMax or executes a tool.
See `docs/CONVERSATIONAL_AGENT.md` for the contracts and storage layout.

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
npm run cli -- plan validate --file <planner-v2-bundle.json>
```

Request canonical plan creation without approving the governed write:

```powershell
npm run cli -- plan create --file <planner-v2-bundle.json>
```

Create and print the canonical plan record after explicit tool approval:

```powershell
npm run cli -- plan create --file <planner-v2-bundle.json> --approve
```

`plan approve` remains available only as a legacy compatibility command. It is
not used by the DomainPack 3.0 workflow and is not an authority for training.

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
`retryReason`. The same explicit retry protocol is allowed when execution
completed but the persisted quality gate is `failed`; the original artifacts
and receipt remain immutable.

In the REPL, `/retry` has two governed forms. Before training, a terminal
Planner/tool-contract failure creates a successor workflow Run linked by
`recoveryOfRunId`, restores the ResearchBrief, rechecks the dataset hash and
column types, and reruns planning with fresh approvals. After training, it
creates a new training attempt only for execution failure or quality failure.
`/reevaluate` does not train: it rebinds the current run-scoped artifact paths
and recomputes the quality gate in memory without overwriting the original
quality receipt.

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

Run the complete deterministic release gate:

```powershell
npm run release:verify
```

Verify a clean dependency installation and build in a disposable directory:

```powershell
npm run release:clean-install
```

The clean-install check uses the exact Hypha commit in
`../hypha.lock.json`. Neither release command calls MiniMax or starts real
training. The operator checklist is documented in
[`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md).

Individual checks remain available:

```powershell
npm run hypha:check
npm run typecheck
npm run build
npm run test:contracts
npm run test:policy
npm run test:replay
npm run test:rag-eval
npm run test:knowledge-v1
npm run test:planner
npm run smoke:research-agent
npm run smoke:recommendation-golden
npm run smoke:planning-chain
npm run smoke:theta-domain
npm run smoke:theta-workflow
npm run smoke:architecture-boundary
npm run test:python-runtime
npm run smoke:training-runtime
npm run smoke:agent-cli
npm run smoke:operator-commands
npm run smoke:rag-governance
npm run smoke:language-governance
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

Evaluation metrics are saved with `status`, `method`, `comparable`, and error
provenance. A failed C_V, UMass, Exclusivity, or perplexity computation is
reported as unavailable; another metric or a magic default is never written
under its name. Training quality gates apply shared numerical checks plus
model-specific DTM, STM, BERTopic, and HDP diagnostics.

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
