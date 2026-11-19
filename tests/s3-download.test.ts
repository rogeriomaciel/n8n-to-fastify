import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function writeModule(service: string, packageName: string, source: string): void {
  const moduleDir = path.join(service, 'node_modules', packageName);
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(path.join(moduleDir, 'package.json'), '{"main":"index.cjs"}');
  writeFileSync(path.join(moduleDir, 'index.cjs'), source);
}

test('S3 v1 download preserves item order, JSON and binary content', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-s3-download-'));
  try {
    const input = path.join(dir, 'fetch.json');
    const service = path.join(dir, 'service');
    const node = {
      name: 'Fetch file', type: 'n8n-nodes-base.s3', typeVersion: 1,
      parameters: {
        bucketName: '={{ $json.bucket }}',
        fileKey: '={{ $json.key }}',
        binaryPropertyName: '={{ $json.field ?? "data" }}',
      },
    };
    writeFileSync(input, JSON.stringify({ nodes: [node] }));
    const command = [process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--strict', '--out'];
    const compile = Bun.spawnSync([...command, service]);
    expect(compile.exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(path.join(service, 'package.json'), 'utf8'));
    expect(manifest.dependencies['@aws-sdk/client-s3']).toBeDefined();
    expect(manifest.dependencies['mime-types']).toBeDefined();

    writeModule(service, '@aws-sdk/client-s3', `
      exports.GetObjectCommand = class { constructor(input) { this.input = input; } };
      exports.S3Client = class {
        constructor(config) {
          if (config.endpoint !== 'http://127.0.0.1:9000' ||
              config.credentials.accessKeyId !== 'fixture-access' || !config.forcePathStyle) {
            throw new Error('unexpected fixture S3 configuration');
          }
        }
        async send({ input }) {
          if (input.Bucket !== 'first' && input.Bucket !== 'second') throw new Error('unexpected bucket');
          if (input.Key === 'missing') {
            throw Object.assign(new Error('fixture-sensitive-detail'), { name: 'NoSuchKey' });
          }
          return {
            Body: { transformToByteArray: async () => Buffer.from(input.Bucket === 'first' ? [0, 255] : [1, 2, 3]) },
            ContentType: input.Bucket === 'first' ? 'application/octet-stream' : undefined,
          };
        }
        destroy() {}
      };
    `);
    writeModule(service, 'mime-types', `
      exports.lookup = (name) => name.endsWith('.txt') && 'text/plain';
      exports.extension = () => false;
    `);

    writeFileSync(path.join(service, 'verify.ts'), `
      import assert from 'node:assert/strict';
      import { workflow_fetch } from './workflows/fetch';
      const first = { json: { bucket: 'first', key: 'docs/sample.bin' }, binary: { retained: { data: 'AA==' } } };
      const second = { json: { bucket: 'second', key: 'draft.txt', field: 'attachment' } };
      const { items } = await workflow_fetch([first, second]);
      assert.deepEqual(items.map(item => item.json), [first.json, second.json]);
      assert.deepEqual(items[0].binary, {
        retained: { data: 'AA==' },
        data: { data: 'AP8=', mimeType: 'application/octet-stream', fileName: 'sample.bin', fileExtension: 'bin', fileSize: '2 B', fileType: undefined },
      });
      assert.deepEqual(items[1].binary, {
        attachment: { data: 'AQID', mimeType: 'text/plain', fileName: 'draft.txt', fileExtension: 'txt', fileSize: '3 B', fileType: 'text' },
      });
      assert.deepEqual(first.binary, { retained: { data: 'AA==' } });
      await assert.rejects(workflow_fetch([{ json: { bucket: 'first', key: 'missing' } }]), error =>
        error instanceof Error && error.message === 'S3 Download could not find the requested object'
      );
    `);
    const env = {
      ...process.env, S3_ENDPOINT: 'http://127.0.0.1:9000', S3_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: 'fixture-access', AWS_SECRET_ACCESS_KEY: 'fixture-secret',
    };
    const verified = Bun.spawnSync([process.execPath, 'run', 'verify.ts'], { cwd: service, env });
    expect(verified.stderr.toString()).toBe('');
    expect(verified.exitCode).toBe(0);

    const executable = path.join(dir, process.platform === 'win32' ? 'verify.exe' : 'verify');
    const build = Bun.spawnSync([process.execPath, 'build', '--compile', 'verify.ts', '--outfile', executable], {
      cwd: service,
    });
    expect(build.stderr.toString()).toBe('');
    expect(build.exitCode).toBe(0);
    renameSync(path.join(service, 'node_modules'), path.join(service, 'unused-dependencies'));
    const standalone = Bun.spawnSync([executable], { cwd: dir, env });
    expect(standalone.stderr.toString()).toBe('');
    expect(standalone.exitCode).toBe(0);

    writeFileSync(input, JSON.stringify({ nodes: [{
      ...node, parameters: { ...node.parameters, operation: 'upload' },
    }] }));
    const unsupported = Bun.spawnSync([...command, path.join(dir, 'unsupported')]);
    expect(unsupported.exitCode).toBe(1);
    expect(unsupported.stderr.toString()).toContain('S3 supports File / Download on node version 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
