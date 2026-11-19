import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('compiled HTTP retries settle and replay the entire input batch', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-http-retry-'));
  const originalFetch = globalThis.fetch;
  try {
    const input = path.join(dir, 'request.json');
    const compile = async (retryOnFail: boolean, service: string) => {
      writeFileSync(input, JSON.stringify({
        nodes: [{
          name: 'Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
          retryOnFail, maxTries: 2, waitBetweenTries: 0,
          parameters: { url: '={{ $json.url }}', method: 'POST' },
        }],
      }));
      expect(Bun.spawnSync([
        process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service, '--strict',
      ]).exitCode).toBe(0);
      if (retryOnFail) expect(readFileSync(path.join(service, 'workflows', 'request.ts'), 'utf8')).toContain('})), 2, 0)');
      const { workflow_request } = await import(path.join(service, 'workflows', 'request.ts'));
      return workflow_request;
    };
    const withRetry = await compile(true, path.join(dir, 'enabled'));
    const withoutRetry = await compile(false, path.join(dir, 'disabled'));
    const calls: string[] = [];
    let failures = 1;
    globalThis.fetch = (async (url, options) => {
      const item = String(url).split('/').at(-1)!;
      expect(options?.method).toBe('POST');
      calls.push(item);
      if (item === 'first') {
        await Bun.sleep(20);
        calls.push('first settled');
      }
      if (item === 'second' && failures-- > 0) throw new Error('fixture request failed');
      return Response.json({ item });
    }) as typeof fetch;
    const inputItems = ['first', 'second'].map(item => ({ json: { url: 'http://127.0.0.1/' + item } }));

    const result = await withRetry(inputItems);
    expect(result.items).toEqual([{ json: { item: 'first' } }, { json: { item: 'second' } }]);
    expect(calls).toEqual(['first', 'second', 'first settled', 'first', 'second', 'first settled']);

    calls.length = 0;
    failures = 2;
    await expect(withRetry([inputItems[1]])).rejects.toThrow('fixture request failed');
    expect(calls).toEqual(['second', 'second']);

    calls.length = 0;
    let returnedErrors = 1;
    globalThis.fetch = (async () => {
      calls.push('response');
      return Response.json(returnedErrors-- > 0 ? { error: 'fixture response error' } : { recovered: true });
    }) as typeof fetch;
    const recovered = await withRetry([inputItems[1]]);
    expect(recovered.items).toEqual([{ json: { recovered: true } }]);
    expect(calls).toEqual(['response', 'response']);

    calls.length = 0;
    returnedErrors = 3;
    const exhausted = await withRetry([inputItems[1]]);
    expect(exhausted.items).toEqual([{ json: { error: 'fixture response error' } }]);
    expect(calls).toEqual(['response', 'response']);

    calls.length = 0;
    returnedErrors = 1;
    const disabled = await withoutRetry([inputItems[1]]);
    expect(disabled.items).toEqual([{ json: { error: 'fixture response error' } }]);
    expect(calls).toEqual(['response']);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
