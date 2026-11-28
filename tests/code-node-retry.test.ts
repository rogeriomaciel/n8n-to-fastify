import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test.each([
  ['stopWorkflow', 'success'],
  ['continueRegularOutput', 'success'],
  ['stopWorkflow', 'recover'],
  ['continueRegularOutput', 'recover'],
  ['stopWorkflow', 'exhaust'],
  ['continueRegularOutput', 'exhaust'],
] as const)('Code retry with %s and outcome=%s', async (onError, outcome) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-code-retry-'));
  const attempts: unknown[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      attempts.push(await request.json());
      const attempt = attempts.length;
      return Response.json({ attempt, ok: outcome === 'success' || (outcome === 'recover' && attempt > 1) });
    },
  });
  try {
    const input = path.join(dir, 'code-retry.json');
    const output = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify({
      nodes: [
        { name: 'Source', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
        {
          name: 'Code', type: 'n8n-nodes-base.code', typeVersion: 2,
          retryOnFail: true, maxTries: 2, waitBetweenTries: 1, onError,
          parameters: { jsCode: `
const response = await fetch(${JSON.stringify(server.url.href)}, {
  method: 'POST',
  body: JSON.stringify({ batch: $input.all().map(row => row.json), upstream: $node['Source'].json }),
});
const { ok, attempt } = await response.json();
if (!ok) throw new Error('fixture failure ' + attempt);
return $input.all();
` },
        },
        { name: 'Next', type: 'n8n-nodes-base.noOp', typeVersion: 1 },
      ],
      connections: {
        Source: { main: [[{ node: 'Code', type: 'main', index: 0 }]] },
        Code: { main: [[{ node: 'Next', type: 'main', index: 0 }]] },
      },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(compile.stderr.toString()).toBe('');
    expect(compile.exitCode).toBe(0);
    const { workflow_code_retry } = await import(path.join(output, 'workflows', 'code-retry.ts'));
    const inputItems = outcome === 'success'
      ? [{ json: { value: 1, error: onError === 'stopWorkflow' ? false : null } }, { json: { value: 2 } }]
      : [{ json: { value: 1 } }, { json: { value: 2 } }];
    const run = workflow_code_retry(inputItems);
    if (outcome === 'exhaust' && onError === 'stopWorkflow') {
      await expect(run).rejects.toThrow('fixture failure 2');
    } else {
      const { context, items } = await run;
      const expected = outcome === 'exhaust' ? [{ json: { error: 'fixture failure 2' } }] : inputItems;
      expect(items).toEqual(expected);
      expect(context.getNodeRunItems('Code', 0, 0)).toEqual(expected);
      expect(context.getNodeRunItems('Next', 0, 0)).toEqual(expected);
      expect(() => context.getNodeRunItems('Code', 0, 1)).toThrow('Referenced node run does not exist');
      expect(context.getOutputForInputBatch('Source', 0, items)).toEqual(inputItems);
    }
    const payload = { batch: inputItems.map(item => item.json), upstream: inputItems[0].json };
    expect(attempts).toEqual(outcome === 'success' ? [payload] : [payload, payload]);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
