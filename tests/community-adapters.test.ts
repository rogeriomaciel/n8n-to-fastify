import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('the CLI compiles and runs an explicitly registered community action adapter', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'n2f-community-'));
  try {
    const flows = path.join(root, 'workflows');
    mkdirSync(path.join(flows, 'nested'), { recursive: true });
    const workflow = path.join(flows, 'nested', 'example.json');
    const output = path.join(root, 'service');
    const manifest = path.join(root, 'adapters.json');
    const write = (file: string, data: unknown) => writeFileSync(file, JSON.stringify(data));
    const type = 'n8n-nodes-example.mergeAction';
    const graph = { nodes: [{
      name: 'Prepare', id: 'prepare', type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { jsCode: 'return $input.all().map(item => ({ json: { amount: item.json.amount + 10 } }));' },
    }, {
      name: 'Echo', id: 'echo-fixture', type, typeVersion: 1, retryOnFail: true, maxTries: 2,
      parameters: { value: '={{ $json.amount * 2 }}', first: '={{ $input.first().json.amount }}', opaque: 'fixture-omitted' },
      credentials: { example: { id: 'omitted-credential-id' } },
    }], connections: { Prepare: { main: [[{ node: 'Echo', type: 'main', index: 0 }]] } } };
    write(workflow, graph);
    const adapter = {
      type, typeVersion: 1, module: './echo fixture.mjs',
      parameters: ['value', 'first'], dependencies: { 'left-pad': '1.3.0' }, handlesRetries: true,
    };
    const configure = (entry: Record<string, unknown>) => write(manifest, { schemaVersion: 1, adapters: [entry] });
    writeFileSync(path.join(root, 'echo fixture.mjs'), `
      export default ({ node, items, parameters }) => items.map((_, index) => ({
        json: { ...parameters(index), node: node.id, retry: node.maxTries }, pairedItem: { item: index },
      }));
    `);
    const compile = (...flags: string[]) => Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', flows, '--out', output, '--strict', ...flags,
    ]);
    const absent = compile();
    expect(absent.exitCode).toBe(1);
    expect(absent.stderr.toString()).toContain('unsupported node type');
    configure({ ...adapter, typeVersion: 2 });
    const wrongVersion = compile('--adapters', manifest);
    expect(wrongVersion.exitCode).toBe(1);
    expect(wrongVersion.stderr.toString()).toContain('at typeVersion 1');
    configure({ ...adapter, handlesRetries: false });
    expect(compile('--adapters', manifest).stderr.toString()).toContain('does not handle Retry On Fail');
    configure({ ...adapter, dependencies: { fastify: '^5.0.0' } });
    expect(compile('--adapters', manifest).stderr.toString()).toContain("Conflicting generated dependency 'fastify'");
    expect(existsSync(output)).toBe(false);

    configure(adapter);
    write(workflow, { ...graph, connections: {
      ...graph.connections, Echo: { main: [[], [{ node: 'Next', type: 'main', index: 0 }]] },
    }, nodes: [...graph.nodes, {
      name: 'Next', id: 'next', type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { jsCode: 'return $input.all();' },
    }] });
    const unsupportedOutput = compile('--adapters', manifest);
    expect(unsupportedOutput.exitCode).toBe(1);
    expect(unsupportedOutput.stderr.toString()).toContain('community adapters support only main output 0');
    expect(existsSync(output)).toBe(false);
    write(workflow, graph);
    const compiled = compile('--adapters', manifest);
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
    const workflowPath = path.join(output, 'workflows', 'nested', 'example.ts');
    const generated = readFileSync(workflowPath, 'utf8');
    expect(generated).not.toContain('fixture-omitted');
    expect(generated).not.toContain('omitted-credential-id');
    expect(JSON.parse(readFileSync(path.join(output, 'package.json'), 'utf8')).dependencies['left-pad']).toBe('1.3.0');
    const { workflow_example } = await import(workflowPath);
    const { items } = await workflow_example([{ json: { amount: 2 } }, { json: { amount: 5 } }]);
    expect(items).toEqual([
      { json: { value: 24, first: 12, node: 'echo-fixture', retry: 2 }, pairedItem: { item: 0 } },
      { json: { value: 30, first: 12, node: 'echo-fixture', retry: 2 }, pairedItem: { item: 1 } },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
