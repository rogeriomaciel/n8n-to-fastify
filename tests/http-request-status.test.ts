import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled HTTP Request rejects non-2xx responses unless Never Error is enabled', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-http-status-'));
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const failed = new URL(request.url).pathname === '/unavailable';
      return Response.json(failed ? { private: 'fixture response body' } : { success: true }, {
        status: failed ? 503 : 200,
      });
    },
  });
  try {
    const file = path.join(dir, 'request.json');
    const run = async (name: string, neverError?: boolean | string, typeVersion = 4.2) => {
      const service = path.join(dir, name);
      writeFileSync(file, JSON.stringify({
        nodes: [{
          name: 'Request', type: 'n8n-nodes-base.httpRequest', typeVersion,
          parameters: {
            url: '={{ $json.url }}',
            options: typeVersion < 3 ? { ignoreResponseCode: neverError } : { response: { response: { neverError } } },
          },
        }],
      }));
      const compile = Bun.spawnSync([
        process.execPath, path.resolve('bin/cli.ts'), 'compile', file, '--out', service, '--strict',
      ]);
      expect(compile.exitCode).toBe(0);
      const { workflow_request } = await import(path.join(service, 'workflows', 'request.ts'));
      return workflow_request;
    };
    const unavailable = new URL('/unavailable?token=fixture', receiver.url).href;
    const request = await run('default');
    const success = await request([{ json: { url: String(receiver.url) } }]);
    expect(success.items).toEqual([{ json: { success: true } }]);
    await expect(request([{ json: { url: unavailable } }]))
      .rejects.toThrow(/^HTTP Request failed with status 503$/);

    const allowErrors = await run('never-error', true);
    const ignored = await allowErrors([{ json: { url: unavailable } }]);
    expect(ignored.items).toEqual([{ json: { private: 'fixture response body' } }]);

    for (const version of [1, 2]) {
      const legacy = await run('legacy-' + version, true, version);
      expect((await legacy([{ json: { url: unavailable } }])).items).toEqual(ignored.items);
      const legacyDefault = await run('legacy-default-' + version, undefined, version);
      await expect(legacyDefault([{ json: { url: unavailable } }])).rejects.toThrow('HTTP Request failed with status 503');
    }

    const dynamic = await run('dynamic', '={{ $json.allowErrors }}');
    const dynamicResult = await dynamic([{ json: { url: unavailable, allowErrors: true } }]);
    expect(dynamicResult.items).toEqual(ignored.items);
    await expect(dynamic([{ json: { url: unavailable, allowErrors: false } }]))
      .rejects.toThrow(/^HTTP Request failed with status 503$/);
  } finally {
    await receiver.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
