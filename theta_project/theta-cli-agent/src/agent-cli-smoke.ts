import { ConversationService } from './conversation/conversation-service.js';

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

console.log(
  JSON.stringify({
    status: 'ok',
    structuredCommands: 11,
    freeFormInput: 'rejected',
  }),
);
