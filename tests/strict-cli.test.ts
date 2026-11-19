import { expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const cli = path.resolve('bin/cli.ts');

test('strict compile reports known incompatibilities before writing output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-strict-'));
  try {
    const input = path.join(dir, 'workflow.json');
    const output = path.join(dir, 'service');
    fs.writeFileSync(input, JSON.stringify({
      name: 'Compatibility fixture',
      nodes: [
        { name: 'Trigger', type: 'example-nodes.trigger', parameters: {} },
        { name: 'Note', type: 'n8n-nodes-base.stickyNote', parameters: {} },
        {
          name: 'Legacy Code',
          type: 'n8n-nodes-base.code',
          retryOnFail: true,
          continueOnFail: true,
          parameters: { jsCode: 'throw new Error("fixture error");' },
        },
        {
          name: 'Request',
          type: 'n8n-nodes-base.httpRequest',
          onError: 'continueRegularOutput',
          parameters: {
            sendBody: true, contentType: 'raw',
            sendHeaders: true, specifyHeaders: 'json',
          },
        },
        { name: 'Edit', type: 'n8n-nodes-base.set', parameters: { mode: 'raw' } },
        {
          name: 'Join',
          type: 'n8n-nodes-base.merge',
          parameters: { mode: 'combine', numberInputs: 3 },
        },
      ],
      connections: { Request: { ai_tool: [[{ node: 'Edit', index: 0, type: 'ai_tool' }]] } },
    }));

    const strict = Bun.spawnSync([process.execPath, cli, 'compile', input, '--out', output, '--strict']);
    expect(strict.exitCode).toBe(1);
    const diagnostics = strict.stderr.toString();
    expect(diagnostics).toContain('Workflow "Compatibility fixture", node "Trigger": unsupported node type');
    expect(diagnostics).toContain('connection type "ai_tool" is ignored');
    expect(diagnostics).toContain('only JSON and multipart request bodies are supported');
    expect(diagnostics).toContain('the configured onError behavior is ignored');
    expect(diagnostics).toContain('node "Legacy Code": legacy continueOnFail is ignored');
    expect(diagnostics).toContain('node "Legacy Code": Retry On Fail is only supported for HTTP Request and S3 Download');
    expect(diagnostics).toContain('Edit Fields JSON Output requires node version 3.4');
    expect(diagnostics).toContain('combine mode reads at most two inputs');
    expect(diagnostics).not.toContain('node "Note"');
    expect(fs.existsSync(output)).toBe(false);

    const legacy = Bun.spawnSync([process.execPath, cli, 'compile', input, '--out', output]);
    expect(legacy.exitCode).toBe(0);
    expect(fs.existsSync(path.join(output, 'server.ts'))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  ['invalid JSON', '{'],
  ['a JSON file without a workflow', '{}'],
])('strict directory compile fails on %s', (_description, contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-strict-dir-'));
  try {
    fs.copyFileSync('examples/01-lead-intake.json', path.join(dir, 'valid.json'));
    const nested = path.join(dir, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'broken.json'), contents);
    const output = path.join(dir, 'service');
    const result = Bun.spawnSync([process.execPath, cli, 'compile', dir, '--out', output, '--strict']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('broken.json');
    expect(fs.existsSync(output)).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('strict compile accepts the bundled examples', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-strict-examples-'));
  try {
    const result = Bun.spawnSync([process.execPath, cli, 'compile', 'examples', '--out', output, '--strict']);
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(path.join(output, 'server.ts'))).toBe(true);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
