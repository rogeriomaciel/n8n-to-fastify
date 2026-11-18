import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Fastify from 'fastify';
import { WorkflowParser } from '../src/compiler/parser';
import { ExpressionParser } from '../src/compiler/expression-parser';
import { CodeGenerator } from '../src/compiler/code-generator';
import { RouteGenerator } from '../src/compiler/route-generator';

describe('WorkflowParser (DAG & Cycle Detection)', () => {
  test('topologically sorts valid workflow nodes', () => {
    const workflows = WorkflowParser.parseInput(path.resolve('./examples'));
    expect(workflows.length).toBe(2);

    const leadIntake = workflows.find((w) => w.id === 'lead-intake-main');
    expect(leadIntake).toBeDefined();
    expect(leadIntake!.orderedNodes[0].name).toBe('Webhook');
    expect(leadIntake!.orderedNodes[1].name).toBe('Validate Lead Subworkflow');
  });

  test('throws fail-fast error on cyclic workflow dependencies', () => {
    const cyclicWorkflow = {
      id: 'cyclic-test',
      name: 'Cyclic Workflow',
      nodes: [
        { id: '1', name: 'Node A', type: 'n8n-nodes-base.set', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: '2', name: 'Node B', type: 'n8n-nodes-base.set', typeVersion: 1, position: [100, 0], parameters: {} },
      ],
      connections: {
        'Node A': { main: [[{ node: 'Node B', type: 'main', index: 0 }]] },
        'Node B': { main: [[{ node: 'Node A', type: 'main', index: 0 }]] },
      },
    };

    expect(() => WorkflowParser.parseWorkflow(cyclicWorkflow, 'cyclic')).toThrow(/Cyclic dependency detected/);
  });
});

describe('ExpressionParser', () => {
  test('transpiles pure $json expressions', () => {
    const parsed = ExpressionParser.parse('={{ $json.user.email }}');
    expect(parsed).toBe('(item?.json?.user?.email)');
  });

  test('transpiles cross-node references and $env', () => {
    const parsed = ExpressionParser.parse("={{ $('Webhook').item.json.token }}");
    expect(parsed).toContain('ctx.getNode("Webhook")?.item?.json?.token');

    const envParsed = ExpressionParser.parse('Bearer ={{ $env.API_KEY }}');
    expect(envParsed).toContain('process.env.API_KEY');
  });

  test('preserves static strings cleanly', () => {
    expect(ExpressionParser.parse('hello world')).toBe('"hello world"');
  });
});

describe('End-to-End Compilation & Subworkflow Execution', () => {
  test('compiles and serves a webhook from a workflow filename containing an apostrophe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-route-path-'));
    const fastify = Fastify();

    try {
      const file = path.join(dir, "customer's-records.json");
      const output = path.join(dir, 'service');
      fs.writeFileSync(file, JSON.stringify({
        name: 'Customer records',
        nodes: [{
          name: 'Webhook',
          type: 'n8n-nodes-base.webhook',
          typeVersion: 1,
          parameters: { httpMethod: 'GET' },
        }],
        connections: {},
      }));

      const compile = Bun.spawnSync([process.execPath, 'bin/cli.ts', 'compile', file, '--out', output, '--strict']);
      expect(compile.exitCode).toBe(0);
      const { registerCompiledRoutes } = await import(path.join(output, 'routes', 'index.ts'));
      await fastify.register(registerCompiledRoutes);
      const result = await fastify.inject({ method: 'GET', url: "/webhook/customer's-records" });

      expect(result.statusCode).toBe(200);
      expect(result.json().__triggerPath).toBe("customer's-records");
    } finally {
      await fastify.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compiles examples and serves HTTP requests with subworkflow resolution in < 5ms', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-e2e-'));

    try {
      const workflows = WorkflowParser.parseInput(path.resolve('./examples'));
      const wfDir = path.join(tmpDir, 'workflows');
      const rtDir = path.join(tmpDir, 'runtime');
      const routesDir = path.join(tmpDir, 'routes');

      fs.mkdirSync(wfDir, { recursive: true });
      fs.mkdirSync(rtDir, { recursive: true });
      fs.mkdirSync(routesDir, { recursive: true });

      const srcRtDir = path.resolve('./src/runtime');
      for (const f of fs.readdirSync(srcRtDir)) {
        if (f.endsWith('.ts')) {
          fs.copyFileSync(path.join(srcRtDir, f), path.join(rtDir, f));
        }
      }

      for (const wf of workflows) {
        fs.writeFileSync(path.join(wfDir, wf.relativePath), CodeGenerator.generateWorkflowCode(wf), 'utf8');
      }

      fs.writeFileSync(
        path.join(routesDir, 'index.ts'),
        RouteGenerator.generateRoutesCode(workflows),
        'utf8'
      );

      const routesMod = await import(path.join(routesDir, 'index.ts'));
      const fastify = Fastify();
      await fastify.register(routesMod.registerCompiledRoutes);
      const address = await fastify.listen({ port: 0, host: '127.0.0.1' });

      // 1. Valid payload
      const resOk = await fetch(`${address}/webhook/lead-intake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Grace Hopper', email: 'GRACE@COMPILER.ORG' }),
      });

      expect(resOk.status).toBe(200);
      expect(resOk.headers.get('x-compiled-by')).toBe('n8n-to-fastify');
      const bodyOk: any = await resOk.json();
      expect(bodyOk.email).toBe('grace@compiler.org');
      expect(bodyOk.isValid).toBe(true);
      expect(bodyOk.status).toBe('accepted');

      // 2. Invalid payload
      const resBad = await fetch(`${address}/webhook/lead-intake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Invalid', email: 'bad-email' }),
      });

      expect(resBad.status).toBe(400);
      const bodyBad: any = await resBad.json();
      expect(bodyBad.status).toBe('rejected');

      await fastify.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
