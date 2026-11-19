import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';

test.each([
  ['v1', ['Upper', 'Upper Child', 'Left', 'Right']],
  ['v0', ['Right', 'Left', 'Upper', 'Upper Child']],
] as const)('generated branches use the canvas only when execution order is v1 (%s)', async (executionOrder, expected) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-canvas-order-'));
  const code = (name: string, position: [number, number], record = true) => ({
    name, position, type: 'n8n-nodes-base.code', typeVersion: 2,
    parameters: {
      jsCode: `${record ? `$json.steps.push(${JSON.stringify(name)});` : ''} return $input.all();`,
    },
  });
  const outputs = (...names: string[]) => ({
    main: [names.map(node => ({ node, type: 'main', index: 0 }))],
  });
  try {
    const source = path.join(dir, 'order.json');
    const output = path.join(dir, 'service');
    writeFileSync(source, JSON.stringify({
      settings: { executionOrder },
      nodes: [
        code('Fork', [0, 0], false),
        code('Upper', [300, -100]),
        code('Upper Child', [400, 200]),
        code('Left', [100, 0]),
        code('Right', [200, 0]),
      ],
      connections: {
        Fork: outputs('Upper', 'Left', 'Right'),
        Upper: outputs('Upper Child'),
      },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', source, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_order } = await import(path.join(output, 'workflows', 'order.ts'));
    const { items } = await workflow_order([{ json: { steps: [] } }]);
    expect(items[0].json.steps).toEqual(expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a v1 workflow returns the last executed branch, including an empty result', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-branch-result-'));
  const fastify = Fastify();
  const target = (node: string) => ({ node, type: 'main', index: 0 });
  try {
    const source = path.join(dir, 'result.json');
    const output = path.join(dir, 'service');
    writeFileSync(source, JSON.stringify({
      settings: { executionOrder: 'v1' },
      nodes: [
        { name: 'Webhook', type: 'n8n-nodes-base.webhook', position: [0, 0], parameters: { path: 'canvas' } },
        {
          name: 'Decision', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [100, 0],
          parameters: { conditions: { conditions: [
            { leftValue: '={{ $json.upper }}', operator: { type: 'boolean', operation: 'true' } },
          ] } },
        },
        { name: 'Upper', type: 'n8n-nodes-base.code', position: [200, -100], parameters: { jsCode: 'return [{ json: { result: "upper" } }];' } },
        { name: 'Lower', type: 'n8n-nodes-base.code', position: [200, 100], parameters: { jsCode: 'return $json.empty ? [] : [{ json: { result: "lower" } }];' } },
      ],
      connections: { Webhook: { main: [[target('Decision')]] }, Decision: { main: [[target('Upper')], [target('Lower')]] } },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', source, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_result } = await import(path.join(output, 'workflows', 'result.ts'));
    const { registerCompiledRoutes } = await import(path.join(output, 'routes', 'index.ts'));
    await fastify.register(registerCompiledRoutes);
    const fresh = await workflow_result([{ json: { upper: true } }]);
    expect(fresh.items).toEqual([{ json: { result: 'upper' } }]);
    const lower = await workflow_result([{ json: { upper: false } }]);
    expect(lower.items).toEqual([{ json: { result: 'lower' } }]);
    const upper = await workflow_result([{ json: { upper: true } }], lower.context);
    expect(upper.items).toEqual([{ json: { result: 'upper' } }]);
    const empty = await workflow_result([{ json: { upper: false, empty: true } }]);
    expect(empty.items).toEqual([]);
    const response = await fastify.inject({ method: 'POST', url: '/webhook/canvas', payload: { upper: true } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 'upper' });
  } finally {
    await fastify.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
