import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled fields support $now and its zero-argument toISO accessor', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n2f-now-expression-'));
  try {
    const input = path.join(root, 'clock.json');
    const output = path.join(root, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [{
        name: 'Clock', type: 'n8n-nodes-base.set', typeVersion: 3.4,
        parameters: {
          assignments: { assignments: [
            { name: 'timestamp', type: 'string', value: '={{ $now.toISO() }}' },
            { name: 'message', type: 'string', value: '=The time is {{ $now.toISO() }}' },
            { name: 'current', type: 'string', value: '={{ $now }}' },
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
    const { workflow_clock } = await import(path.join(output, 'workflows', 'clock.ts'));
    const { items } = await workflow_clock();
    const fields = items[0].json;
    for (const value of [fields.timestamp, fields.current, fields.message.replace('The time is ', '')]) {
      expect(new Date(value).toISOString()).toBe(value);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
