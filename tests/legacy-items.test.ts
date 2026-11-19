import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkflowContext } from '../src/runtime/workflow-context';

test('compiled Code reads current input and the named output with $items', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-legacy-items-'));
  try {
    const input = path.join(dir, 'fixture.json');
    const service = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [
        { name: 'Export', type: 'n8n-nodes-base.convertToFile', typeVersion: 1, parameters: { operation: 'toJson' } },
        { name: 'Consume', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {
          jsCode: "const source = $items('Export', 0)[0]; return [{json:{count:$items().length,content:JSON.parse(Buffer.from(source.binary.data.data,'base64').toString())}}];",
        } },
      ],
      connections: { Export: { main: [[{ node: 'Consume', type: 'main', index: 0 }]] } },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    symlinkSync(path.resolve('node_modules'), path.join(service, 'node_modules'), 'junction');
    const { workflow_fixture } = await import(path.join(service, 'workflows', 'fixture.ts'));
    const result = await workflow_fixture([{ json: { value: 3 } }, { json: { value: 5 } }]);
    expect(result.items).toEqual([{ json: { count: 1, content: [{ value: 3 }, { value: 5 }] } }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('named $items lookup selects the latest or requested batch at the requested port', async () => {
  const context = new WorkflowContext();
  const batches = [[{ json: { value: 'first' } }], [{ json: { value: 'latest' } }]];
  await context.runNodeBatches('Source', batches, async (items) => {
    context.setNodeOutput('Source', items, 1);
  });
  expect(context.getNodeRunItems('Source', 1, -1)).toEqual(batches[1]);
  expect(context.getNodeRunItems('Source', 1, 0)).toEqual(batches[0]);
  expect(() => context.getNodeRunItems('Source', 1, 2)).toThrow('Referenced node run does not exist');
});

test('named $items preserves empty ports at each execution index', async () => {
  const context = new WorkflowContext();
  const batches = [[{ json: { port: 0 } }], [{ json: { port: 1 } }], [{ json: { port: 0 } }]];
  await context.runNodeBatches('Route', batches, async (items) => {
    context.setNodeOutputs('Route', [[items[0].json.port, items]], items);
  });
  expect(context.getNodeRunItems('Route', 1, 0)).toEqual([]);
  expect(context.getNodeRunItems('Route', 1, 1)).toEqual(batches[1]);
  expect(context.getNodeRunItems('Route', 1, -1)).toEqual([]);
  expect(context.getNodeOutputBatches('Route', 1)).toEqual([batches[1]]);
  expect(() => context.getNodeRunItems('Route', 1, 3)).toThrow('Referenced node run does not exist');
});
