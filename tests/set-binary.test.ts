import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CompiledWorkflowFn } from '../src/runtime/workflow-registry';

test('generated Edit Fields nodes preserve binary data according to their exported options', async () => {
  const cases = [
    { version: 1, parameters: {}, keep: true },
    { version: 2, parameters: { keepOnlySet: true }, keep: false },
    { version: 3.2, parameters: {}, keep: false },
    { version: 3.3, parameters: { options: { includeBinary: true } }, keep: true },
    { version: 3.3, parameters: { options: { includeBinary: false } }, keep: false },
    { version: undefined, parameters: {}, keep: false },
    { version: 3.4, parameters: {}, keep: false },
    { version: 3.4, parameters: { includeOtherFields: true }, keep: true },
    { version: 3.4, parameters: { includeOtherFields: true, options: { stripBinary: true } }, keep: false },
    { version: 3.4, parameters: { includeOtherFields: true, include: 'none' }, keep: false },
    { version: 3.4, parameters: {
      includeOtherFields: '={{ $json.keep }}',
      options: { stripBinary: '={{ $json.strip }}' },
    }, keep: true, keepSecond: false },
  ];
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-set-binary-'));
  try {
    const inputs = path.join(dir, 'workflows');
    const service = path.join(dir, 'service');
    mkdirSync(inputs);
    cases.forEach(({ version, parameters }, index) => {
      const edit = { name: 'label', value: 'edited' };
      const metadata = { name: 'fileName', value: '={{ $binary.data.fileName ?? null }}' };
      const contentType = { name: 'mimeType', value: '={{ $binary["second"]?.mimeType ?? null }}' };
      const literalProperty = { name: 'literalProperty', value: '={{ $json["$binary"] ?? null }}' };
      const objectProperty = { name: 'objectProperty', value: '={{ ({ $binary: "property" }).$binary }}' };
      const template = { name: 'template', value: '={{ `$binary:${$binary.data.fileName ?? "missing"}` }}' };
      const fieldsForCase = [edit, metadata, contentType, literalProperty, objectProperty, template];
      const fields = (version ?? 3.4) >= 3
        ? { assignments: { assignments: fieldsForCase } }
        : { values: { string: fieldsForCase } };
      writeFileSync(path.join(inputs, `case_${index}.json`), JSON.stringify({
        nodes: [{
          name: 'Edit Fields',
          type: 'n8n-nodes-base.set',
          typeVersion: version,
          parameters: { ...parameters, ...fields },
        }],
      }));
    });
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', inputs, '--out', service,
    ]);
    expect(compile.exitCode).toBe(0);

    const binary = {
      data: { data: 'AP8=', fileName: 'fixture.bin' },
      second: { data: 'AQ==', mimeType: 'application/octet-stream' },
    };
    const originalBinary = structuredClone(binary);
    const item = { json: { keep: true, strip: false, $binary: 'example literal' }, binary };
    for (const [index, { keep, keepSecond = keep }] of cases.entries()) {
      const workflow = await import(path.join(service, 'workflows', `case_${index}.ts`));
      const run = workflow[`workflow_case_${index}`] as CompiledWorkflowFn;
      const { items } = await run([item, { json: { keep: false, strip: true }, binary }, { json: {} }]);
      expect(items[0].json.label).toBe('edited');
      expect(items[0].json.fileName).toBe('fixture.bin');
      expect(items[0].json.mimeType).toBe('application/octet-stream');
      expect(items[0].json.literalProperty).toBe('example literal');
      expect(items[0].json.objectProperty).toBe('property');
      expect(items[0].json.template).toBe('$binary:fixture.bin');
      expect(items[2].json.template).toBe('$binary:missing');
      expect(items[2].json.fileName).toBeNull();
      expect(items[2].json.mimeType).toBeNull();
      expect(items[0].binary).toEqual(keep ? binary : undefined);
      if (keep) expect(items[0].binary).not.toBe(binary);
      expect(items[1].binary).toEqual(keepSecond ? binary : undefined);
      expect(items[2].binary).toBeUndefined();
    }
    expect(item.binary).toEqual(originalBinary);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
