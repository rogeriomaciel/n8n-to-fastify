import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled manual Edit Fields follows the include settings for each input item', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-edit-include-'));
  try {
    const file = path.join(dir, 'edit.json');
    const compile = async (version: number, settings: Record<string, unknown>, output: string, upstream = false) => {
      writeFileSync(file, JSON.stringify({
        nodes: [
          ...(upstream ? [{
            name: 'Expand', type: 'n8n-nodes-base.code', typeVersion: 2,
            parameters: { jsCode: 'return [{json:{id:1, keep:true, label:"one"}}, {json:{id:2, keep:false, label:"two"}}];' },
          }] : []),
          { name: 'Edit', type: 'n8n-nodes-base.set', typeVersion: version, parameters: {
            assignments: { assignments: [{ name: 'id', type: 'number', value: '={{ $json.id }}' }] }, ...settings,
          } },
        ],
        connections: upstream ? { Expand: { main: [[{ node: 'Edit', type: 'main', index: 0 }]] } } : {},
      }));
      const service = path.join(dir, output);
      const result = Bun.spawnSync([
        process.execPath, path.resolve('bin/cli.ts'), 'compile', file, '--out', service, '--strict',
      ]);
      expect(result.exitCode).toBe(0);
      return (await import(path.join(service, 'workflows', 'edit.ts'))).workflow_edit;
    };
    const first = { json: { id: 1, keep: true, label: 'one' } };
    const second = { json: { id: 2, keep: false, label: 'two' } };
    const defaultEdit = await compile(3.4, {}, 'default');
    expect((await defaultEdit([first])).items).toEqual([{ json: { id: 1 } }]);
    const dynamic = await compile(3.3, { includeOtherFields: '={{ $json.keep }}' }, 'dynamic');
    expect((await dynamic([first, second])).items).toEqual([first, { json: { id: 2 } }]);
    const batch = await compile(3.3, {
      includeOtherFields: '={{ $input.first().json.keep }}',
      include: '={{ $input.all().length > 1 ? "all" : "none" }}',
    }, 'batch', true);
    expect((await batch([{ json: {} }])).items).toEqual([first, second]);
    const none = await compile(3.4, { includeOtherFields: true, include: 'none' }, 'none');
    expect((await none([first])).items).toEqual([{ json: { id: 1 } }]);
    const older = await compile(3.2, {}, 'older');
    expect((await older([first])).items).toEqual([first]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
