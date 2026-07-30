import { spawnSync } from 'node:child_process';
import path from 'node:path';

export interface ThetaPythonRuntime {
  executable: string;
  version: string;
  prefix: string;
  condaEnvironment: string | null;
}

export interface ThetaPythonProbe extends ThetaPythonRuntime {
  modules: Record<string, boolean>;
}

const runtimeProbe = [
  'import json, os, sys',
  'print(json.dumps({',
  '  "executable": sys.executable,',
  '  "version": ".".join(map(str, sys.version_info[:3])),',
  '  "prefix": sys.prefix,',
  '  "condaEnvironment": (os.environ.get("CONDA_DEFAULT_ENV") if os.path.normcase(os.path.abspath(os.environ.get("CONDA_PREFIX", ""))) == os.path.normcase(os.path.abspath(sys.prefix)) else os.path.basename(sys.prefix))',
  '}))',
].join('\n');

export const resolveThetaPythonRuntime = (): ThetaPythonRuntime => {
  const requested =
    process.env.THETA_AGENT_PYTHON?.trim() ||
    process.env.THETA_AGENT_BRIDGE_PYTHON?.trim() ||
    'python';
  const result = spawnSync(requested, ['-c', runtimeProbe], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  if (result.error) {
    throw new Error(
      `无法启动 THETA Python（${requested}）：${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `THETA Python 探测失败（${requested}）：${String(result.stderr || result.stdout).trim()}`,
    );
  }
  const parsed = JSON.parse(String(result.stdout).trim()) as Partial<ThetaPythonRuntime>;
  if (!parsed.executable || !path.isAbsolute(parsed.executable)) {
    throw new Error(`Python 未返回有效的绝对解释器路径：${String(parsed.executable)}`);
  }
  return {
    executable: path.resolve(parsed.executable),
    version: String(parsed.version ?? ''),
    prefix: path.resolve(String(parsed.prefix ?? path.dirname(parsed.executable))),
    condaEnvironment:
      typeof parsed.condaEnvironment === 'string' && parsed.condaEnvironment.trim()
        ? parsed.condaEnvironment.trim()
        : null,
  };
};

export const probeThetaPythonModules = (
  modules: readonly string[],
): ThetaPythonProbe => {
  const runtime = resolveThetaPythonRuntime();
  const moduleProbe = [
    'import importlib.util, json, os, sys',
    `modules = ${JSON.stringify(modules)}`,
    'print(json.dumps({',
    '  "executable": sys.executable,',
    '  "version": ".".join(map(str, sys.version_info[:3])),',
    '  "prefix": sys.prefix,',
    '  "condaEnvironment": (os.environ.get("CONDA_DEFAULT_ENV") if os.path.normcase(os.path.abspath(os.environ.get("CONDA_PREFIX", ""))) == os.path.normcase(os.path.abspath(sys.prefix)) else os.path.basename(sys.prefix)),',
    '  "modules": {name: importlib.util.find_spec(name) is not None for name in modules}',
    '}))',
  ].join('\n');
  const result = spawnSync(runtime.executable, ['-c', moduleProbe], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
    },
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout).trim());
  }
  const parsed = JSON.parse(String(result.stdout).trim()) as {
    modules?: Record<string, boolean>;
  };
  return {
    ...runtime,
    modules: parsed.modules ?? {},
  };
};

export const thetaPythonChildEnv = (
  runtime = resolveThetaPythonRuntime(),
): NodeJS.ProcessEnv => ({
  ...process.env,
  THETA_AGENT_PYTHON: runtime.executable,
  THETA_AGENT_BRIDGE_PYTHON: runtime.executable,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
});
