import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test.each([
  { property: undefined, field: 'data', endpoint: '/fixture.bin', fileName: 'fixture.bin', extension: 'bin', mime: 'application/octet-stream' },
  { property: '={{ $json.field }}', field: 'attachment', endpoint: '/download', fileName: 'attachment.bin', extension: 'bin', mime: 'application/octet-stream' },
  { property: undefined, field: 'data', endpoint: '/report.custom?download=1', fileName: 'report.custom', extension: 'custom', mime: 'application/x-n2f-fixture-custom' },
])('compiled HTTP file responses preserve bytes and the filename for $endpoint', async ({ property, field, endpoint, fileName, extension, mime }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-http-file-'));
  const bytes = Uint8Array.of(0, 80, 255);
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(bytes, { headers: { 'Content-Type': mime } }),
  });

  try {
    const file = path.join(dir, 'download.json');
    const service = path.join(dir, 'service');
    writeFileSync(file, JSON.stringify({
      nodes: [{
        name: 'Download', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
        parameters: {
          url: new URL(endpoint, receiver.url).href,
          options: { response: { response: { responseFormat: 'file', outputPropertyName: property } } },
        },
      }],
    }));

    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', file, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    symlinkSync(path.resolve('node_modules'), path.join(service, 'node_modules'), 'junction');
    const { workflow_download } = await import(path.join(service, 'workflows', 'download.ts'));
    const original = { data: 'AA==', mimeType: 'application/octet-stream' };
    const inputs = [
      { json: { field: 'attachment' }, binary: { original, [field]: original } },
      { json: { field: 'different' } },
    ];
    const { items } = await workflow_download(inputs);

    expect(items).toHaveLength(2);
    for (const [index, item] of items.entries()) {
      expect(item.binary?.[field]).toMatchObject({
        data: Buffer.from(bytes).toString('base64'),
        fileName,
        fileExtension: extension,
        mimeType: mime,
      });
      expect(item.json).toEqual(inputs[index].json);
      expect(item.pairedItem).toEqual({ item: index });
    }
    expect(items[0].binary.original).toEqual(original);
    expect(inputs[0].binary?.[field]).toEqual(original);
    const manifest = JSON.parse(readFileSync(path.join(service, 'package.json'), 'utf8'));
    expect(manifest.dependencies['mime-types']).toBeDefined();
  } finally {
    await receiver.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict compile reports the unsupported full response envelope for files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-http-full-file-'));
  try {
    const file = path.join(dir, 'download.json');
    writeFileSync(file, JSON.stringify({
      nodes: [{
        name: 'Download', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
        parameters: {
          options: { response: { response: { responseFormat: 'file', fullResponse: true } } },
        },
      }],
    }));

    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', file, '--out', path.join(dir, 'service'), '--strict',
    ]);
    expect(compile.exitCode).toBe(1);
    expect(compile.stderr.toString()).toContain('HTTP Request file responses do not include response headers and status yet');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
