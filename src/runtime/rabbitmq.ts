import type { N8nItem } from './n8n-helper';

interface ConfirmChannel {
  on(event: 'error', handler: (error: Error) => void): void;
  checkExchange(exchange: string): Promise<unknown>;
  publish(
    exchange: string,
    routingKey: string,
    body: Buffer,
    options: Record<string, never>,
    confirm: (error: Error | null) => void,
  ): boolean;
}

interface AmqpConnection {
  on(event: 'error', handler: (error: Error) => void): void;
  createConfirmChannel(): Promise<ConfirmChannel>;
  createChannel(): Promise<ConsumerChannel>;
  close(): Promise<void>;
}

async function connectRabbitMq(): Promise<AmqpConnection> {
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL is required for RabbitMQ nodes');

  // Only generated services with RabbitMQ nodes install this package.
  // Keep the specifier literal so Bun can include it in a standalone executable.
  const { connect } = await import('amqplib' as string) as {
    connect(url: string): Promise<AmqpConnection>;
  };
  const connection = await connect(url);
  // amqplib rejects pending operations on these errors and also emits events.
  connection.on('error', () => {});
  return connection;
}

export async function publishRabbitMq(
  exchange: string,
  routingKey: string,
  messages: string[],
): Promise<N8nItem[]> {
  const connection = await connectRabbitMq();
  try {
    const channel = await connection.createConfirmChannel();
    channel.on('error', () => {});
    await channel.checkExchange(exchange);

    const results: N8nItem[] = [];
    for (const message of messages) {
      const body = Buffer.from(message);
      const success = await new Promise<boolean>((resolve, reject) => {
        const writable = channel.publish(exchange, routingKey, body, {}, (error) => {
          if (error) reject(error);
          else resolve(writable);
        });
      });
      results.push({ json: { success } });
    }
    return results;
  } finally {
    await connection.close().catch(() => {});
  }
}

interface Delivery {
  fields: Record<string, unknown>;
  properties: Record<string, unknown>;
  content: Buffer;
}

interface QueueOptions {
  durable?: boolean;
  autoDelete?: boolean;
  exclusive?: boolean;
}

interface ConsumerChannel {
  on(event: 'error' | 'close', handler: () => void): void;
  assertQueue(queue: string, options: QueueOptions): Promise<unknown>;
  checkQueue(queue: string): Promise<unknown>;
  bindQueue(queue: string, exchange: string, key: string): Promise<unknown>;
  prefetch(count: number): Promise<unknown>;
  consume(queue: string, handleMessage: (message: Delivery | null) => void): Promise<{ consumerTag: string }>;
  ack(message: Delivery): void;
  nack(message: Delivery, allUpTo: boolean, requeue: boolean): void;
  cancel(consumerTag: string): Promise<unknown>;
  close(): Promise<void>;
}

export interface RabbitMqConsumerOptions {
  queue: string;
  bindings: Array<{ exchange: string; routingKey: string }>;
  prefetch?: number;
  parseJson: boolean;
  declareQueue?: QueueOptions;
}

export async function startRabbitMqConsumer(
  options: RabbitMqConsumerOptions,
  runWorkflow: (items: N8nItem[]) => Promise<unknown>,
  report: (message: string) => void,
): Promise<() => Promise<void>> {
  const connection = await connectRabbitMq();
  const running = new Set<Promise<void>>();
  let stopping = false;

  try {
    const channel = await connection.createChannel();
    channel.on('error', () => {});
    channel.on('close', () => {
      if (!stopping) report('RabbitMQ consumer channel closed');
    });
    if (options.declareQueue) await channel.assertQueue(options.queue, options.declareQueue);
    else await channel.checkQueue(options.queue);
    for (const { exchange, routingKey } of options.bindings) {
      await channel.bindQueue(options.queue, exchange, routingKey);
    }
    if (options.prefetch !== undefined) await channel.prefetch(options.prefetch);

    async function handle(message: Delivery) {
      try {
        const body = message.content.toString();
        const content = options.parseJson ? JSON.parse(body) : body;
        await runWorkflow([{ json: { fields: message.fields, properties: message.properties, content } }]);
      } catch {
        channel.nack(message, false, true);
        report('RabbitMQ workflow failed; message requeued');
        return;
      }
      channel.ack(message);
    }

    const { consumerTag } = await channel.consume(options.queue, message => {
      if (!message) {
        if (!stopping) report('RabbitMQ consumer was cancelled by the broker');
        return;
      }
      const execution = handle(message);
      running.add(execution);
      void execution.then(
        () => { running.delete(execution); },
        () => {
          running.delete(execution);
          report('RabbitMQ could not acknowledge or requeue the message');
        },
      );
    });

    return async () => {
      stopping = true;
      try {
        await channel.cancel(consumerTag).catch(() => {});
        await Promise.allSettled(running);
        // Close the channel before the connection so queued acks reach the broker.
        await channel.close().catch(() => {});
      } finally {
        await connection.close().catch(() => {});
      }
    };
  } catch (error) {
    stopping = true;
    await connection.close().catch(() => {});
    throw error;
  }
}
