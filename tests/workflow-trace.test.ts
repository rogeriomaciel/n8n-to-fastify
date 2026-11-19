import { expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Fastify from 'fastify';
import { WorkflowParser } from '../src/compiler/parser';
import { CodeGenerator } from '../src/compiler/code-generator';
import { RouteGenerator } from '../src/compiler/route-generator';
import type { NodeTraceEvent } from '../src/runtime/workflow-trace';
import { WorkflowContext } from '../src/runtime/workflow-context';

test('opt-in traces capture the generated webhook paths without exposing payloads or errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-trace-'));
  const previousTraceEnv = process.env.N8N_TO_FASTIFY_TRACE;
  const originalConsoleInfo = console.info;
  try {
    const input = path.join(dir, 'trace.json');
    const service = path.join(dir, 'service');
    const target = (node: string) => ({ node, type: 'main', index: 0 });
    fs.writeFileSync(input, JSON.stringify({
      id: 'trace-fixture',
      nodes: [
        { id: 'hook', name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'trace' } },
        {
          id: 'decision', name: 'Decide', type: 'n8n-nodes-base.if',
          parameters: { conditions: { conditions: [
            { leftValue: '={{ $json.reject }}', rightValue: true, operator: { operation: 'equals' } },
          ] } },
        },
        {
          id: 'failure', name: 'Fail', type: 'n8n-nodes-base.code',
          parameters: { jsCode: 'throw new Error("fixture-error-detail");' },
        },
        {
          id: 'success', name: 'Accept', type: 'n8n-nodes-base.respondToWebhook',
          parameters: { respondWith: 'json', responseBody: '{"status":"accepted"}' },
        },
      ],
      connections: {
        Webhook: { main: [[target('Decide')]] },
        Decide: { main: [[target('Fail')], [target('Accept')]] },
      },
    }));

    const workflows = WorkflowParser.parseInput(input);
    fs.mkdirSync(path.join(service, 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(service, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(service, 'routes'), { recursive: true });
    for (const file of fs.readdirSync(path.resolve('src/runtime'))) {
      if (file.endsWith('.ts')) {
        fs.copyFileSync(path.resolve('src/runtime', file), path.join(service, 'runtime', file));
      }
    }
    for (const wf of workflows) {
      fs.writeFileSync(path.join(service, 'workflows', wf.relativePath), CodeGenerator.generateWorkflowCode(wf), 'utf8');
    }
    fs.writeFileSync(path.join(service, 'routes', 'index.ts'), RouteGenerator.generateRoutesCode(workflows), 'utf8');

    const { registerCompiledRoutes } = await import(path.join(service, 'routes', 'index.ts'));
    const fastify = Fastify();
    await fastify.register(registerCompiledRoutes);
    const address = await fastify.listen({ port: 0, host: '127.0.0.1' });

    const replay = async (trace: string) => {
      const captured: string[] = [];
      process.env.N8N_TO_FASTIFY_TRACE = trace;
      console.info = (...args: unknown[]) => {
        captured.push(args.map(arg => String(arg)).join(' '));
      };
      const responses: Array<{ statusCode: number; result?: unknown }> = [];
      try {
        for (const reject of [false, true]) {
          const response = await fetch(`${address}/webhook/trace`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reject, value: 'fixture-input-detail' }),
          });
          responses.push({
            statusCode: response.status,
            ...(response.status === 200 ? { result: await response.json() } : {}),
          });
        }
      } finally {
        console.info = originalConsoleInfo;
      }

      const rawOutput = captured.join('\n') + JSON.stringify(responses);
      expect(rawOutput).not.toContain('fixture-input-detail');
      expect(rawOutput).not.toContain('fixture-error-detail');
      const events = captured
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(line => line.type === 'workflow.node') as NodeTraceEvent[];
      return { events, responses };
    };

    try {
      const disabled = await replay('0');
      expect(disabled.events).toEqual([]);
      const enabled = await replay('1');
      expect(enabled.responses).toEqual([
        { statusCode: 200, result: { status: 'accepted' } },
        { statusCode: 500 },
      ]);
      expect(enabled.responses).toEqual(disabled.responses);
      expect(new Set(enabled.events.map(event => event.executionId)).size).toBe(2);
      expect(enabled.events.every(event =>
        event.schemaVersion === 1 && event.executionId.length > 0 && event.workflowId === 'trace-fixture'
      )).toBe(true);
      for (const event of enabled.events) {
        if ('durationMs' in event) expect(event.durationMs).toBeGreaterThanOrEqual(0);
      }

      const stable = enabled.events.map(event => [
        event.nodeId, event.status, ...('outputs' in event ? event.outputs.map(({ port, itemCount }) => [port, itemCount]) : []),
      ]);
      expect(stable).toEqual([
        ['hook', 'started'], ['hook', 'completed', [0, 1]],
        ['decision', 'started'], ['decision', 'completed', [1, 1]],
        ['success', 'started'], ['success', 'completed', [0, 1]],
        ['failure', 'skipped'],
        ['hook', 'started'], ['hook', 'completed', [0, 1]],
        ['decision', 'started'], ['decision', 'completed', [0, 1]],
        ['success', 'skipped'],
        ['failure', 'started'], ['failure', 'error'],
      ]);
    } finally {
      await fastify.close();
    }
  } finally {
    console.info = originalConsoleInfo;
    if (previousTraceEnv === undefined) {
      delete process.env.N8N_TO_FASTIFY_TRACE;
    } else {
      process.env.N8N_TO_FASTIFY_TRACE = previousTraceEnv;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nested workflows share the execution ID and record their own outputs', () => {
  const events: NodeTraceEvent[] = [];
  const context = new WorkflowContext(event => { events.push(event); });
  const finishParent = context.startNodeTrace('parent', 'call', 'Shared name');
  const finishChild = context.startNodeTrace('child', 'step', 'Shared name');
  context.setNodeOutput('Shared name', [{ json: {} }, { json: {} }], 1);
  finishChild?.('completed');
  context.setNodeOutput('Shared name', [{ json: {} }], 0);
  finishParent?.('completed');

  expect(new Set(events.map(event => event.executionId)).size).toBe(1);
  expect(events.filter(event => event.status === 'completed').map(event => [
    event.workflowId, event.nodeId, event.outputs,
  ])).toEqual([
    ['child', 'step', [{ port: 1, itemCount: 2 }]],
    ['parent', 'call', [{ port: 0, itemCount: 1 }]],
  ]);
});

test('generated trace blocks preserve multiline literals from Code nodes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-trace-literals-'));
  try {
    const input = path.join(dir, 'literals.json');
    const service = path.join(dir, 'service');
    fs.writeFileSync(input, JSON.stringify({
      nodes: [
        { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: { path: 'literals' } },
        ...['Standalone', 'Connected'].map(name => ({
          name,
          type: 'n8n-nodes-base.code',
          parameters: { jsCode: 'return [{ json: { value: `first\nsecond` } }];' },
        })),
      ],
      connections: { Webhook: { main: [[{ node: 'Connected', type: 'main', index: 0 }]] } },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service,
    ]);
    expect(compile.exitCode).toBe(0);
    const { workflow_literals } = await import(path.join(service, 'workflows', 'literals.ts'));
    const { context } = await workflow_literals();
    expect(context.getNode('Standalone').first()?.json.value).toBe('first\nsecond');
    expect(context.getNode('Connected').first()?.json.value).toBe('first\nsecond');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
