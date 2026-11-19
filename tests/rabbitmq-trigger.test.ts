import { expect, test } from 'bun:test';
import fs from 'fs';
import { createRequire } from 'node:module';
import os from 'os';
import path from 'path';
import Fastify from 'fastify';
import { parseRabbitMqTrigger, rabbitMqTriggerType } from '../src/compiler/rabbitmq-trigger';

test('RabbitMQ Trigger accepts a queue declaration and rejects unsupported acknowledgement modes', () => {
  const node = {
    id: 'consumer',
    name: 'Consume',
    type: rabbitMqTriggerType,
    typeVersion: 1,
    position: [0, 0] as [number, number],
    parameters: {
      queue: 'jobs',
      options: { acknowledge: 'executionFinishesSuccessfully', assertQueue: true, durable: false },
    },
  };
  expect(parseRabbitMqTrigger(node)).toMatchObject({
    queue: 'jobs', declareQueue: { durable: false }, acknowledge: 'executionFinishesSuccessfully',
  });
  node.parameters.options.acknowledge = 'immediately';
  expect(parseRabbitMqTrigger(node)).toMatchObject({ acknowledge: 'immediately' });
  node.parameters.options.acknowledge = 'executionFinishes';
  expect(parseRabbitMqTrigger(node)).toMatchObject({ acknowledge: 'executionFinishes' });
  node.parameters.options.acknowledge = 'laterMessageNode';
  expect(parseRabbitMqTrigger(node)).toBe(
    'RabbitMQ Trigger supports immediately, executionFinishes, and executionFinishesSuccessfully acknowledgement',
  );
});

const ack = ['ack', 'job'];
const nackAndRequeue = ['nack', false, true];
test.each([
  {
    mode: 'success-only', options: { acknowledge: 'executionFinishesSuccessfully', parallelMessages: 1 },
    setup: [['check', 'jobs']], failureBefore: [], failureAfter: [nackAndRequeue],
    successBefore: [], successAfter: [ack], prefetch: [['prefetch', 1]],
  },
  {
    mode: 'implicit immediate', options: { assertQueue: true, durable: false },
    setup: [['declare', 'jobs', { durable: false }]], failureBefore: [ack], failureAfter: [],
    successBefore: [ack], successAfter: [], prefetch: [],
  },
  {
    mode: 'implicit completion with prefetch', options: { parallelMessages: 1 },
    setup: [['check', 'jobs']], failureBefore: [], failureAfter: [ack],
    successBefore: [], successAfter: [ack], prefetch: [['prefetch', 1]],
  },
])('generated RabbitMQ Trigger settles and drains deliveries in $mode mode', async ({
  options, setup, prefetch, failureBefore, failureAfter, successBefore, successAfter,
}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-rabbitmq-trigger-'));
  const service = path.join(dir, 'service');
  const fastify = Fastify();
  const previousUrl = process.env.RABBITMQ_URL;
  let releaseWorkflow: (() => void) | undefined;
  try {
    const input = path.join(dir, 'consumer.json');
    fs.writeFileSync(input, JSON.stringify({
      nodes: [
        {
          name: 'Consume',
          type: 'n8n-nodes-base.rabbitmqTrigger',
          typeVersion: 1,
          parameters: { queue: 'jobs', options: {
            ...options,
            jsonParseBody: true,
            binding: { bindings: [{ exchange: 'events', routingKey: 'job' }] },
          } },
        },
        {
          name: 'Disabled consumer',
          type: 'n8n-nodes-base.rabbitmqTrigger',
          typeVersion: 1,
          disabled: true,
          parameters: { queue: 'disabled' },
        },
        {
          name: 'Work',
          type: 'n8n-nodes-base.code',
          parameters: { jsCode: 'await require("amqplib").execute($json); return $input.all();' },
        },
        ...['Disabled work', 'Unconnected work'].map(name => ({
          name, type: 'n8n-nodes-base.code',
          parameters: { jsCode: 'throw new Error("unexpected node execution");' },
        })),
      ],
      connections: {
        Consume: { main: [[{ node: 'Work', type: 'main', index: 0 }]] },
        'Disabled consumer': { main: [[{ node: 'Disabled work', type: 'main', index: 0 }]] },
      },
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(service, 'package.json'), 'utf8'));
    expect(manifest.dependencies.amqplib).toBeDefined();

    const broker = path.join(service, 'node_modules', 'amqplib');
    fs.mkdirSync(broker, { recursive: true });
    fs.writeFileSync(path.join(broker, 'package.json'), '{"main":"index.cjs"}');
    fs.writeFileSync(path.join(broker, 'index.cjs'), `
      const events = exports.events = [];
      let deliver;
      exports.deliver = (content, raw = false) => deliver({
        content: Buffer.from(raw ? content : JSON.stringify(content)),
        fields: { routingKey: 'job' },
        properties: { contentType: 'application/json' },
      });
      exports.connect = async () => ({
        on() {},
        async createChannel() {
          return {
            on() {},
            async checkQueue(queue) { events.push(['check', queue]); },
            async assertQueue(queue, options) { events.push(['declare', queue, options]); },
            async bindQueue(...args) { events.push(['bind', ...args]); },
            async prefetch(count) { events.push(['prefetch', count]); },
            async consume(queue, callback) {
              events.push(['consume', queue]);
              deliver = callback;
              return { consumerTag: 'test-consumer' };
            },
            ack(message) { events.push(['ack', message.fields.routingKey]); },
            nack(message, allUpTo, requeue) { events.push(['nack', allUpTo, requeue]); },
            async cancel(tag) { events.push(['cancel', tag]); },
            async close() { events.push(['close channel']); },
          };
        },
        async close() { events.push(['close']); },
      });
    `);

    const client = createRequire(path.join(service, 'server.ts'))('amqplib');
    client.execute = async (json: unknown) => {
      client.events.push(['execute', json]);
      throw new Error('fixture error');
    };
    process.env.RABBITMQ_URL = 'amqp://localhost';
    const routes = await import(path.join(service, 'routes', 'index.ts'));
    await fastify.register(routes.registerCompiledRoutes);
    await fastify.ready();
    expect(client.events).toEqual([
      ...setup, ['bind', 'jobs', 'events', 'job'], ...prefetch, ['consume', 'jobs'],
    ]);

    const malformedStart = client.events.length;
    client.deliver('invalid JSON', true);
    await new Promise(resolve => setImmediate(resolve));
    expect(client.events.slice(malformedStart)).toEqual([...failureBefore, ...failureAfter]);

    const failureStart = client.events.length;
    client.deliver({ id: 'failure' });
    await new Promise(resolve => setImmediate(resolve));
    expect(client.events.slice(failureStart)).toEqual([
      ...failureBefore, ['execute', {
        content: { id: 'failure' },
        fields: { routingKey: 'job' },
        properties: { contentType: 'application/json' },
      }], ...failureAfter,
    ]);

    const gate = new Promise<void>(resolve => { releaseWorkflow = resolve; });
    client.execute = async (json: unknown) => {
      client.events.push(['execute', json]);
      await gate;
    };
    const successStart = client.events.length;
    client.deliver({ id: 'success' });
    await new Promise(resolve => setImmediate(resolve));
    expect(client.events.slice(successStart)).toEqual([...successBefore, ['execute', {
      content: { id: 'success' },
      fields: { routingKey: 'job' },
      properties: { contentType: 'application/json' },
    }]]);

    const closeStart = client.events.length;
    const closing = fastify.close();
    await new Promise(resolve => setImmediate(resolve));
    expect(client.events.at(-1)).toEqual(['cancel', 'test-consumer']);
    releaseWorkflow!();
    await closing;
    expect(client.events.slice(closeStart)).toEqual([
      ['cancel', 'test-consumer'], ...successAfter, ['close channel'], ['close'],
    ]);
  } finally {
    releaseWorkflow?.();
    await fastify.close().catch(() => {});
    if (previousUrl === undefined) delete process.env.RABBITMQ_URL;
    else process.env.RABBITMQ_URL = previousUrl;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
