import { expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('generated RabbitMQ 1.1 publisher sends one JSON message per item and waits for confirmation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2f-rabbitmq-'));
  const service = path.join(dir, 'service');
  const input = path.join(dir, 'publish.json');
  try {
    // RabbitMQ node as exported by n8n 1.123.5.
    fs.writeFileSync(input, JSON.stringify({
      nodes: [{
        name: 'Publish',
        type: 'n8n-nodes-base.rabbitmq',
        typeVersion: 1.1,
        parameters: {
          mode: 'exchange',
          exchange: 'events',
          exchangeType: 'direct',
          routingKey: '={{ $json.key }}',
          options: {},
        },
      }],
    }));
    const compile = Bun.spawnSync([
      process.execPath, path.resolve('bin/cli.ts'), 'compile', input, '--out', service, '--strict',
    ]);
    expect(compile.exitCode).toBe(0);
    const manifest = JSON.parse(fs.readFileSync(path.join(service, 'package.json'), 'utf8'));
    expect(manifest.dependencies.amqplib).toBeDefined();

    const client = path.join(service, 'node_modules', 'amqplib');
    fs.mkdirSync(client, { recursive: true });
    fs.writeFileSync(path.join(client, 'package.json'), '{"main":"index.cjs"}');
    fs.writeFileSync(path.join(client, 'index.cjs'), `
      exports.connect = async () => ({
        on() {},
        async close() { console.log('connection closed'); },
        async createConfirmChannel() {
          let count = 0;
          return {
            on() {},
            async checkExchange(name) { console.log('checked ' + name); },
            publish(exchange, key, body, _options, confirm) {
              ++count;
              console.log(JSON.stringify({ exchange, key, body: JSON.parse(body.toString()) }));
              queueMicrotask(() => confirm(process.env.TEST_NACK ? new Error('nack') : null));
              return count === 1;
            },
          };
        },
      });
    `);
    fs.writeFileSync(path.join(service, 'verify.ts'), `
      import { workflow_publish } from './workflows/publish';
      const { items } = await workflow_publish([{ json: { key: 'one' } }, { json: { key: 'two' } }]);
      console.log(JSON.stringify(items));
    `);
    const command = [process.execPath, 'run', 'verify.ts'];
    const env = { ...process.env, RABBITMQ_URL: 'amqp://localhost', TEST_NACK: '' };
    const success = Bun.spawnSync(command, { cwd: service, env });
    expect(success.exitCode).toBe(0);
    const expectedOutput = [
      'checked events',
      '{"exchange":"events","key":"one","body":{"key":"one"}}',
      '{"exchange":"events","key":"one","body":{"key":"two"}}',
      'connection closed',
      '[{"json":{"success":true}},{"json":{"success":false}}]',
    ];
    expect(success.stdout.toString().trim().split('\n')).toEqual(expectedOutput);

    const failure = Bun.spawnSync(command, { cwd: service, env: { ...env, TEST_NACK: '1' } });
    expect(failure.exitCode).toBe(1);
    expect(failure.stderr.toString()).toContain('nack');
    expect(failure.stdout.toString()).toContain('connection closed');
    expect(failure.stdout.toString()).not.toContain('"two"');

    const executable = path.join(dir, process.platform === 'win32' ? 'verify.exe' : 'verify');
    const build = Bun.spawnSync([process.execPath, 'build', '--compile', 'verify.ts', '--outfile', executable], {
      cwd: service,
    });
    expect(build.stderr.toString()).toBe('');
    expect(build.exitCode).toBe(0);
    fs.renameSync(path.join(service, 'node_modules'), path.join(service, 'unused-dependencies'));
    const standalone = Bun.spawnSync([executable], { cwd: dir, env });
    expect(standalone.stderr.toString()).toBe('');
    expect(standalone.exitCode).toBe(0);
    expect(standalone.stdout.toString().trim().split('\n')).toEqual(expectedOutput);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
