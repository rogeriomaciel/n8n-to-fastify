import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('Code itemMatching reports a strict diagnostic and keeps a valid fallback in normal mode', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-item-matching-'));
  try {
    const source = path.join(dir, 'example.json');
    const output = path.join(dir, 'service');
    const code = (name: string, jsCode: string) => ({
      name, type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode },
    });
    writeFileSync(source, JSON.stringify({
      nodes: [code('Source', 'return [{ json: { label: "input" } }];'), code('Read', `
try {
  return [{ json: $('Source').itemMatching(0).json }];
} catch {
  /* $('Source').itemMatching(0) */ return [{ json: $('Source').item.json }];
}`)],
      connections: { Source: { main: [[{ node: 'Read', type: 'main', index: 0 }]] } },
    }));
    const command = [process.execPath, path.resolve('bin/cli.ts'), 'compile', source, '--out', output];
    const strict = Bun.spawnSync([...command, '--strict']);
    expect(strict.exitCode).toBe(1);
    expect(strict.stderr.toString()).toContain('Code itemMatching requires linked-item lookup');
    expect(existsSync(output)).toBe(false);

    const normal = Bun.spawnSync(command);
    expect(normal.exitCode).toBe(0);
    const { workflow_example } = await import(path.join(output, 'workflows', 'example.ts'));
    expect((await workflow_example()).items).toEqual([{ json: { label: 'input' } }]);
    const inertSource = JSON.parse(readFileSync(source, 'utf8'));
    inertSource.nodes[1].parameters.jsCode = `
const literal = "$('Source').itemMatching(0)";
/* $('Source').itemMatching(0) */ return [{ json: { literal, label: $('Source').item.json.label } }];
`;
    writeFileSync(source, JSON.stringify(inertSource));
    const inert = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', source, '--out', output + '-inert', '--strict',
    ]);
    expect(inert.stderr.toString()).toBe('');
    expect(inert.exitCode).toBe(0);
    const inertModule = await import(path.join(output + '-inert', 'workflows', 'example.ts'));
    expect((await inertModule.workflow_example()).items).toEqual([
      { json: { literal: "$('Source').itemMatching(0)", label: 'input' } },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
