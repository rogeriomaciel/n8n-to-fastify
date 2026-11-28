import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { N8nItem } from '../src/runtime/n8n-helper';

const code = (name: string, y: number, jsCode: string) => ({
  name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, y],
  parameters: { jsCode },
});
const source = (name: string, y: number) => code(name, y, `return [{ json: { id: ${JSON.stringify(name)} } }];`);
const append = (name: string, y: number) => ({
  name, type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [300, y],
  parameters: { mode: 'append' },
});
const edge = (node: string, index = 0) => ({ node, type: 'main', index });
const output = (...targets: ReturnType<typeof edge>[]) => ({ main: [targets] });
const ids = (items: N8nItem[]) => items.map(item => item.json.id);

async function checkWorkflow(
  nodes: object[],
  connections: Record<string, object>,
  expected: string[][],
  executionOrder = 'v1',
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-append-'));
  try {
    const input = path.join(dir, 'append.json');
    const compiledDir = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify({
      settings: { executionOrder },
      nodes: [
        ...nodes,
        append('Append', 0),
        code('Inspect', 0, 'return [{ json: { ids: $input.all().map(item => item.json.id) } }];'),
      ],
      connections: { ...connections, Append: output(edge('Inspect')) },
    }));
    const compiled = Bun.spawnSync([process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', compiledDir]);
    expect(compiled.exitCode).toBe(0);
    const { workflow_append } = await import(path.join(compiledDir, 'workflows', 'append.ts'));
    const { items, context } = await workflow_append();
    expect(context.getNodeOutputBatches('Append', 0).map(ids)).toEqual(expected);
    if (expected.length > 0) {
      expect(items.map((item: N8nItem) => item.json.ids)).toEqual(expected);
    } else {
      expect(context.hasExecutedNode('Inspect')).toBe(false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.each([
  ['shared', 'v1', [['Base', 'Upper'], ['Lower']]],
  ['late', 'v1', [['Base', 'Upper'], ['Lower']]],
  ['empty', 'v1', [['Base', 'Upper']]],
  ['late', 'v0', [['Base', 'Upper', 'Lower']]],
] as const)('Append preserves separate downstream runs for %s input in %s', async (scenario, order, expected) => {
  const nodes = [
    source('Base', 0), source('Upper', 10),
    scenario === 'empty' ? code('Lower', 20, 'return [];') : source('Lower', 20),
  ];
  const connections: Record<string, object> = {
    Base: output(edge('Append'), edge('Lower'), edge('Upper')),
    Upper: output(edge('Append', 1)),
    Lower: output(edge('Append', 1)),
  };
  if (scenario === 'late') {
    nodes.push(code('Relay', 30, 'return $input.all();'));
    connections.Lower = output(edge('Relay'));
    connections.Relay = output(edge('Append', 1));
  }
  await checkWorkflow(nodes, connections, expected.map(batch => [...batch]), order);
});

test('Append groups batches from multiple producer runs by destination input', async () => {
  const nodes = [
    source('Start', 0), source('Top', 10), source('Bottom', 20),
    code('Left', 30, 'return [{ json: { id: "left " + $input.first().json.id } }];'),
    code('Right', 40, 'return [{ json: { id: "right " + $input.first().json.id } }];'),
  ];
  await checkWorkflow(nodes, {
    Start: output(edge('Bottom'), edge('Top')),
    Bottom: output(edge('Right'), edge('Left')),
    Top: output(edge('Right'), edge('Left')),
    Right: output(edge('Append', 1)),
    Left: output(edge('Append', 0)),
  }, [['left Top', 'right Top'], ['left Bottom', 'right Bottom']]);
});

test('Append does not combine repeated deliveries to the same input or replay empty workflow input', async () => {
  await checkWorkflow([source('Data', 0), code('Empty', 10, 'return [];')], {
    Data: output(edge('Empty'), edge('Append', 0), edge('Append', 0)),
    Empty: output(edge('Append', 1)),
  }, [['Data'], ['Data']]);

  await checkWorkflow([code('Empty', 0, 'return [];')], {
    Empty: output(edge('Append', 1)),
  }, []);
});

test('Append flushes each populated run when another input is an inactive branch', async () => {
  await checkWorkflow([
    source('Start', 0), source('First', 10), source('Second', 20),
    {
      name: 'Route', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 30],
      parameters: {
        conditions: { conditions: [
          { leftValue: '={{ $json.id === "Start" }}', operator: { type: 'boolean', operation: 'true' } },
        ] },
      },
    },
  ], {
    Start: output(edge('Second'), edge('First'), edge('Route')),
    First: output(edge('Append')),
    Second: output(edge('Append')),
    Route: { main: [[], [edge('Append', 1)]] },
  }, [['First'], ['Second']]);
});

test('parallel partial Append nodes feed another Append in waiting order', async () => {
  await checkWorkflow([
    source('Start', 0), source('A', 10), source('B', 20), source('C', 30),
    code('Empty', 40, 'return [];'),
    append('First Merge', 10), append('Second Merge', 20),
  ], {
    Start: output(edge('A'), edge('B'), edge('C'), edge('Empty')),
    A: output(edge('First Merge')),
    B: output(edge('Second Merge')),
    C: output(edge('Append', 1)),
    Empty: output(edge('Second Merge', 1), edge('First Merge', 1)),
    'Second Merge': output(edge('Append')),
    'First Merge': output(edge('Append')),
  }, [['A', 'C'], ['B']]);
});

test('Append keeps a partial delivery ahead of its Combine by Position descendant', async () => {
  await checkWorkflow([
    source('Start', 0), source('PartialData', 10), source('Base', 20),
    code('Partner', 30, 'return [{ json: { partner: true } }];'),
    code('Empty', 40, 'return [];'),
    append('Partial', 10),
    {
      name: 'Combine', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [400, 10],
      parameters: { mode: 'combine', combineBy: 'combineByPosition' },
    },
    code('Relay', 10, `
      return $input.all().map(({ json }) => ({
        json: { id: json.id === "PartialData" && json.partner ? "Combined" : "Unexpected" },
      }));
    `),
  ], {
    Start: output(edge('PartialData'), edge('Base'), edge('Partner'), edge('Empty')),
    PartialData: output(edge('Partial')),
    Empty: output(edge('Partial', 1)),
    Base: output(edge('Append', 1)),
    Partner: output(edge('Combine', 1)),
    Partial: output(edge('Append'), edge('Combine')),
    Combine: output(edge('Relay')),
    Relay: output(edge('Append')),
  }, [['PartialData', 'Base'], ['Combined']]);
});

test('Append orders Combine by Position by the completing input from the same dispatch', async () => {
  await checkWorkflow([
    source('Start', 0), source('Base', -10), source('Sibling', 0),
    {
      name: 'Combine', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [0, 0],
      parameters: { mode: 'combine', combineBy: 'combineByPosition' },
    },
    code('Relay', 0, 'return [{ json: { id: "Combined" } }];'),
  ], {
    Start: output(edge('Base'), edge('Combine'), edge('Sibling'), edge('Combine', 1)),
    Base: output(edge('Append', 1)),
    Combine: output(edge('Relay')),
    Relay: output(edge('Append')),
    Sibling: output(edge('Append')),
  }, [['Combined', 'Base'], ['Sibling']]);
});

test('Append preserves two complete Combine by Position runs around a sibling', async () => {
  const left = (name: string, y: number, id: string) =>
    code(name, y, `return [{ json: { id: ${JSON.stringify(id)} } }];`);
  const right = (name: string, y: number, partner: number) =>
    code(name, y, `return [{ json: { partner: ${partner} } }];`);
  await checkWorkflow([
    source('Start', 0), source('Base', 0),
    left('Left A', 10, 'A'), right('Right A', 20, 1), source('Sibling', 30),
    left('Left B', 40, 'B'), right('Right B', 50, 2),
    {
      name: 'Combine', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [0, 60],
      parameters: { mode: 'combine', combineBy: 'combineByPosition', options: { includeUnpaired: false } },
    },
    code('Relay', 65, `
      return $input.all().map(({ json }) => ({
        json: { id: (json.id === "A" && json.partner === 1) || (json.id === "B" && json.partner === 2)
          ? json.id
          : "Unexpected" },
      }));
    `),
  ], {
    Start: output(edge('Base'), edge('Left A'), edge('Right A'), edge('Sibling'), edge('Left B'), edge('Right B')),
    Base: output(edge('Append', 1)),
    'Left A': output(edge('Combine')),
    'Right A': output(edge('Combine', 1)),
    Sibling: output(edge('Append')),
    'Left B': output(edge('Combine')),
    'Right B': output(edge('Combine', 1)),
    Combine: output(edge('Relay')),
    Relay: output(edge('Append')),
  }, [['A', 'Base'], ['Sibling'], ['B']]);
});

test.each([
  ['a matched pair', true, [['Combined', 'Base'], ['Sibling']]],
  ['a missing partner', false, [['Sibling', 'Base']]],
] as const)('Append batches with %s and a later Combine delivery', async (_, hasPartner, expected) => {
  await checkWorkflow([
    source('Start', 0), source('Base', 0),
    source('Left', 10), source('Sibling', 30), source('Extra', 40),
    code('Partner', 20, hasPartner ? 'return [{ json: { partner: true } }];' : 'return [];'),
    {
      name: 'Combine', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [400, 10],
      parameters: { mode: 'combine', combineBy: 'combineByPosition', options: { includeUnpaired: false } },
    },
    code('Relay', 10, `
      return $input.all().map(({ json }) => ({
        json: { id: json.id === "Left" && json.partner ? "Combined" : "Unexpected" },
      }));
    `),
  ], {
    Start: output(edge('Base'), edge('Left'), edge('Partner'), edge('Sibling'), edge('Extra')),
    Base: output(edge('Append', 1)),
    Left: output(edge('Combine')),
    Partner: output(edge('Combine', 1)),
    Sibling: output(edge('Append')),
    Extra: output(edge('Combine')),
    Combine: output(edge('Relay')),
    Relay: output(edge('Append')),
  }, expected.map(batch => [...batch]));
});

function pollingNodes(waitY: number) {
  return [
    code('Poll', 20, `
      return $input.all().map(({ json }) => ({
        json: { ...json, ready: json.remaining <= 0, remaining: json.remaining - 1, polls: (json.polls ?? 0) + 1 },
      }));
    `),
    {
      name: 'Ready', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [100, 20],
      parameters: { conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          leftValue: '={{ $json.ready }}', rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        }],
      } },
    },
    {
      name: 'Wait', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [200, waitY],
      parameters: { resume: 'timeInterval', amount: 0 },
    },
  ];
}

test.each([
  ['first attempt', [0]],
  ['one retry', [1]],
  ['separate exits', [0, 1]],
] as const)('Append preserves polling exit delivery order for %s', async (_, attempts) => {
  const data = attempts.map((remaining, index) => ({ json: { id: 'PartialData ' + index, remaining } }));
  await checkWorkflow([
    source('Start', 0), source('Base', 10),
    code('Data', 20, `return ${JSON.stringify(data)};`),
    code('Empty', 30, 'return [];'),
    append('Partial', 10),
    source('Sibling', 15),
    code('Polled', 20, 'return $input.all().map(({ json }) => ({ json: { id: "Polled " + json.id + " after " + json.polls } }));'),
    ...pollingNodes(30),
  ], {
    Start: output(edge('Base'), edge('Data'), edge('Empty')),
    Base: output(edge('Append', 1)),
    Data: output(edge('Partial')),
    Empty: output(edge('Partial', 1)),
    Partial: output(edge('Append'), edge('Poll'), edge('Sibling')),
    Sibling: output(edge('Append')),
    Poll: output(edge('Ready')),
    Ready: { main: [[edge('Polled')], [edge('Wait')]] },
    Polled: output(edge('Append')),
    Wait: output(edge('Poll')),
  }, [
    [...data.map(item => item.json.id), 'Base'],
    ['Sibling'],
    ...data.map(({ json }) => [`Polled ${json.id} after ${json.remaining + 1}`]),
  ]);
});

test.each([
  ['retry', 10, [['Base', 'second'], ['first']]],
  ['exit', 30, [['Base', 'first'], ['second']]],
] as const)('Append pairs polling exits when the %s path runs first', async (_, waitY, expected) => {
  await checkWorkflow([
    source('Start', 0), source('Base', 10),
    code('Data', 20, 'return [{ json: { id: "first", remaining: 0 } }, { json: { id: "second", remaining: 1 } }];'),
    code('Polled', 20, 'return $input.all();'),
    ...pollingNodes(waitY),
  ], {
    Start: output(edge('Base'), edge('Data')),
    Base: output(edge('Append')),
    Data: output(edge('Poll')),
    Poll: output(edge('Ready')),
    Ready: { main: [[edge('Polled')], [edge('Wait')]] },
    Polled: output(edge('Append', 1)),
    Wait: output(edge('Poll')),
  }, expected.map(batch => [...batch]));
});
