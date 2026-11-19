import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { N8nItem } from '../src/runtime/n8n-helper';
import type { CompiledWorkflowFn } from '../src/runtime/workflow-registry';

async function withGeneratedWorkflow(
  type: 'if' | 'switch',
  typeVersion: number,
  parameters: Record<string, unknown>,
  check: (run: CompiledWorkflowFn) => Promise<void>,
  graph?: { nodes: object[]; connections: object },
  onError?: string,
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-branches-'));
  try {
    const input = path.join(dir, 'branches.json');
    const output = path.join(dir, 'service');
    const sinks = ['Output 0', 'Output 1', 'Output 2'];
    writeFileSync(input, JSON.stringify({
      nodes: [
        { name: 'Decision', type: `n8n-nodes-base.${type}`, typeVersion, parameters, onError },
        ...(graph?.nodes ?? sinks.map(name => ({
          name, type: 'n8n-nodes-base.code', typeVersion: 2,
          parameters: { jsCode: 'return $input.all();' },
        }))),
      ],
      connections: graph?.connections ?? { Decision: { main: sinks.map(node => [{ node, type: 'main', index: 0 }]) } },
    }));
    const compiled = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, ...(onError ? ['--strict'] : []),
    ]);
    if (onError) expect(compiled.stderr.toString()).toBe('');
    expect(compiled.exitCode).toBe(0);
    const { workflow_branches } = await import(path.join(output, 'workflows', 'branches.ts'));
    await check(workflow_branches);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ids = (items: N8nItem[] | undefined) => items?.map(item => item.json.id);

test('IF 2.2 routes each item to its true or false output and skips empty outputs', async () => {
  const conditions = { conditions: [
    { leftValue: '={{ $json.ready }}', operator: { type: 'boolean', operation: 'true' } },
  ] };
  await withGeneratedWorkflow('if', 2.2, { conditions }, async run => {
    const first = { json: { id: 'first', ready: true } };
    const second = { json: { id: 'second', ready: false } };
    const third = { json: { id: 'third', ready: true } };
    const { context } = await run([first, second, third]);
    expect(ids(context.getNode('Output 0').all())).toEqual(['first', 'third']);
    expect(ids(context.getNode('Output 1').all())).toEqual(['second']);
    expect(context.hasExecutedNode('Output 2')).toBe(false);

    const lone = await run([second]);
    expect(lone.context.getNodeOutput('Decision', 0)).toBeUndefined();
    expect(lone.context.hasExecutedNode('Output 0')).toBe(false);
    expect(ids(lone.context.getNode('Output 1').all())).toEqual(['second']);
    const empty = await run([]);
    expect(empty.context.hasExecutedNode('Output 0')).toBe(false);
    expect(empty.context.hasExecutedNode('Output 1')).toBe(false);
  });
});

const rules = { values: [
  { conditions: { combinator: 'and', conditions: [
    { leftValue: '={{ $json.score }}', rightValue: 5, operator: { type: 'number', operation: 'gt' } },
    { leftValue: '={{ $json.ready }}', operator: { type: 'boolean', operation: 'true' } },
  ] } },
  { conditions: { combinator: 'or', options: { caseSensitive: false }, conditions: [
    { leftValue: '={{ $json.status }}', rightValue: 'alert', operator: { type: 'string', operation: 'equals' } },
    { leftValue: '={{ $json.ready }}', operator: { type: 'boolean', operation: 'false' } },
  ] } },
] };

test.each([
  [{}, [['first', 'third'], ['second'], undefined]],
  [{ fallbackOutput: 0 }, [['first', 'third', 'fourth'], ['second'], undefined]],
  [{ fallbackOutput: 'extra', allMatchingOutputs: true }, [['first', 'third'], ['second', 'third'], ['fourth']]],
] as const)('Switch 3.2 routes rules per item with options %j', async (options, expected) => {
  await withGeneratedWorkflow('switch', 3.2, { rules, options }, async run => {
    const { context } = await run([
      { json: { id: 'first', score: 10, ready: true, status: 'normal' } },
      { json: { id: 'second', score: 2, ready: false, status: 'normal' } },
      { json: { id: 'third', score: 8, ready: true, status: 'ALERT' } },
      { json: { id: 'fourth', score: 1, ready: true, status: 'normal' } },
    ]);
    expect([0, 1, 2].map(port =>
      context.hasExecutedNode(`Output ${port}`) ? ids(context.getNode(`Output ${port}`).all()) : undefined
    )).toEqual(expected);
  });
});

test('Switch 3.3 evaluates an output index expression separately for each item', async () => {
  const parameters = { mode: 'expression', numberOutputs: 3, output: '={{ $json.port }}' };
  await withGeneratedWorkflow('switch', 3.3, parameters, async run => {
    const { context } = await run([{ json: { id: 'first', port: 2 } }, { json: { id: 'second', port: 0 } }]);
    expect(ids(context.getNode('Output 2').all())).toEqual(['first']);
    expect(ids(context.getNode('Output 0').all())).toEqual(['second']);
    expect(context.hasExecutedNode('Output 1')).toBe(false);
    await expect(run([{ json: { port: 3 } }])).rejects.toThrow('invalid output index');
  });
});

test('reconverging paths run separately and forward both batches to the next node', async () => {
  const target = (name: string) => [{ node: name, type: 'main', index: 0 }];
  const conditions = { conditions: [
    { leftValue: '={{ $json.ready }}', operator: { type: 'boolean', operation: 'true' } },
  ] };
  const graph = {
    nodes: [{
      name: 'Join', type: 'n8n-nodes-base.code', parameters: {
        jsCode: 'return [{ json: { ids: $input.all().map(item => item.json.id) } }];',
      },
    }, {
      name: 'Tail', type: 'n8n-nodes-base.code', parameters: {
        jsCode: 'return [{ json: { ids: $input.all().flatMap(item => item.json.ids) } }];',
      },
    }],
    connections: {
      Decision: { main: [target('Join'), target('Join')] },
      Join: { main: [target('Tail')] },
    },
  };
  await withGeneratedWorkflow('if', 2.2, { conditions }, async run => {
    const { items } = await run([
      { json: { id: 'first', ready: true } },
      { json: { id: 'second', ready: false } },
      { json: { id: 'third', ready: true } },
    ]);
    expect(items.map(item => item.json.ids)).toEqual([['first', 'third'], ['second']]);
  }, graph);
});

test.each(['if', 'switch'] as const)('%s keeps $input.first() separate from the item being routed', async type => {
  const conditions = { conditions: [
    { leftValue: '={{ $input.first().json.ready }}', operator: { type: 'boolean', operation: 'true' } },
  ] };
  const parameters = type === 'if' ? { conditions } : {
    rules: { values: [{ conditions }] }, options: { fallbackOutput: 'extra' },
  };
  await withGeneratedWorkflow(type, type === 'if' ? 2.2 : 3.2, parameters, async run => {
    const { context } = await run([
      { json: { id: 'first', ready: true } }, { json: { id: 'second', ready: false } },
    ]);
    expect(ids(context.getNode('Output 0').all())).toEqual(['first', 'second']);
    expect(context.hasExecutedNode('Output 1')).toBe(false);
  });
});

test('Switch retains output zero as the extra fallback with no rules', async () => {
  const parameters = { rules: { values: [] }, options: { fallbackOutput: 'extra' } };
  await withGeneratedWorkflow('switch', 3.2, parameters, async run => {
    const { context } = await run([{ json: { id: 'fallback' } }]);
    expect(ids(context.getNode('Output 0').all())).toEqual(['fallback']);
  });
});

test('Switch 3.2 sends boolean rule errors to port zero and keeps processing the batch', async () => {
  const rule = (operation: string) => ({
    conditions: {
      options: { version: 2, typeValidation: 'strict' },
      conditions: [{ leftValue: '={{ $json.ready }}', operator: { type: 'boolean', operation } }],
      combinator: 'and',
    },
  });
  const parameters = { rules: { values: [rule('false'), rule('true')] } };
  const bad = { json: { id: 'bad', ready: 'fixture' } };
  await withGeneratedWorkflow('switch', 3.2, parameters, async run => {
    const nil = { json: { id: 'nil', ready: null } };
    const yes = { json: { id: 'yes', ready: true } };
    const no = { json: { id: 'no', ready: false } };
    const missing = { json: { id: 'missing' } };
    const failure = { json: { error: 'Switch expected a boolean condition value' } };
    const { context } = await run([bad, nil, yes, no, missing]);
    expect(context.getNodeOutput('Output 0', 0)).toEqual([
      failure,
      { ...nil, pairedItem: { item: 1 } },
      { ...no, pairedItem: { item: 3 } },
      { ...missing, pairedItem: { item: 4 } },
    ]);
    expect(context.getNodeOutput('Output 1', 0)).toEqual([{ ...yes, pairedItem: { item: 2 } }]);
    expect(context.hasExecutedNode('Output 2')).toBe(false);
    const single = await run([bad]);
    expect(single.context.getNodeOutput('Output 0', 0)).toEqual([{ ...failure, pairedItem: { item: 0 } }]);
    expect(single.context.hasExecutedNode('Output 1')).toBe(false);
  }, undefined, 'continueRegularOutput');
});

test.each([null, '={{ null }}'])('Switch routes a null boolean value through the false rule (%s)', async leftValue => {
  const parameters = { rules: { values: [{
    conditions: {
      options: { version: 2, typeValidation: 'strict' },
      conditions: [{ leftValue, operator: { type: 'boolean', operation: 'false' } }],
    },
  }] } };
  await withGeneratedWorkflow('switch', 3.2, parameters, async run => {
    const items = [{ json: { id: 'first' } }, { json: { id: 'second' } }];
    const { context } = await run(items);
    expect(context.getNode('Output 0').all()).toEqual(items.map((item, index) => ({
      ...item, pairedItem: { item: index },
    })));
    expect(context.hasExecutedNode('Output 1')).toBe(false);
  }, undefined, 'continueRegularOutput');
});
