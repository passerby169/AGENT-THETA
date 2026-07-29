import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const loadThetaProjectEnvironment = (): string | undefined => {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  const filename = path.resolve(
    process.env.THETA_ENV_FILE ?? path.join(packageRoot, '..', '.env'),
  );
  if (!existsSync(filename)) return undefined;
  loadEnvFile(filename);
  return filename;
};
