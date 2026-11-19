import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled Edit Fields converts declared numeric assignments and handles invalid inputs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-set-number-'));
  try {
    const input = path.join(dir, 'number.json');
    const service = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [{
        name: 'Edit', type: 'n8n-nodes-base.set', typeVersion: 3.4,
        parameters: {
          assignments: { assignments: [{ name: 'body.fileId', type: 'number', value: '={{ $json.id }}' }] },
          options: { ignoreConversionErrors: '={{ $json.ignoreErrors }}' },
        },
      }],
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_number } = await import(path.join(service, 'workflows', 'number.ts'));
    const result = await workflow_number([{ json: { id: '42\n' } }, { json: {} }, { json: { id: null } },
      { json: { id: 'invalid', ignoreErrors: true } }]);
    expect(result.items.map(item => item.json.body.fileId)).toEqual([42, null, null, 'invalid']);
    await expect(workflow_number([{ json: { id: 'invalid' } }])).rejects.toThrow('Edit Fields expected a number');
    const object = { toString: 'metadata' };
    const ignored = await workflow_number([{ json: { id: object, ignoreErrors: true } }]);
    expect(ignored.items[0].json.body.fileId).toEqual(object);
    await expect(workflow_number([{ json: { id: object } }])).rejects.toThrow('Edit Fields expected a number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
