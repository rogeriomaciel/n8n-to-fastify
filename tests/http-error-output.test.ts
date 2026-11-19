import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('HTTP Request routes each item to the connected v4.2 output', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-http-error-output-'));
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const label = new URL(request.url).pathname.slice(1);
      if (label === 'down') return Response.json({ message: 'upstream payload' }, { status: 503 });
      if (label === 'reported') return Response.json({ error: 'failed', message: 'application error' });
      return Response.json({ label });
    },
  });
  try {
    const source = path.join(dir, 'request.json');
    const output = path.join(dir, 'service');
    const branch = (name: string) => ({
      name, type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { jsCode: 'return $input.all();' },
    });
    writeFileSync(source, JSON.stringify({
      nodes: [{
        name: 'Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
        onError: 'continueErrorOutput', parameters: {
          url: '={{ $json.url }}',
          options: { response: { response: { neverError: '={{ $json.ignore }}' } } },
        },
      }, branch('Success'), branch('Failure')],
      connections: { Request: { main: ['Success', 'Failure'].map(node => [{ index: 0, node, type: 'main' }]) } },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', source, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_request } = await import(path.join(output, 'workflows', 'request.ts'));
    const input = (label: string, ignore = false) => ({
      json: { label, url: new URL(label, server.url).href, ignore },
      binary: { attachment: { data: 'aGk=' } },
    });
    const down = input('down');
    const reported = input('reported');
    const { context } = await workflow_request([input('first'), down, reported, input('last', true)]);
    expect(context.getNode('Success').all()).toEqual([
      { json: { label: 'first' }, pairedItem: { item: 0 } },
      { json: { label: 'last' }, pairedItem: { item: 3 } },
    ]);
    expect(context.getNode('Failure').all()).toEqual([
      { json: { ...down.json, error: { message: 'HTTP Request failed with status 503', status: 503 } }, pairedItem: { item: 1 } },
      { json: { ...reported.json, error: 'failed', message: 'application error' }, pairedItem: { item: 2 } },
    ]);
    expect(down.json).not.toHaveProperty('error');

    const ignored = await workflow_request([input('down', true)]);
    expect(ignored.context.getNode('Success').first()?.json).toEqual({ message: 'upstream payload' });
    expect(ignored.context.hasExecutedNode('Failure')).toBe(false);

    const invalid = await workflow_request([{ json: { url: 'invalid' } }]);
    expect(invalid.context.getNode('Failure').first()?.json).toEqual({ url: 'invalid', error: expect.any(String) });
    expect(invalid.context.hasExecutedNode('Success')).toBe(false);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
