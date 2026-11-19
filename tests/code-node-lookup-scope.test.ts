import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Code node lookups work when the script declares its own ctx', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n2f-code-lookup-scope-'));
  try {
    const input = path.join(root, 'lookup.json');
    const output = path.join(root, 'service');
    const code = (name: string, jsCode: string) => ({
      name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode },
    });
    writeFileSync(input, JSON.stringify({
      nodes: [
        code('Source', 'return [{ json: { value: 42 } }];'),
        code('Read', `
const ctx = $('Source').item.json;
return [{ json: {
  value: ctx.value,
  first: $('Source').first().json.value,
  count: $('Source').all().length,
  spelling: "$('Source').item",
} }];
`),
      ],
      connections: { Source: { main: [[{ node: 'Read', type: 'main', index: 0 }]] } },
    }));
    const result = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    const { workflow_lookup } = await import(path.join(output, 'workflows', 'lookup.ts'));
    expect((await workflow_lookup()).items).toEqual([
      { json: { value: 42, first: 42, count: 1, spelling: "$('Source').item" } },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
