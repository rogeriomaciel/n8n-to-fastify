import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Edit Fields creates arrays for bracket and dot indexes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n2f-set-array-'));
  try {
    const input = path.join(root, 'paths.json');
    const output = path.join(root, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [{
        name: 'Edit', type: 'n8n-nodes-base.set', typeVersion: 3.4,
        parameters: {
          assignments: { assignments: [
            { name: 'rows[0].text', type: 'string', value: 'first' },
            { name: 'rows.1.text', type: 'string', value: 'second' },
            { name: 'matrix[0][0]', type: 'string', value: 'cell' },
            { name: 'metadata.title', type: 'string', value: 'fixture' },
          ] },
        },
      }],
      connections: {},
    }));
    const result = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    const { workflow_paths } = await import(path.join(output, 'workflows', 'paths.ts'));
    expect((await workflow_paths()).items).toEqual([{
      json: { rows: [{ text: 'first' }, { text: 'second' }], matrix: [['cell']], metadata: { title: 'fixture' } },
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
