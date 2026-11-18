import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled Code sees legacy items from its input batch and permits a local items declaration', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-code-items-'));
  try {
    const input = path.join(dir, 'items.json');
    const service = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [
        { name: 'Legacy', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {
          jsCode: 'return items.map(({ json }) => ({ json: { count: json.count + 1 } }));',
        } },
        { name: 'Local', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {
          jsCode: "const items = typeof $input.all === 'function' ? $input.all() : [$input.first()]; return items.map(({ json }) => ({ json: { count: json.count * 2 } }));",
        } },
      ],
      connections: { Legacy: { main: [[{ node: 'Local', type: 'main', index: 0 }]] } },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_items } = await import(path.join(service, 'workflows', 'items.ts'));
    const result = await workflow_items([{ json: { count: 2 } }, { json: { count: 5 } }]);
    expect(result.items).toEqual([{ json: { count: 6 } }, { json: { count: 12 } }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
