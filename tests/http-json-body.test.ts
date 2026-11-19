import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled HTTP Request sends JSON objects and JSON text as the same body', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'n2f-http-json-'));
  let requests = 0;
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests++;
      return Response.json({
        contentType: request.headers.get('content-type'),
        body: await request.json(),
      });
    },
  });

  try {
    const url = `http://127.0.0.1:${receiver.port}`;
    const input = path.join(directory, 'send.json');
    const output = path.join(directory, 'service');
    writeFileSync(input, JSON.stringify({ nodes: [{
      name: 'Send JSON', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      parameters: {
        method: 'POST', url, sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.body }}',
      },
    }] }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_send } = await import(path.join(output, 'workflows', 'send.ts'));
    const payload = { key: 'Résumé', count: 2 };
    const { items } = await workflow_send([
      { json: { body: payload } },
      { json: { body: JSON.stringify(payload) } },
      { json: { body: '["one", 2]' } },
    ]);
    expect(items.map(item => item.json)).toEqual([
      { contentType: 'application/json', body: payload },
      { contentType: 'application/json', body: payload },
      { contentType: 'application/json', body: ['one', 2] },
    ]);
    await expect(workflow_send([{ json: { body: 'invalid-json-fixture' } }]))
      .rejects.toThrow('HTTP Request JSON body must be valid JSON');
    expect(requests).toBe(3);
  } finally {
    await receiver.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
