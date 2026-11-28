import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Code node lookups preserve JavaScript scope and throw only when evaluated for an absent node', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n2f-code-lookup-scope-'));
  try {
    const input = path.join(root, 'lookup.json');
    const output = path.join(root, 'service');
    const code = (name: string, jsCode: string) => ({
      name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode },
    });
    writeFileSync(input, JSON.stringify({
      nodes: [
        code('Source', 'return [{ json: { value: 42, fail: $json.fail } }];'),
        code('Read', `
const ctx = $('Source').item.json;
if ($json.fail) $('Absent').item;
const read = name => ({
  item: () => $(name).item,
  first: () => $(name).first(),
  all: () => $(name).all(),
});
const errors = Object.values(read('Absent')).map(access => {
  try {
    access();
    return null;
  } catch (error) {
    return error.message;
  }
});
const readLocal = $ => $('Absent').item;
return [{ json: {
  value: ctx.value,
  executed: $('Source').isExecuted, inline: $('Source').first().json.value,
  first: $('Source').first().json.value,
  count: $('Source').all().length,
  spelling: "$('Source').item",
  errors,
  local: readLocal(name => ({ item: name })),
  pending: [$('Read').item, $('Read').first(), $('Read').all()],
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
      { json: {
        value: 42,
        executed: true,
        inline: 42,
        first: 42,
        count: 1,
        spelling: "$('Source').item",
        errors: Array(3).fill("Referenced node doesn't exist"),
        local: 'Absent',
        pending: [{ json: {} }, { json: {} }, []],
      } },
    ]);
    await expect(workflow_lookup([{ json: { fail: true } }])).rejects.toThrow("Referenced node doesn't exist");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
