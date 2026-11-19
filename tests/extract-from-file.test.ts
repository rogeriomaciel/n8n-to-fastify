import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompiledWorkflowFn } from '../src/runtime/workflow-registry';

const workflow = (parameters: Record<string, unknown> = {}) => ({ nodes: [{
  name: 'Extract', type: 'n8n-nodes-base.extractFromFile', typeVersion: 1,
  parameters: { operation: 'binaryToPropery', ...parameters },
}] });

test('compiled Extract From File moves inline binary to base64 and preserves the configured source', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-extract-base64-'));
  try {
    const input = path.join(dir, 'inputs');
    const output = path.join(dir, 'service');
    mkdirSync(input);
    const cases = {
      defaults: {},
      keep_json: { destinationKey: 'payload.file', options: { keepSource: 'json' } },
      keep_binary: { options: { keepSource: 'binary' } },
      keep_both: { options: { keepSource: 'both' } },
      fields: { binaryPropertyName: '={{ $json.source }}', destinationKey: '={{ $json.destination }}' },
      lazy_destination: { destinationKey: '={{ JSON.parse($json.destination).key }}' },
      array_path: { destinationKey: 'files.0.base64' },
    };
    for (const [name, parameters] of Object.entries(cases)) {
      writeFileSync(path.join(input, `${name}.json`), JSON.stringify(workflow(parameters)));
    }
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const load = async (name: keyof typeof cases): Promise<CompiledWorkflowFn> =>
      (await import(path.join(output, 'workflows', `${name}.ts`)))[`workflow_${name}`];

    const data = { data: 'AP+A', mimeType: 'application/octet-stream' };
    const sidecar = { data: 'aGk=', mimeType: 'text/plain' };
    const json = { payload: { note: 'preserve' }, source: 'scan.part', destination: 'result.file' };
    const binary = { data, 'scan.part': sidecar };
    const inputs = [
      { json, binary },
      { json: { source: 'missing', destination: 'unused' }, binary: { sidecar } },
      { json: { source: 'data', destination: 'value' }, binary: { data: { ...data, data: '' } } },
    ];
    const defaults = await load('defaults');
    expect((await defaults(inputs)).items).toEqual([
      { json: { data: 'AP+A' }, pairedItem: { item: 0 }, binary: { 'scan.part': sidecar } },
      { json: { data: '' }, pairedItem: { item: 2 }, binary: {} },
    ]);
    const missing = await defaults([inputs[1]]);
    expect(missing.items).toEqual([]);
    expect(missing.context.isBranchActive('Extract', 0)).toBe(false);

    const keepJson = await load('keep_json');
    expect((await keepJson(inputs)).items[0]).toEqual({
      json: { ...json, payload: { note: 'preserve', file: 'AP+A' } },
      pairedItem: { item: 0 }, binary: { 'scan.part': sidecar },
    });
    expect(json.payload).toEqual({ note: 'preserve' });
    const keepBinary = await load('keep_binary');
    expect((await keepBinary(inputs)).items[0]).toEqual({ json: { data: 'AP+A' }, pairedItem: { item: 0 }, binary });
    const keepBoth = await load('keep_both');
    expect((await keepBoth(inputs)).items[0]).toEqual({ json: { ...json, data: 'AP+A' }, pairedItem: { item: 0 }, binary });

    const fields = await load('fields');
    expect((await fields(inputs)).items).toEqual([
      { json: { result: { file: 'aGk=' } }, pairedItem: { item: 0 }, binary: { data } },
      { json: { value: '' }, pairedItem: { item: 2 }, binary: {} },
    ]);
    await expect(defaults([{ json: {}, binary: { data: { data: 'filesystem-v2', id: 'fixture-storage' } } }]))
      .rejects.toThrow('requires inline base64 binary data');
    await expect(fields([{ json: { source: 'data', destination: '__proto__.file' }, binary: { data } }]))
      .rejects.toThrow('safe destination');
    const lazyDestination = await load('lazy_destination');
    const lazyResult = await lazyDestination([inputs[1], { json: { destination: '{"key":"base64"}' }, binary }]);
    expect(lazyResult.items).toEqual([
      { json: { base64: 'AP+A' }, pairedItem: { item: 1 }, binary: { 'scan.part': sidecar } },
    ]);
    const arrayPath = await load('array_path');
    expect((await arrayPath([inputs[0]])).items[0].json).toEqual({ files: [{ base64: 'AP+A' }] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict mode diagnoses other Extract From File operations before emitting code', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-extract-unsupported-'));
  try {
    const input = path.join(dir, 'pdf.json');
    const output = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify(workflow({ operation: 'pdf' })));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(1);
    expect(compile.stderr.toString()).toContain('Extract From File supports Move File to Base64 String');
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
