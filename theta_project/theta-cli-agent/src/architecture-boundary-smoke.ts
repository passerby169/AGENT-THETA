import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const sourceRoot = resolve(process.cwd(), 'src');
const removedLegacyFiles = [
  'tools/hypha-compatible.ts',
  'tools/registry.ts',
  'tools/specs.ts',
  'tools/executors.ts',
  'tools/json-schema.ts',
];

const collectTypeScriptFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        return collectTypeScriptFiles(fullPath);
      }
      return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
    })
  );
  return nested.flat();
};

const files = await collectTypeScriptFiles(sourceRoot);
const relativeFiles = new Set(
  files.map((file) => relative(sourceRoot, file).replaceAll('\\', '/'))
);

for (const legacyFile of removedLegacyFiles) {
  if (relativeFiles.has(legacyFile)) {
    throw new Error(`Legacy local governance abstraction still exists: ${legacyFile}`);
  }
}

for (const file of files) {
  const relativeFile = relative(sourceRoot, file).replaceAll('\\', '/');
  const source = await readFile(file, 'utf8');
  if (relativeFile === 'architecture-boundary-smoke.ts') {
    continue;
  }
  const isToolHandler = relativeFile.startsWith('tools/') && relativeFile.endsWith('-tool.ts');
  const isBridgeAdapter = relativeFile === 'tools/bridge.ts';
  const isSmoke = relativeFile.endsWith('-smoke.ts');
  const isAgentCli = relativeFile === 'agent-cli.ts';
  const isConversationLayer = relativeFile.startsWith('conversation/');
  const isMiniMaxProvider = relativeFile === 'providers/minimax.ts';

  if (source.includes('callThetaBridge') && !isToolHandler && !isBridgeAdapter) {
    throw new Error(`Bridge call escaped a governed Tool Handler: ${relativeFile}`);
  }
  if (
    (source.includes("from 'node:child_process'") ||
      source.includes('from "node:child_process"')) &&
    !isBridgeAdapter &&
    !isSmoke
  ) {
    throw new Error(`Direct process execution escaped the Bridge Adapter: ${relativeFile}`);
  }
  if (
    ((source.includes('fetch(') || source.includes('fetch (')) &&
      !isMiniMaxProvider) ||
    (source.includes('api.minimax.io') &&
      !isMiniMaxProvider &&
      !isSmoke)
  ) {
    throw new Error(
      `Direct language-provider network access escaped providers/minimax.ts: ${relativeFile}`,
    );
  }
  if (
    (isAgentCli || isConversationLayer) &&
    (source.includes('callThetaBridge') ||
      source.includes('createThetaWorkflowRuntime') ||
      source.includes("from 'node:fs") ||
      source.includes('from "node:fs'))
  ) {
    throw new Error(
      `CLI/conversation layer bypassed a service boundary: ${relativeFile}`
    );
  }
  if (
    source.includes('hypha-compatible') ||
    source.includes("from './registry.js'") ||
    source.includes("from './specs.js'") ||
    source.includes("from './executors.js'")
  ) {
    throw new Error(`Legacy governance import remains: ${relativeFile}`);
  }
}

console.log(
  JSON.stringify({
    status: 'ok',
    checkedFiles: files.length,
    bridgeBoundary: 'governed-tool-handler-only',
    conversationBoundary: 'structured-command-and-workflow-service-only',
    legacyGovernanceFiles: 0,
  })
);
