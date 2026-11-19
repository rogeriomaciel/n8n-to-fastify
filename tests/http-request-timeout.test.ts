import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled HTTP Request times out waiting for headers and can read a slow response body', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-http-timeout-'));
  const priorTimeout = process.env.N2F_FIXTURE_HTTP_TIMEOUT;
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === '/slow-headers') {
        await Bun.sleep(150);
        return Response.json({ success: true });
      }
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode('{"success":'));
          await Bun.sleep(650);
          controller.enqueue(encoder.encode('true}'));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    },
  });
  try {
    const file = path.join(dir, 'request.json');
    const service = path.join(dir, 'service');
    writeFileSync(file, JSON.stringify({
      nodes: [{
        name: 'Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
        parameters: {
          url: '={{ $json.url }}',
          options: { timeout: '={{ $json.timeout ?? $env.N2F_FIXTURE_HTTP_TIMEOUT }}' },
        },
      }],
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', file, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_request } = await import(path.join(service, 'workflows', 'request.ts'));
    const delayed = new URL('/slow-headers', receiver.url).href;
    await expect(workflow_request([{ json: { url: delayed, timeout: 20 } }]))
      .rejects.toThrow(/^HTTP Request timed out after 20 ms$/);
    process.env.N2F_FIXTURE_HTTP_TIMEOUT = '20';
    await expect(workflow_request([{ json: { url: delayed } }]))
      .rejects.toThrow(/^HTTP Request timed out after 20 ms$/);
    await expect(workflow_request([{ json: { url: delayed, timeout: ' ' } }]))
      .rejects.toThrow('HTTP Request timeout must be a non-negative integer');
    const result = await workflow_request([{ json: { url: String(receiver.url), timeout: 500 } }]);
    expect(result.items).toEqual([{ json: { success: true } }]);
  } finally {
    if (priorTimeout === undefined) delete process.env.N2F_FIXTURE_HTTP_TIMEOUT;
    else process.env.N2F_FIXTURE_HTTP_TIMEOUT = priorTimeout;
    await receiver.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
