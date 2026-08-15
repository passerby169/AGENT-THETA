# THETA CLI Agent V6

THETA CLI Agent V6 is a local, Hypha-native research and topic-model training
agent. MiniMax makes research decisions and selects tools; Hypha owns
tool governance, durable evidence, ReAct continuation, and the business FSM.

The V6 backend is a clean replacement. The fixed `ResearchIntent` form,
keyword Grilling, Planner V2, and their compatibility commands are not part of
this runtime.

## Implemented foundation

- Direct imports from the local Hypha packages in `../Hypha/packages/*`.
- A compiled THETA DomainPack and guarded business FSM.
- Resumable MiniMax ReAct execution with bounded durable worker quanta. THETA
  does not impose a phase-level model/tool/token budget; no-progress detection,
  Tool policy, provider timeout, Human Wait and FSM guards remain enforced.
- Event-sourced Dataset, Research, and Plan workspaces with canonical hashes.
- Governed dataset tools for overview, authorized random samples, column/text/
  time/category profiles, missingness, duplicates, relationships, and dataset
  understanding submission.
- A Dataset Agent that chooses its own read tools and ordering. The Runtime
  validates evidence receipts and artifact hashes; it does not prescribe a
  tool sequence.
- Event-sourced conversation messages and conversational Checkpoint artifacts.
- DatasetCheckpoint natural-language questions, revisions, rejection and
  principal-bound current-Hash confirmation, resumed through Hypha Human Wait.
- One memory-aware ResearchDialogue inside the same THETA Agent and Reality.
  MiniMax maintains an open ResearchWorkspace, asks at most one consequential
  dataset-grounded question per turn, and may absorb several meanings from one
  answer without a fixed intent form.
- Mandatory ResearchCheckpoint synthesis with deterministic approve or
  natural-language revision feedback. Only direct owner approval can release
  the FSM into `PlanDesign`.
- Hypha native-default Memory composition: MongoDB stores durable versioned
  Dataset/Research understanding, Redis stores scoped working conversation
  memory, and Hypha builds the governed cross-phase context envelope. Raw
  dataset samples are not written to long-term memory.
- A memory-aware `PlanDesign` ReAct phase in the same THETA Agent. MiniMax can
  load one compact case workspace, optionally inspect a small model shortlist,
  optionally retrieve local RAG references, explicitly create/read/revise a
  candidate, and run the Validator through a governed evaluation Tool.
  Each visible Tool keeps one clear lifecycle responsibility; MiniMax chooses
  the legal trajectory rather than being forced into a fixed call count.
- Dynamic Research-to-Plan bindings generated from the current
  ResearchWorkspace. Every consequential accepted decision, preference,
  boundary and assumption is classified as a Planner-owned model decision, an
  inherited DatasetWorkspace fact, a Python-pipeline-managed output, or a
  deliberately excluded non-blocking item. The Validator checks exact governed
  model/seed/hyperparameter paths rather than a fixed ResearchIntent form.
- Event-sourced Candidate Plans, optional-citation audit receipts, Validation
  receipts, and a guarded hash chain. A candidate may cite no RAG object. Any
  ID it does cite must be returned by governed local RAG and exactly bound;
  RAG coverage is never a model-eligibility or completion gate.
- A deliberately small candidate presentation for CLI/Web consumers. MiniMax
  chooses one model, one random seed and that model's executable
  hyperparameters, with one plan-specific natural-language explanation and a
  Validator receipt. References appear only when the candidate actually uses
  legal RAG objects. Dataset columns
  are inherited from the confirmed DatasetWorkspace; preprocessing, metrics,
  quality checks and visualizations are generated automatically by Python and
  are not Planner choices.
- Safe append-only activity events for MiniMax reasoning boundaries and Tool
  execution. CLI and Web API consumers receive semantic gate progress and
  user-facing activity copy, never prompts, chain-of-thought, raw samples or
  raw Tool output. The Web API also exposes an SSE activity stream.
- A mandatory, conversational `PlanConfirmation` phase in the same THETA
  Agent. Users can ask grounded questions without approving, request a
  revision, reject the candidate, or unconditionally confirm the exact current
  candidate hash.
- Principal-bound PlanApproval receipts that bind the PlanCheckpoint,
  PlanWorkspace, candidate, evidence and validation hashes. Only that complete
  chain can release the FSM into `CreatePlan`.
- PlanDesign completion preflight that returns explicit protocol feedback when
  MiniMax confuses a candidate hash with the current PlanWorkspace hash; the
  Agent must correct its own native action before the FSM evaluates it.
- Bounded retry of transient MiniMax network, timeout, 429 and 5xx failures.
  Authentication, contract and business validation failures are never retried
  as if they were transient.

The V6 backend now also materializes the approved Canonical Plan, performs a
side-effect-free Dry Run, requires a second exact-hash training confirmation,
re-verifies dataset bytes and columns, and then exposes governed start,
progress, cancellation, artifact verification and manifest-only result reads.
The training confirmation itself cannot call `training.start`; only the
`StartTraining` FSM state can do so.

## Environment

Use the `theta` Conda environment and build Hypha before this package:

```cmd
conda activate theta
cd /d D:\THETA\theta_project\Hypha
npm run build:packages
cd /d D:\THETA\theta_project\theta-cli-agent
pnpm install --no-frozen-lockfile
pnpm run build
```

MiniMax configuration is loaded from `D:\THETA\theta_project\.env`. Keep API
keys local and never commit that file.

The native Memory runtime expects a MongoDB Replica Set and Redis. Defaults are
`mongodb://127.0.0.1:27017/?replicaSet=rs0&directConnection=true`, database
`theta_memory`, and `redis://127.0.0.1:6379/0`. Override them with
`MONGODB_URI`, `MONGODB_DATABASE`, and `REDIS_URL` when needed.

## DatasetDiscovery workflow

### Guided interactive experience

Run `theta` in Anaconda Prompt to enter the continuous THETA Agent session:

```cmd
conda activate theta
cd /d D:\THETA\theta_project\theta-cli-agent
theta
```

If the package is not globally linked, use:

```cmd
pnpm run cli
```

The session presents a welcome screen and first asks for the research
direction and optional authorization for at most ten locally redacted samples.
It then creates a dataset-free Run in `Intake`. MiniMax decides when data is
needed and calls `theta.dataset.request_upload`; only then does the CLI show a
drag-or-paste upload card. The CLI Host converts the selected file into a
Run-scoped opaque `attachmentRef`, without exposing the local path to MiniMax.
MiniMax must call `theta.dataset.ingest_attachment` to validate, hash,
deduplicate, manage and register it as a `datasetRef`. From that point the
session follows the Hypha FSM automatically and displays Agent thinking and
Tool calls as they happen; users do not need to copy `runId` values into phase
commands.

Questions raised by MiniMax during data exploration or research grilling use
ordinary natural-language input. Exactly three completed artifacts use the
two-choice final card: Dataset understanding, Research intent, and Training
plan. Choosing `1` confirms the exact current artifact without a model call;
choosing `2` asks for a natural-language reason and sends that feedback back
to the same intelligent phase. Training start remains a separate explicit
side-effect authorization.

`theta start` without `--file` opens the same guided session. Supplying
`--file` keeps the non-interactive workflow below for scripts and debugging.

The governed Intake boundary is:

```text
local path (CLI Host only)
  -> attachmentRef (Run-scoped, visible to MiniMax)
  -> theta.dataset.ingest_attachment
  -> datasetRef (managed and immutable by hash)
  -> DatasetDiscovery
```

### Manual and automation commands

Create a Run first. Remote samples are optional; authorization allows the
Agent to read at most ten locally redacted rows, but does not force it to use
the sample tool.

```cmd
pnpm run cli -- start --file "D:\data\documents.csv" --goal "探索这份数据可支持什么研究" --allow-remote-samples --json
```

Copy the returned `runId`, then let MiniMax autonomously conduct data
discovery:

```cmd
pnpm run cli -- workflow discover --run-id "theta-run-..." --json
pnpm run cli -- workflow checkpoint --run-id "theta-run-..."
pnpm run cli -- workflow decide --run-id "theta-run-..." --approve --json
pnpm run cli -- workflow decide --run-id "theta-run-..." --revise --text "source 只用于展示分组，修改后再次让我确认" --json
pnpm run cli -- workflow conversation --run-id "theta-run-..." --json
pnpm run cli -- workflow research --run-id "theta-run-..." --json
pnpm run cli -- workflow plan --run-id "theta-run-..." --json
pnpm run cli -- workflow activity --run-id "theta-run-..." --json
pnpm run cli -- status --run-id "theta-run-..." --json
pnpm run cli -- audit export --run-id "theta-run-..." --json
```

MiniMax may choose any legal read-tool trajectory. Successful completion
requires it to submit a DatasetWorkspace supported by real observation
receipts and propose the exact returned workspace hash. The FSM independently
decides whether the transition is legal.

Dataset, research, and plan confirmations use deterministic decisions. An
interactive terminal presents two choices: approve and enter the next phase,
or revise and explain why. Approval never invokes MiniMax. Revision persists
the feedback and returns it to the owning intelligent phase. HTTP clients use
`POST /api/v3/runs/:runId/checkpoint-decision` with the current
`checkpointId`, `expectedContentHash`, and either `action=approve` or
`action=revise` plus `feedback`.

Intermediate questions inside DatasetDiscovery and ResearchDialogue remain
ordinary conversation. Reply with `workflow message --text "..."`; the answer
is persisted to Hypha Memory and the same Agent resumes the current phase.
Only completed Dataset, Research, and Plan artifacts render the two-choice
confirmation card.

## Server dataset upload

The V3 HTTP API accepts a streamed multipart upload and returns an opaque
`datasetRef`. Uploaded content is stored under a server-managed directory,
named by its SHA-256 content hash and deduplicated. API responses never expose
the managed filesystem path.

```bash
curl -F "file=@dataset.csv" http://127.0.0.1:4318/api/v3/datasets/upload
curl http://127.0.0.1:4318/api/v3/datasets
curl -X POST http://127.0.0.1:4318/api/v3/runs \
  -H "Content-Type: application/json" \
  -d '{"datasetRef":"dataset_...","researchGoal":"分析主要主题","allowRemoteSamples":false}'
```

After mandatory plan confirmation, the backend training chain uses these V3
routes. `advance-training` performs exactly the action legal in the current
state: dataset verification, one idempotent start, one progress poll plus
terminal artifact verification, or verified result evaluation. Calling it
while training is active is safe and does not start a second run.

```bash
curl -X POST http://127.0.0.1:4318/api/v3/runs/RUN_ID/prepare-training
curl -X POST http://127.0.0.1:4318/api/v3/runs/RUN_ID/messages \
  -H "Content-Type: application/json" \
  -d '{"content":"我明确、无条件批准启动当前训练方案"}'
curl -X POST http://127.0.0.1:4318/api/v3/runs/RUN_ID/advance-training
curl -X POST http://127.0.0.1:4318/api/v3/runs/RUN_ID/cancel-training \
  -H "Content-Type: application/json" \
  -d '{"content":"用户主动停止本次训练"}'
```

Relevant server configuration:

- `THETA_DATASET_UPLOAD_DIR`: managed upload directory. Defaults to
  `.theta_agent/uploads` below the Agent root.
- `THETA_MAX_DATASET_BYTES`: per-file upload limit in bytes. Defaults to 1 GiB; lower it on constrained servers if needed.
- `THETA_WEB_ALLOW_LOCAL_FILE_PATH=true`: explicitly enables the local-only
  `filePath` Run input. It is disabled by default for the HTTP API; server
  clients should upload and use `datasetRef`.

Supported suffixes are `.csv`, `.tsv`, `.json`, `.jsonl`, `.txt`, `.xlsx`,
`.xls`, and `.parquet`. The upload must contain exactly one multipart field
named `file`.

Large `.xlsx` workbooks use `openpyxl` read-only streaming. THETA keeps the
first ten rows and a bounded deterministic reservoir for profiling instead of
materializing the complete worksheet in pandas. `openpyxl` is required for
XLSX; `xlrd` and `pyarrow` are optional engines for legacy XLS and Parquet.

## Verification

Deterministic release gates:

```cmd
pnpm run release:verify
pnpm run acceptance:v10c-training-lifecycle
```

`acceptance:v10c-training-lifecycle` uses a fake inference provider and
synthetic completed receipts. It does not launch a real training process.

Real MiniMax two-dataset DatasetDiscovery acceptance (network/API usage):

```cmd
pnpm run acceptance:v6-minimax-dataset
pnpm run acceptance:v6-minimax-checkpoint
pnpm run acceptance:v7-research
pnpm run acceptance:v8-plan
pnpm run acceptance:v9-plan-confirmation
pnpm run acceptance:v10-planning-ux
pnpm run acceptance:v7-minimax-research
pnpm run acceptance:v10-minimax-chain
```

`acceptance:v10-minimax-chain` performs two independent real MiniMax chains from
Run creation through DatasetDiscovery, ResearchDialogue, PlanDesign, plan
question handling, exact-hash confirmation and the `CreatePlan` boundary. It
also asserts the efficient composite Tool path, exact research-intent bindings,
display-versus-training column roles, full plan presentation and semantic
activity progress. Real acceptances create temporary datasets outside the
repository and remove them after execution. They do not persist samples or
print secrets.
