import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const modelOptions = { temperature: '={{ $json.temperature }}', maxTokensToSample: 64 };

function fixture(fallbackSlot = 1, options?: Record<string, unknown>) {
  const prefix = '@n8n/n8n-nodes-langchain.';
  const target = (node: string, type: string, index = 0) => ({ [type]: [[{ node, type, index }]] });
  return {
    nodes: [
      { name: 'Start', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { jsCode: 'return $input.all();' } },
      { name: 'Chain', type: prefix + 'chainLlm', typeVersion: 1.7, parameters: {
        promptType: 'define', text: '={{ $json.prompt }}', needsFallback: true,
        messages: { messageValues: [{ message: '={{ $json.system }}' }] },
        batching: { batchSize: 2 },
      } },
      { name: 'Fallback', id: 'secondary-model', type: prefix + 'lmChatOllama', typeVersion: 1,
        parameters: { model: 'backup-model', options: { temperature: 0.2, topK: 4, topP: 0.6, numPredict: 32 } } },
      { name: 'Primary', id: 'primary-model', type: prefix + 'lmChatGroq', typeVersion: 1,
        credentials: { modelApi: { id: 'fixture-credential-id', name: 'fixture-credential-name' } },
        parameters: { model: '={{ $json.model }}', options } },
      { name: 'Unused', id: 'unused-model', type: prefix + 'lmChatOllama', typeVersion: 1, parameters: {} },
    ],
    connections: {
      Start: target('Chain', 'main'),
      Fallback: target('Chain', 'ai_languageModel', fallbackSlot),
      Primary: target('Chain', 'ai_languageModel'),
    },
  };
}

test.each([
  { label: 'explicit options', options: modelOptions, expected: { temperature: 0, max_tokens: 64 } },
  { label: 'empty options', options: {}, expected: { temperature: 0.7 } },
  { label: 'omitted options', options: undefined, expected: { temperature: 0.7 } },
])('compiled model links preserve settings and fallback with $label', async ({ options, expected }) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-linked-llm-'));
  const requests: Array<{ route: string; auth: string | null; body: any }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const route = new URL(request.url).pathname;
    const body = await request.json();
    requests.push({ route, auth: request.headers.get('authorization'), body });
    const prompt = body.messages.at(-1).content;
    if (route === '/left/v1/chat/completions') {
      if (prompt === 'switch') return Response.json({ message: 'fake failure' }, { status: 400 });
      return Response.json({ choices: [{ message: { content: ' primary result ' } }] });
    }
    if (route === '/right/api/chat') return Response.json({ message: { content: ' fallback result ' } });
    return new Response(null, { status: 404 });
  } });
  const saved = Object.fromEntries(['N8N_LANGUAGE_MODEL_CONNECTIONS', 'FIXTURE_LEFT_TOKEN', 'FIXTURE_RIGHT_TOKEN']
    .map(key => [key, process.env[key]]));
  try {
    const input = path.join(dir, 'linked.json');
    const output = path.join(dir, 'service');
    writeFileSync(input, JSON.stringify(fixture(1, options)));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(compile.stderr.toString()).toBe('');
    expect(compile.exitCode).toBe(0);
    const file = path.join(output, 'workflows', 'linked.ts');
    expect(readFileSync(file, 'utf8')).not.toContain('fixture-credential');
    const { workflow_linked } = await import(file);
    const models = {
      'primary-model': { baseUrl: server.url.origin + '/left/v1/', apiKeyEnv: 'FIXTURE_LEFT_TOKEN' },
      'secondary-model': { baseUrl: server.url.origin + '/right', apiKeyEnv: 'FIXTURE_RIGHT_TOKEN' },
    };
    process.env.FIXTURE_LEFT_TOKEN = 'example-left';
    process.env.FIXTURE_RIGHT_TOKEN = 'example-right';
    process.env.N8N_LANGUAGE_MODEL_CONNECTIONS = JSON.stringify(models);
    const inputs = [
      { json: { prompt: 'stay', system: 'first', model: 'first-model', temperature: 0 } },
      { json: { prompt: 'switch', system: 'second', model: 'different', temperature: 0.9 } },
    ];
    const result = await workflow_linked(inputs);
    expect(result.items).toEqual([
      { json: { text: 'primary result' }, pairedItem: { item: 0 } },
      { json: { text: 'fallback result' }, pairedItem: { item: 1 } },
    ]);
    expect(result.context.hasExecutedNode('Unused')).toBe(false);
    for (const { json } of inputs) {
      const matching = requests.filter(request => request.body.messages.at(-1).content === json.prompt);
      const messages = [{ role: 'system', content: json.system }, { role: 'user', content: json.prompt }];
      expect(matching[0]).toEqual({
        route: '/left/v1/chat/completions', auth: 'Bearer example-left',
        body: { model: 'first-model', messages, ...expected },
      });
      if (json.prompt === 'stay') {
        expect(matching).toHaveLength(1);
      } else {
        expect(matching).toHaveLength(2);
        expect(matching[1]).toEqual({
          route: '/right/api/chat', auth: 'Bearer example-right',
          body: { model: 'backup-model', messages, options: { temperature: 0.2, top_k: 4, top_p: 0.6, num_predict: 32 }, stream: false },
        });
      }
    }
    process.env.N8N_LANGUAGE_MODEL_CONNECTIONS = JSON.stringify({ 'primary-model': models['primary-model'] });
    await expect(workflow_linked(inputs)).rejects.toThrow('Missing language model connection');
    expect(requests).toHaveLength(3);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([['duplicate slot'], ['missing models'], ['unsupported retry']])('strict mode rejects %s before writing the service', scenario => {
  const dir = mkdtempSync(path.join(tmpdir(), 'n2f-llm-slot-'));
  try {
    const input = path.join(dir, 'invalid.json');
    const output = path.join(dir, 'service');
    const workflow = fixture(scenario === 'duplicate slot' ? 0 : 1);
    const { Start } = workflow.connections;
    const nodes = workflow.nodes.map(node => scenario === 'unsupported retry' && node.name === 'Chain'
      ? { ...node, retryOnFail: true } : node);
    writeFileSync(input, JSON.stringify({ ...workflow, nodes, connections: scenario === 'missing models' ? { Start } : workflow.connections }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict',
    ]);
    expect(compile.exitCode).toBe(1);
    expect(compile.stderr.toString()).toContain(scenario === 'unsupported retry' ? 'Retry On Fail' : 'one compatible primary model');
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
