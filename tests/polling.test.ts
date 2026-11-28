import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CoreWorkflowParser } from '../src/compiler/core-parser';
import type { CompiledWorkflowFn } from '../src/runtime/workflow-registry';

const target = (node: string) => [{ node, type: 'main', index: 0 }];
const pass = { jsCode: 'return $input.all();' };
const node = (name: string, type: string, parameters: object, typeVersion = 1) =>
  ({ name, type: 'n8n-nodes-base.' + type, parameters, typeVersion });

function fixture(origin: string, secondCycle: boolean) {
  const nodes = [
    node('Source', 'code', pass),
    node('Finish', 'code', { jsCode: `return $input.all().map(({ json }) => ({
      json: { ...json, waited: $('Wait').isExecuted },
    }));` }),
  ];
  const connections: Record<string, { main: ReturnType<typeof target>[] }> = { Source: { main: [target('Prepare')] } };
  const rule = (value: string) => ({ conditions: { conditions: [{
    leftValue: '={{ $json.state }}', rightValue: value, operator: { type: 'string', operation: 'equals' },
  }] } });
  const stage = (suffix: string, exit: string, startsAtWait: boolean) => {
    const poll = 'Request' + suffix;
    const wait = 'Wait' + suffix;
    const decide = 'Decide' + suffix;
    const stop = 'Stop' + suffix;
    const url = '=' + origin + '/' + (suffix ? 'second' : 'first') + '/{{ $json.id }}';
    nodes.push(
      node(poll, 'httpRequest', { url }, 4.2),
      node(wait, 'wait', { amount: '={{ $json.pause }}' }, 1.1),
      node(decide, 'switch', { rules: { values: [rule('ready'), rule('failed')] }, options: { fallbackOutput: 'extra' } }, 3.2),
      node(stop, 'stopAndError', { errorMessage: '={{ $json.reason }}' }),
    );
    connections[decide] = { main: [target(exit), target(stop), target(wait)] };
    if (startsAtWait) {
      connections[wait] = { main: [target(poll)] };
      connections[poll] = { main: [target(decide)] };
    } else {
      nodes.push(node('Prepare', 'code', pass), node('Inspect', 'code', pass));
      connections.Prepare = { main: [target(poll)] };
      connections[poll] = { main: [target('Inspect')] };
      connections.Inspect = { main: [target(decide)] };
      connections[wait] = { main: [target('Prepare')] };
    }
  };
  stage('', secondCycle ? 'Wait2' : 'Finish', false);
  if (secondCycle) stage('2', 'Finish', true);
  return { nodes, connections };
}

async function withCompiledPolling(
  options: { secondCycle?: boolean; maxAttempts?: string },
  check: (run: CompiledWorkflowFn, requests: string[]) => Promise<void>,
) {
  const requests: string[] = [];
  const counts = new Map<string, number>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const [, stage, id] = new URL(request.url).pathname.split('/');
    const key = stage + '/' + id;
    requests.push(key);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const goal = id === 'fast' ? 1 : stage === 'first' ? 3 : 2;
    const state = id === 'fail' ? 'failed' : id !== 'pending' && count >= goal ? 'ready' : 'pending';
    return Response.json({ id, state, pause: 0, stage, reason: 'fixture terminal failure' });
  } });
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-poll-'));
  const previousLimit = process.env.N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS;
  try {
    process.env.N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS = options.maxAttempts ?? '5';
    const input = path.join(dir, 'poll.json');
    const output = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify(fixture(server.url.origin, options.secondCycle ?? false)));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    if (compile.exitCode !== 0) throw new Error(compile.stderr.toString());
    const { workflow_poll } = await import(path.join(output, 'workflows', 'poll.ts'));
    await check(workflow_poll, requests);
  } finally {
    if (previousLimit === undefined) delete process.env.N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS;
    else process.env.N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS = previousLimit;
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('two polling cycles preserve separate completed batches and retry only pending items', async () => {
  await withCompiledPolling({ secondCycle: true }, async (run, requests) => {
    const { context, items } = await run([{ json: { id: 'fast' } }, { json: { id: 'slow' } }]);
    expect(items.map(item => [item.json.stage, item.json.id])).toEqual([['second', 'fast'], ['second', 'slow']]);
    expect(requests.slice(0, 2).sort()).toEqual(['first/fast', 'first/slow']);
    expect(requests.slice(2)).toEqual(['first/slow', 'first/slow', 'second/fast', 'second/slow', 'second/slow']);
    expect(context.getNodeOutputBatches('Decide', 0).map(batch => batch.map(item => item.json.id)))
      .toEqual([['fast'], ['slow']]);
    expect(context.getNodeOutput('Decide', 2)).toBeUndefined();
    expect(context.getNodeOutput('Decide2', 2)).toBeUndefined();
  });
});

test('a ready item exits on the first attempt', async () => {
  await withCompiledPolling({}, async (run, requests) => {
    expect((await run([{ json: { id: 'fast' } }])).items.map(item => item.json.id)).toEqual(['fast']);
    expect(requests).toEqual(['first/fast']);
  });
});

test('a polling retry remains executed after the final attempt skips it', async () => {
  await withCompiledPolling({}, async (run, requests) => {
    const slow = await run([{ json: { id: 'slow' } }]);
    expect(slow.items[0].json.waited).toBe(true);
    expect(slow.context.getNodeOutput('Wait', 0)).toBeUndefined();
    const fast = await run([{ json: { id: 'fast' } }]);
    expect(fast.items[0].json.waited).toBe(false);
    expect(requests).toEqual(['first/slow', 'first/slow', 'first/slow', 'first/fast']);
  });
});

test('polling stops at the configured attempt limit', async () => {
  await withCompiledPolling({ maxAttempts: '2' }, async (run, requests) => {
    await expect(run([{ json: { id: 'pending' } }])).rejects.toThrow('limit of 2 attempts');
    expect(requests).toEqual(['first/pending', 'first/pending']);
  });
});

test('a direct Stop and Error exit prevents subsequent requests for pending items', async () => {
  await withCompiledPolling({}, async (run, requests) => {
    await expect(run([{ json: { id: 'pending' } }, { json: { id: 'fail' } }]))
      .rejects.toThrow('fixture terminal failure');
    expect(requests.sort()).toEqual(['first/fail', 'first/pending']);
  });
});

test('a cyclic component with a second entry is rejected', () => {
  const graph = fixture('http://127.0.0.1', false);
  graph.connections.Source.main[0].push(...target('Wait'));
  expect(() => CoreWorkflowParser.parseWorkflow(graph, 'invalid')).toThrow('Only single-entry polling loops');
});

test('polling rejects a Switch that could emit an item to both retry and exit ports', () => {
  const graph = fixture('http://127.0.0.1', false);
  const router = graph.nodes.find(node => node.name === 'Decide')!;
  router.parameters = { ...router.parameters, options: { allMatchingOutputs: true } };
  expect(() => CoreWorkflowParser.parseWorkflow(graph, 'invalid')).toThrow('Only single-entry polling loops');
});
