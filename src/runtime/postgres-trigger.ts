import { createRequire } from 'node:module';
import type { N8nItem } from './n8n-helper';

export interface PostgresTriggerOptions {
  channel: string;
  connectionTimeoutMillis: number;
}

interface Notification {
  length: number;
  processId: number;
  channel: string;
  payload: string;
  name: string;
}

interface ConnectionSettings {
  connectionString: string;
  connectionTimeoutMillis: number;
  query_timeout: number;
  keepAlive: boolean;
}

interface Connection {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', callback: (notification: Notification) => void): void;
  on(event: 'error' | 'end', callback: () => void): void;
}

function notificationItem(notification: Notification): N8nItem {
  let payload: unknown = notification.payload;
  if (notification.payload) {
    try { payload = JSON.parse(notification.payload); } catch { /* PostgreSQL also carries plain text. */ }
  }
  return { json: { ...notification, payload } };
}

export async function startPostgresTrigger(
  options: PostgresTriggerOptions,
  execute: (items: N8nItem[]) => Promise<unknown>,
  report: (message: string) => void,
): Promise<() => Promise<void>> {
  const connectionString = process.env.POSTGRES_TRIGGER_URL;
  if (!connectionString) throw new Error('POSTGRES_TRIGGER_URL is required for Postgres Trigger nodes');
  const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: ConnectionSettings) => Connection };
  const settings = {
    connectionString, connectionTimeoutMillis: options.connectionTimeoutMillis,
    query_timeout: options.connectionTimeoutMillis, keepAlive: true,
  };
  const query = `LISTEN "${options.channel.replaceAll('"', '""')}"`;
  const running = new Set<Promise<void>>();
  let active: Connection | undefined;
  let recovery: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping = false;

  function scheduleReconnect() {
    if (stopping || active || timer || recovery) return;
    timer = setTimeout(() => {
      timer = undefined;
      recovery = connect().catch(() => report('Postgres Trigger reconnect failed')).finally(() => {
        recovery = undefined;
        scheduleReconnect();
      });
    }, 1000);
  }

  async function connect() {
    const connection = new Client(settings);
    let lost = false;
    const disconnected = () => {
      lost = true;
      if (stopping || active !== connection) return;
      active = undefined;
      void connection.end().catch(() => {});
      report('Postgres Trigger connection lost');
      scheduleReconnect();
    };
    connection.on('error', disconnected);
    connection.on('end', disconnected);
    connection.on('notification', notification => {
      if (stopping || lost || notification.channel !== options.channel) return;
      const task = Promise.resolve().then(() => execute([notificationItem(notification)]))
        .then(() => {}, () => report('Postgres Trigger workflow failed'));
      running.add(task);
      void task.then(() => running.delete(task), () => running.delete(task));
    });
    try {
      await connection.connect();
      await connection.query(query);
      if (lost) throw new Error('Connection closed during LISTEN');
      active = connection;
    } catch {
      await connection.end().catch(() => {});
      throw new Error('Postgres Trigger could not connect and listen');
    }
  }

  await connect();
  return async () => {
    stopping = true;
    clearTimeout(timer);
    await recovery;
    const connection = active;
    active = undefined;
    try {
      await connection?.end();
    } finally {
      await Promise.allSettled(running);
    }
  };
}
