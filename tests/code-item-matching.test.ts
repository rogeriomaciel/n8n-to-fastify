import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const code = (name: string, jsCode: string) => ({
  name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode },
});
const connect = (...targets: string[]) => ({ main: [targets.map(node => ({ node, type: 'main', index: 0 }))] });

async function withWorkflow(workflow: { nodes: object[]; connections: object }, run: (service: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-item-matching-'));
  try {
    const source = path.join(dir, 'linked.json');
    const output = path.join(dir, 'service');
    writeFileSync(source, JSON.stringify(workflow));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', source, '--out', output, '--strict',
    ]);
    expect(compile.stderr.toString()).toBe('');
    expect(compile.exitCode).toBe(0);
    await run(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('itemMatching follows each filtered or reordered item and fails for an unavailable link', async () => {
  await withWorkflow({
    nodes: [
      code('Source', 'return $input.all();'),
      code('Transform', `
const rows = $input.all();
if (rows[0].json.mode === 'filter') return rows.filter(item => item.json.keep);
if (rows[0].json.mode === 'missing') return [{ json: {} }];
if (rows[0].json.mode === 'ambiguous') return [{ json: {}, pairedItem: [{ item: 0 }, { item: 2 }] }];
if (rows[0].json.mode === 'positional') return rows.map(() => ({ json: {} }));
return [2, 0].map(index => ({ json: { copy: rows[0].json.mode === 'copy' }, pairedItem: index }));`),
      code('Pass', 'return $input.first().json.copy ? $input.all().map(item => ({...item})) : $input.all();'),
      code('Read', `return $input.all().map((_, index) => {
        try { return { json: { source: $('Source').itemMatching(index).json.id } }; }
        catch { return { json: { unavailable: true } }; }
      });`),
    ],
    connections: { Source: connect('Transform'), Transform: connect('Pass'), Pass: connect('Read') },
  }, async output => {
    const { workflow_linked } = await import(path.join(output, 'workflows', 'linked.ts'));
    const run = async (mode: string) => (await workflow_linked(
      ['first', 'middle', 'last'].map((id, i) => ({ json: { id, keep: i !== 1, mode } })),
    )).items.map((item: { json: unknown }) => item.json);
    expect(await run('filter')).toEqual([{ source: 'first' }, { source: 'last' }]);
    expect(await run('reorder')).toEqual([{ source: 'last' }, { source: 'first' }]);
    expect(await run('copy')).toEqual([{ source: 'last' }, { source: 'first' }]);
    expect(await run('positional')).toEqual([{ source: 'first' }, { source: 'middle' }, { source: 'last' }]);
    expect(await run('missing')).toEqual([{ unavailable: true }]);
    expect(await run('ambiguous')).toEqual([{ unavailable: true }]);
  });
});

test('itemMatching uses the active connection when sibling nodes forward the same items', async () => {
  await withWorkflow({
    nodes: [
      code('Source', 'return $input.all();'),
      code('Left', 'return $input.all();'),
      code('Right', 'return $input.all();'),
      code('Read', `return $input.all().map((_, index) => {
        let left = false;
        try { left = Boolean($('Left').itemMatching(index)); } catch {}
        return { json: { left, source: $('Source').itemMatching(index).json.id } };
      });`),
    ],
    connections: { Source: connect('Left', 'Right'), Left: connect('Read'), Right: connect('Read') },
  }, async output => {
    const { workflow_linked } = await import(path.join(output, 'workflows', 'linked.ts'));
    const result = await workflow_linked([{ json: { id: 'item' } }]);
    expect(result.items).toEqual([
      { json: { left: true, source: 'item' } },
      { json: { left: false, source: 'item' } },
    ]);
  });
});

test('itemMatching accepts multiple links that converge on the same source item', async () => {
  await withWorkflow({
    nodes: [
      code('Source', 'return $input.all();'),
      code('Duplicate', 'return [0, 0].map(item => ({ json: {}, pairedItem: { item } }));'),
      code('Combine', 'return [{ json: {}, pairedItem: [{ item: 0 }, { item: 1 }] }];'),
      code('Read', "return [{ json: $('Source').itemMatching(0).json }];"),
    ],
    connections: { Source: connect('Duplicate'), Duplicate: connect('Combine'), Combine: connect('Read') },
  }, async output => {
    const { workflow_linked } = await import(path.join(output, 'workflows', 'linked.ts'));
    const result = await workflow_linked([{ json: { id: 'parent' } }]);
    expect(result.items).toEqual([{ json: { id: 'parent' } }]);
  });
});

test('Split Out keeps the parent of each child when input and output counts match', async () => {
  await withWorkflow({
    nodes: [
      code('Source', 'return $input.all();'),
      {
        name: 'Split', type: 'n8n-nodes-base.splitOut', typeVersion: 1, parameters: { fieldToSplitOut: 'children' },
      },
      code('Read', `
return $input.all().map((row, index) => ({
  json: { child: row.json.child, parent: $('Source').itemMatching(index).json.id },
}));
`),
    ],
    connections: { Source: connect('Split'), Split: connect('Read') },
  }, async output => {
    const { workflow_linked } = await import(path.join(output, 'workflows', 'linked.ts'));
    const result = await workflow_linked([
      { json: { id: 'A', children: [{ child: 'one' }, { child: 'two' }] } },
      { json: { id: 'B', children: [] } },
    ]);
    expect(result.items).toEqual([
      { json: { child: 'one', parent: 'A' } },
      { json: { child: 'two', parent: 'A' } },
    ]);
  });
});
