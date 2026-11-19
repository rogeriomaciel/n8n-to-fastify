import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('terminal No Operation v1 preserves the entire input batch', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'n2f-noop-'));
  try {
    const input = path.join(directory, 'noop.json');
    const service = path.join(directory, 'service');
    const compile = (typeVersion: number) => {
      writeFileSync(input, JSON.stringify({ nodes: [
        { name: 'Input', type: 'n8n-nodes-base.code', typeVersion: 2,
          parameters: { jsCode: 'return $input.all();' } },
        { name: 'End', type: 'n8n-nodes-base.noOp', typeVersion, parameters: {} },
      ], connections: { Input: { main: [[{ node: 'End', type: 'main', index: 0 }]] } } }));
      return Bun.spawnSync([process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--strict', '--out', service]);
    };
    const unsupported = compile(2);
    expect(unsupported.exitCode).toBe(1);
    expect(unsupported.stderr.toString()).toContain('No Operation needs typeVersion 1');
    expect(compile(1).exitCode).toBe(0);

    const { workflow_noop } = await import(path.join(service, 'workflows', 'noop.ts'));
    const batch = [
      { json: { value: 'first' }, binary: { data: { data: 'aGk=', mimeType: 'text/plain' } }, pairedItem: { item: 0 } },
      { json: { value: 'second' }, pairedItem: { item: 1 } },
    ];
    const { items } = await workflow_noop(batch);
    expect(items).toEqual(batch);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
