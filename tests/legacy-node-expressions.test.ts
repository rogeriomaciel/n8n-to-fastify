import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('generated HTTP Request resolves literal $node references in its URL and headers', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-legacy-expression-'));
  const originalFetch = globalThis.fetch;
  try {
    const input = path.join(dir, 'fixture.json');
    const service = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [
        { name: 'Split', type: 'n8n-nodes-base.if', typeVersion: 2.2,
          parameters: { conditions: { combinator: 'and', conditions: [
            { leftValue: '={{ $json.first }}', operator: { type: 'boolean', operation: 'true' } },
          ] } } },
        { name: 'Settings', type: 'n8n-nodes-base.code', typeVersion: 2,
          parameters: { jsCode: 'return $input.all().map(({ json }) => ({ json: { url: "http://fixture.invalid/" + json.label, headers: { "X-Fixture": json.label } } }));' } },
        { name: 'Forward', type: 'n8n-nodes-base.code', typeVersion: 2,
          parameters: { jsCode: 'return $input.all().map(item => ({ json: { ...item.json } }));' } },
        { name: 'Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, parameters: {
          url: '={{ $node["Settings"].json.url }}',
          sendHeaders: true, specifyHeaders: 'json',
          jsonHeaders: '={{ $node[\'Settings\'].json["headers"] }}',
        } },
      ],
      connections: {
        Split: { main: [[{ node: 'Settings', type: 'main', index: 0 }], [{ node: 'Settings', type: 'main', index: 0 }]] },
        Settings: { main: [[{ node: 'Forward', type: 'main', index: 0 }]] },
        Forward: { main: [[{ node: 'Request', type: 'main', index: 0 }]] },
      },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_fixture } = await import(path.join(service, 'workflows', 'fixture.ts'));
    globalThis.fetch = (async (url, options) => {
      const label = String(url).split('/').at(-1);
      expect(new Headers(options?.headers).get('X-Fixture')).toBe(label);
      return Response.json({ label });
    }) as typeof fetch;
    const result = await workflow_fixture([{ json: { label: 'first', first: true } }, { json: { label: 'second' } }]);
    expect(result.items).toEqual([{ json: { label: 'first' } }, { json: { label: 'second' } }]);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
