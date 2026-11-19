import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function compileDisabledFixture(dir: string, inputPort: number) {
  const input = path.join(dir, 'disabled.json');
  const output = path.join(dir, 'service');
  writeFileSync(input, JSON.stringify({
    nodes: [
      { name: 'Detached', type: 'fixture.unknown', disabled: true, parameters: {} },
      { name: 'Source', type: 'n8n-nodes-base.webhook', parameters: { path: 'fixture' } },
      {
        name: 'Disabled Code', type: 'n8n-nodes-base.code', disabled: true,
        parameters: { jsCode: 'throw new Error("fixture must stay inactive");' },
      },
      { name: 'After', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return $input.all();' } },
    ],
    connections: {
      Source: { main: [[{ node: 'Disabled Code', type: 'main', index: inputPort }]] },
      'Disabled Code': { main: [[{ node: 'After', type: 'main', index: 0 }]] },
    },
  }));
  const result = Bun.spawnSync([
    process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
  ]);
  return { output, result };
}

test('compiled workflows skip detached disabled nodes and pass through connected disabled nodes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-disabled-'));
  try {
    const { output, result } = compileDisabledFixture(dir, 0);
    expect(result.exitCode).toBe(0);
    const { workflow_disabled } = await import(path.join(output, 'workflows', 'disabled.ts'));
    const input = [
      { json: { marker: 'first' }, binary: { file: { data: 'AA==' } }, pairedItem: { item: 0 } },
      { json: { marker: 'second' } },
    ];
    const { items, context } = await workflow_disabled(input);
    expect(context.getNode('Disabled Code').all()).toEqual(input);
    expect(context.hasExecutedNode('Detached')).toBe(false);
    expect(items).toEqual(input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([false, true])('a disabled root with an output does not activate its branch (disabled first: %s)', async disabledFirst => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-disabled-root-'));
  try {
    const input = path.join(dir, 'root.json');
    const output = path.join(dir, 'service');
    const link = (node: string) => ({ main: [[{ node, type: 'main', index: 0 }]] });
    const start = { name: 'Start', type: 'n8n-nodes-base.webhook', parameters: { path: 'fixture' } };
    const detached = { name: 'Detached', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, disabled: true, parameters: { url: 'invalid' } };
    writeFileSync(input, JSON.stringify({
      settings: { executionOrder: 'v1' },
      nodes: [
        ...(disabledFirst ? [detached, start] : [start, detached]),
        { name: 'Live', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return $input.all();' } },
        { name: 'Inactive', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'throw new Error("inactive branch");' } },
      ],
      connections: { Start: link('Live'), Detached: link('Inactive') },
    }));
    const result = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
    const { workflow_root } = await import(path.join(output, 'workflows', 'root.ts'));
    const items = [{ json: { marker: 'input' } }];
    const resultRun = await workflow_root(items);
    expect(resultRun.items).toEqual(items);
    expect(resultRun.context.hasExecutedNode('Live')).toBe(true);
    expect(resultRun.context.hasExecutedNode('Detached')).toBe(false);
    expect(resultRun.context.hasExecutedNode('Inactive')).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict mode flags disabled nodes connected to secondary inputs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-disabled-port-'));
  try {
    const { result } = compileDisabledFixture(dir, 1);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('disabled node configuration is unsupported');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a disabled Merge passes through the transformed input batch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-disabled-merge-'));
  try {
    const input = path.join(dir, 'merge.json');
    const output = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [
        {
          name: 'Source', type: 'n8n-nodes-base.code', typeVersion: 2,
          parameters: { jsCode: 'return [{ json: { marker: "upstream-node" } }];' },
        },
        {
          name: 'Disabled Merge', type: 'n8n-nodes-base.merge', typeVersion: 3.2,
          disabled: true, parameters: {},
        },
        { name: 'After', type: 'n8n-nodes-base.code', parameters: { jsCode: 'return $input.all();' } },
      ],
      connections: {
        Source: { main: [[{ node: 'Disabled Merge', type: 'main', index: 0 }]] },
        'Disabled Merge': { main: [[{ node: 'After', type: 'main', index: 0 }]] },
      },
    }));
    const result = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(result.exitCode).toBe(0);
    const { workflow_merge } = await import(path.join(output, 'workflows', 'merge.ts'));
    const { items, context } = await workflow_merge([{ json: { marker: 'workflow-input' } }]);
    const expected = [{ json: { marker: 'upstream-node' } }];
    expect(context.getNode('Disabled Merge').all()).toEqual(expected);
    expect(items).toEqual(expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
