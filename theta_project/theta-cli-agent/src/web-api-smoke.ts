import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createThetaWebApiServer } from './web-api/server.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'theta-web-api-smoke-'));
const server = createThetaWebApiServer({
  agentRoot: process.cwd(),
  runtimeDb: path.join(root, 'runtime.sqlite'),
  host: '127.0.0.1',
  port: 4318,
});

try {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const runsResponse = await requestJson(`${baseUrl}/api/v2/runs?limit=3`);
  const runs = runsResponse.body as {
    ok: boolean;
    data: { runs: unknown[] };
  };
  assert.equal(runsResponse.statusCode, 200);
  assert.equal(runs.ok, true);
  assert.deepEqual(runs.data.runs, []);

  const writeResponse = await requestJson(`${baseUrl}/api/v2/runs`, 'POST');
  assert.equal(writeResponse.statusCode, 405);

  const missingResponse = await requestJson(`${baseUrl}/api/v2/missing`);
  assert.equal(missingResponse.statusCode, 404);

  console.log(JSON.stringify({ status: 'ok', readOnly: true, version: 'v2' }));
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await rm(root, { recursive: true, force: true });
}

async function requestJson(
  url: string,
  method = 'GET',
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}
