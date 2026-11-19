import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('generated Postgres listeners dispatch to their own branches and recover after a disconnect', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'n2f-postgres-'));
  const env = process.env.POSTGRES_TRIGGER_URL;
  const fixtures = globalThis as typeof globalThis & { postgresTriggerFixture?: unknown[] };
  fixtures.postgresTriggerFixture = [];
  try {
    const input = path.join(directory, 'listen.json');
    const output = path.join(directory, 'service');
    const source = (name: string, channelName: string, disabled = false) => ({
      name, type: 'n8n-nodes-base.postgresTrigger', typeVersion: 1, disabled,
      parameters: { triggerMode: 'listenTrigger', channelName, options: { connectionTimeout: 2 } },
    });
    const capture = (name: string) => ({
      name, type: 'n8n-nodes-base.code', typeVersion: 2,
      parameters: { jsCode: `globalThis.postgresTriggerFixture.push({ lane: ${JSON.stringify(name)}, data: $input.first().json }); return $input.all();` },
    });
    const graph = {
      nodes: [source('First', 'FIRST_EVENTS'), source('Second', 'second_events'), source('Disabled', 'disabled', true),
        { name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, parameters: { path: 'fixture' } },
        capture('First Result'), capture('Second Result'), capture('Webhook Result')],
      connections: Object.fromEntries(['First', 'Second', 'Webhook'].map(name => [
        name, { main: [[{ node: `${name} Result`, type: 'main', index: 0 }]] },
      ])),
    };
    const compile = () => {
      writeFileSync(input, JSON.stringify(graph));
      return Bun.spawnSync([process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', output, '--strict']);
    };
    graph.nodes[0] = source('First', 'channel with spaces');
    const invalid = compile();
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain('needs a static channel name');
    graph.nodes[0] = source('First', 'FIRST_EVENTS');
    expect(compile().exitCode).toBe(0);
    expect(JSON.parse(readFileSync(path.join(output, 'package.json'), 'utf8')).dependencies.pg).toBeDefined();

    const fake = path.join(output, 'node_modules', 'pg');
    mkdirSync(fake, { recursive: true });
    writeFileSync(path.join(fake, 'index.js'), `
const { EventEmitter } = require('node:events');
const clients = [];
class Client extends EventEmitter {
  constructor(options) { super(); this.options = options; clients.push(this); }
  async connect() {}
  async query(sql) { this.sql = sql; }
  async end() { this.ended = true; this.emit('end'); }
}
module.exports = { Client, clients };
`);
    const { clients } = createRequire(path.join(output, 'server.ts'))('pg');
    const { registerCompiledRoutes } = await import(path.join(output, 'routes', 'index.ts'));
    const hooks = new Map<string, () => Promise<void>>();
    const messages: string[] = [];
    await registerCompiledRoutes({
      route() {}, addHook: (name: string, callback: () => Promise<void>) => hooks.set(name, callback),
      log: { error: (_context: unknown, message: string) => messages.push(message) },
    });
    process.env.POSTGRES_TRIGGER_URL = 'postgres://fixture:fixture@localhost/fixture';
    await hooks.get('onReady')!();
    try {
      expect(clients.map((client: any) => client.sql)).toEqual(['LISTEN "first_events"', 'LISTEN "second_events"']);
      expect(clients[0].options.connectionTimeoutMillis).toBe(2000);
      const first = { length: 40, name: 'notification', processId: 12, channel: 'first_events', payload: '{"amount":3}' };
      const second = { ...first, channel: 'second_events', payload: 'fixture text' };
      clients[0].emit('notification', first);
      clients[1].emit('notification', second);
      await Bun.sleep(5);
      expect(fixtures.postgresTriggerFixture).toEqual([
        { lane: 'First Result', data: { ...first, payload: { amount: 3 } } },
        { lane: 'Second Result', data: second },
      ]);
      clients[0].emit('error', new Error('fixture disconnect detail'));
      for (let i = 0; !clients[2]?.sql && i < 150; i++) await Bun.sleep(10);
      expect(clients[0].ended).toBe(true);
      expect(clients[2]?.sql).toBe('LISTEN "first_events"');
      expect(messages).toEqual(['Postgres Trigger connection lost']);
      clients[2].emit('notification', { ...first, payload: '' });
      await Bun.sleep(5);
      expect(fixtures.postgresTriggerFixture?.at(-1)).toEqual({ lane: 'First Result', data: { ...first, payload: '' } });
    } finally {
      await hooks.get('onClose')!();
    }
    expect(clients.every((client: any) => client.ended)).toBe(true);
  } finally {
    if (env === undefined) delete process.env.POSTGRES_TRIGGER_URL;
    else process.env.POSTGRES_TRIGGER_URL = env;
    delete fixtures.postgresTriggerFixture;
    rmSync(directory, { recursive: true, force: true });
  }
});
