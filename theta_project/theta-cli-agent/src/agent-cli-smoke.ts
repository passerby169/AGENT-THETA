import { ConversationService } from './conversation/conversation-service.js';
import { runThetaAgentCliCommand } from './agent-cli.js';

const conversation = new ConversationService();

const start = conversation.parseInvocation([
  'start',
  '--file',
  'fixtures/sample.jsonl',
  '--run-id',
  'run-001',
]);
if (
  start.kind !== 'workflow' ||
  start.action !== 'start' ||
  !start.args.includes('run-001')
) {
  throw new Error('Top-level start command was not normalized.');
}

const status = conversation.parseInvocation([
  'status',
  '--run-id',
  'run-001',
  '--json',
]);
if (
  status.kind !== 'status' ||
  status.runId !== 'run-001' ||
  status.json !== true
) {
  throw new Error('Top-level status command was not validated.');
}

const resume = conversation.parseInvocation([
  'resume',
  '--run-id',
  'run-001',
  '--approve',
]);
if (
  resume.kind !== 'workflow' ||
  resume.action !== 'resume' ||
  !resume.args.includes('--approve')
) {
  throw new Error('Top-level resume command was not normalized.');
}

const audit = conversation.parseInvocation([
  'audit',
  'export',
  '--run-id',
  'run-001',
]);
if (audit.kind !== 'audit' || audit.runId !== 'run-001') {
  throw new Error('Audit export command was not validated.');
}

const planShow = conversation.parseInvocation([
  'plan',
  'show',
  '--run-id',
  'run-001',
]);
if (planShow.kind !== 'planShow' || planShow.runId !== 'run-001') {
  throw new Error('Plan show command was not validated.');
}

const planApprove = conversation.parseInvocation([
  'plan',
  'approve',
  '--run-id',
  'run-001',
  '--approved-by',
  'operator-001',
]);
if (
  planApprove.kind !== 'planApprove' ||
  planApprove.approvedBy !== 'operator-001'
) {
  throw new Error('Plan approval command was not validated.');
}

const trainingStatus = conversation.parseInvocation([
  'train',
  'status',
  '--run-id',
  'training-001',
  '--log-limit',
  '80',
]);
if (
  trainingStatus.kind !== 'trainingStatus' ||
  trainingStatus.logLimit !== 80
) {
  throw new Error('Training status command was not validated.');
}

const trainingCancel = conversation.parseInvocation([
  'train',
  'cancel',
  '--run-id',
  'training-001',
  '--reason',
  'operator request',
]);
if (
  trainingCancel.kind !== 'trainingCancel' ||
  trainingCancel.approve !== false
) {
  throw new Error('Training cancellation defaulted to approval.');
}

for (const args of [
  ['evidence', 'show', '--run-id', 'run-001'],
  ['rag', 'build'],
  ['rag', 'status'],
]) {
  conversation.parseInvocation(args);
}

const languageIntent = conversation.parseInvocation([
  'language',
  'intent',
  '--text',
  'show status',
]);
if (
  languageIntent.kind !== 'languageGenerate' ||
  languageIntent.request.task !== 'classify_intent'
) {
  throw new Error('Bounded language intent command was not validated.');
}

const languageQuestion = conversation.parseInvocation([
  'language',
  'question',
  '--text',
  'What is the analysis unit',
  '--field',
  'analysisUnit',
  '--reason',
  'required for comparison',
]);
if (
  languageQuestion.kind !== 'languageGenerate' ||
  languageQuestion.request.task !== 'word_question'
) {
  throw new Error('Bounded question-wording command was not validated.');
}

const languageExplain = conversation.parseInvocation([
  'language',
  'explain',
  '--model-id',
  'theta',
  '--score',
  '84',
  '--confidence',
  'high',
  '--reason-codes',
  'THETA_NATIVE_MODEL,EVIDENCE_SUPPORTED',
]);
if (
  languageExplain.kind !== 'languageGenerate' ||
  languageExplain.request.task !== 'explain_recommendation' ||
  languageExplain.request.recommendation.reasonCodes.length !== 2
) {
  throw new Error('Bounded recommendation explanation was not validated.');
}

const why = conversation.parseReplLine('/why run-001');
if (why.kind !== 'why' || why.runId !== 'run-001') {
  throw new Error('REPL why command was not normalized.');
}

const startPath = conversation.parseReplLine(
  '/start C:\\datasets\\research sample.csv',
);
if (
  startPath.kind !== 'start' ||
  startPath.filePath !== 'C:\\datasets\\research sample.csv'
) {
  throw new Error('REPL did not preserve a dataset path containing spaces.');
}

for (const line of ['/status', '/evidence', '/plan', '/approve', '/save']) {
  conversation.parseReplLine(line);
}

let rejectedFreeText = false;
try {
  conversation.parseReplLine('please start training');
} catch {
  rejectedFreeText = true;
}
if (!rejectedFreeText) {
  throw new Error('REPL accepted unstructured free-form input.');
}

let rejectedUnknownOption = false;
try {
  conversation.parseInvocation(['start', '--file', 'dataset.csv', '--unsafe']);
} catch {
  rejectedUnknownOption = true;
}
if (!rejectedUnknownOption) {
  throw new Error('Agent command accepted an unknown option.');
}

let delegatedKind = '';
const writes: string[] = [];
const exitCode = await runThetaAgentCliCommand(
  ['rag', 'status', '--json'],
  {
    write: (message) => writes.push(message),
    writeError: (message) => {
      throw new Error(message);
    },
  },
  {
    operator: {
      execute: async (invocation) => {
        delegatedKind = invocation.kind;
        return { status: 'ready' };
      },
    },
  },
);
if (
  exitCode !== 0 ||
  delegatedKind !== 'ragStatus' ||
  writes[0] !== '{"status":"ready"}'
) {
  throw new Error('Agent CLI did not delegate the structured RAG command.');
}

console.log(
  JSON.stringify({
    status: 'ok',
    structuredCommands: 22,
    freeFormInput: 'rejected',
  }),
);
