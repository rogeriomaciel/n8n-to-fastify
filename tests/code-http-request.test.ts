import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('generated Code binds httpRequest and preserves JSON, HTTP status, and timeouts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-code-http-'));
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/slow') {
        await Bun.sleep(150);
        return new Response('slow response');
      }
      if (pathname === '/failure') {
        return new Response('unavailable', { status: 503, headers: { 'x-fixture': 'error' } });
      }
      return Response.json({
        method: request.method,
        accept: request.headers.get('accept'),
        contentType: request.headers.get('content-type'),
        body: await request.json(),
        fixture: request.headers.get('x-fixture'),
      });
    },
  });
  try {
    const source = path.join(dir, 'request.json');
    const output = path.join(dir, 'service');
    writeFileSync(source, JSON.stringify({ nodes: [{
      name: 'Request', type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { jsCode: `
        const { httpRequest } = this.helpers;
        const result = await httpRequest($json.options);
        return [{ json: { result } }];
      ` },
    }] }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', source, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_request } = await import(path.join(output, 'workflows', 'request.ts'));
    const run = (pathname: string, options: Record<string, unknown> = {}) =>
      workflow_request([{ json: { options: { url: new URL(pathname, server.url).href, ...options } } }]);
    const result = await run('/echo', {
      method: 'POST', json: true, headers: { 'x-fixture': 'code' }, body: { label: 'Résumé' },
    });
    expect(result.items[0].json.result).toEqual({
      method: 'POST', accept: 'application/json', contentType: 'application/json',
      body: { label: 'Résumé' }, fixture: 'code',
    });
    await expect(run('/failure')).rejects.toMatchObject({ response: { status: 503 } });
    const failure = await run('/failure', { returnFullResponse: true, ignoreHttpStatusErrors: true });
    expect(failure.items[0].json.result).toMatchObject({
      statusCode: 503, body: 'unavailable', headers: { 'x-fixture': 'error' },
    });
    await expect(run('/slow', { timeout: 20 })).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(run('file:///tmp/fixture')).rejects.toThrow('require an HTTP or HTTPS URL');
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
