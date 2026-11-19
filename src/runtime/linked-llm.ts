import type { N8nItem } from './n8n-helper';

export type ModelTransport = 'chat-completions' | 'ollama';

interface Model {
  id: string;
  transport: ModelTransport;
  model: string;
  options: Record<string, unknown>;
}

interface ConnectedModel extends Model {
  endpoint: URL;
  apiKey?: string;
}

interface ChainOptions {
  primary: Model;
  fallback?: Model;
  batchSize: number;
  delay: number;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function readConnections(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(process.env.N8N_LANGUAGE_MODEL_CONNECTIONS ?? '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {}
  throw new Error('Language model connections must be a JSON object');
}

function connect(model: Model, settings: Record<string, unknown>): ConnectedModel {
  const config = Object.hasOwn(settings, model.id) ? settings[model.id] : undefined;
  if (!config || typeof config !== 'object' || !('baseUrl' in config) || typeof config.baseUrl !== 'string') {
    throw new Error('Missing language model connection configuration');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.baseUrl);
  } catch {
    throw new Error('Invalid language model connection URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Invalid language model connection URL');
  }
  const route = model.transport === 'ollama' ? '/api/chat' : '/chat/completions';
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + route;
  let apiKey: string | undefined;
  if ('apiKeyEnv' in config) {
    if (typeof config.apiKeyEnv !== 'string' || !config.apiKeyEnv || !process.env[config.apiKeyEnv]) {
      throw new Error('Missing environment variable for a language model connection');
    }
    apiKey = process.env[config.apiKeyEnv];
  }
  if (!model.model || Object.values(model.options).some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Invalid language model parameters');
  }
  return { ...model, endpoint, apiKey };
}

async function requestModel(connection: ConnectedModel, messages: ChatMessage[]): Promise<string> {
  const { endpoint, model, options, transport, apiKey } = connection;
  const ollama = transport === 'ollama';
  const body = ollama ? { model, messages, options, stream: false } : { model, messages, ...options };
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Model HTTP failure');
    }
    const result = await response.json() as {
      message?: { content?: unknown };
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const content = ollama ? result?.message?.content : result?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content.trim();
  } catch {}
  throw new Error('Language model request failed');
}

export async function runLinkedLlmChain(
  items: N8nItem[],
  messagesFor: (item: N8nItem) => ChatMessage[],
  optionsFor: (first: N8nItem) => ChainOptions,
): Promise<N8nItem[]> {
  if (!items.length) return [];
  const { primary, fallback, batchSize, delay } = optionsFor(items[0]);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(delay) || delay < 0) {
    throw new Error('Invalid language model batch settings');
  }
  const settings = readConnections();
  const first = connect(primary, settings);
  const second = fallback && connect(fallback, settings);
  const output: N8nItem[] = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const responses = await Promise.allSettled(items.slice(offset, offset + batchSize).map(async item => {
      const messages = messagesFor(item);
      try {
        return await requestModel(first, messages);
      } catch (error) {
        if (!second) throw error;
        return requestModel(second, messages);
      }
    }));
    for (const [index, response] of responses.entries()) {
      if (response.status === 'rejected') throw response.reason;
      output.push({ json: { text: response.value }, pairedItem: { item: offset + index } });
    }
    if (batchSize > 1 && delay > 0 && offset + batchSize < items.length) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return output;
}
