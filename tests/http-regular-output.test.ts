import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('HTTP Request continues with paired errors and successful responses in input order', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'n2f-http-continue-'));
  const calls: number[] = [];
  const receiver = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { index } = await request.json();
      calls.push(index);
      if (index === 1) {
        return Response.json({ message: 'fixture response body' }, { status: 503 });
      }
      // A later response can arrive before the first.
      if (index === 0) await Bun.sleep(10);
      return Response.json({ index });
    },
  });

  try {
    const compile = async (neverError: boolean | string, name = String(neverError)) => {
      const input = path.join(directory, 'request.json');
      const output = path.join(directory, name);
      writeFileSync(input, JSON.stringify({ nodes: [{
        name: 'HTTP Request', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
        onError: 'continueRegularOutput',
        parameters: {
          method: 'POST', url: '={{ $json.url }}', sendBody: true, specifyBody: 'json',
          jsonBody: '={{ ({ index: $json.index }) }}',
          options: { response: { response: { neverError } } },
        },
      }] }));
      const result = Bun.spawnSync([
        process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
      ]);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      const { workflow_request } = await import(path.join(output, 'workflows', 'request.ts'));
      return workflow_request;
    };
    const url = `http://127.0.0.1:${receiver.port}`;
    const batch = [0, 1, 2].map(index => ({
      json: { index, url },
      binary: { proof: { data: 'aGk=' } },
    }));
    const run = await compile(false);
    const { items } = await run(batch);
    expect(items).toEqual([
      { json: { index: 0 }, pairedItem: { item: 0 } },
      { json: { error: { message: 'HTTP Request failed with status 503', status: 503 } }, pairedItem: { item: 1 } },
      { json: { index: 2 }, pairedItem: { item: 2 } },
    ]);

    const invalidInput = await run([{ json: { index: 0, url: 'invalid' } }, batch[2]]);
    expect(invalidInput.items).toEqual([
      { json: { error: 'HTTP Request URL must be a valid HTTP or HTTPS URL' }, pairedItem: { item: 0 } },
      { json: { index: 2 }, pairedItem: { item: 1 } },
    ]);
    expect(calls).toHaveLength(4);

    const ignoreStatus = await compile(true);
    const ignored = await ignoreStatus([batch[1]]);
    expect(ignored.items).toEqual([
      { json: { message: 'fixture response body' }, pairedItem: { item: 0 } },
    ]);
    const fromBatch = await compile('={{ $input.first().json.ignoreStatus && $input.all().length === 2 }}', 'batch');
    expect((await fromBatch([
      { json: { ...batch[0].json, ignoreStatus: true } },
      { json: { ...batch[1].json, ignoreStatus: false } },
    ])).items).toEqual([
      { json: { index: 0 }, pairedItem: { item: 0 } },
      { json: { message: 'fixture response body' }, pairedItem: { item: 1 } },
    ]);
  } finally {
    await receiver.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
