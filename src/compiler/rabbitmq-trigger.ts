import type { N8nNode, ParsedWorkflow } from './core-parser';
import type { RabbitMqConsumerOptions } from '../runtime/rabbitmq';

export const rabbitMqTriggerType = 'n8n-nodes-base.rabbitmqTrigger';

export function getRabbitMqTriggers(workflow: ParsedWorkflow): N8nNode[] {
  return workflow.nodes.filter(node => node.type === rabbitMqTriggerType && !node.disabled);
}

function isStaticString(value: unknown): value is string {
  return typeof value === 'string' && !value.startsWith('=') && !value.includes('{{');
}

export function parseRabbitMqTrigger(node: N8nNode): RabbitMqConsumerOptions | string {
  if ((node.typeVersion ?? 1) !== 1) return 'RabbitMQ Trigger needs typeVersion 1';

  const { queue, options: rawOptions } = node.parameters ?? {};
  const options = rawOptions ?? {};
  if (!isStaticString(queue) || !queue.trim()) return 'RabbitMQ Trigger needs a static queue name';
  if (typeof options !== 'object' || Array.isArray(options)) {
    return 'RabbitMQ Trigger needs static options';
  }
  const acknowledge = options.acknowledge ?? 'immediately';
  if (acknowledge !== 'immediately' && acknowledge !== 'executionFinishes' &&
    acknowledge !== 'executionFinishesSuccessfully') {
    return 'RabbitMQ Trigger supports immediately, executionFinishes, and executionFinishesSuccessfully acknowledgement';
  }
  if (options.contentIsBinary || options.onlyContent) {
    return 'RabbitMQ Trigger supports text or parsed JSON in the message envelope';
  }

  const prefetch = options.parallelMessages ?? -1;
  if (!Number.isInteger(prefetch) || (prefetch !== -1 && (prefetch < 1 || prefetch > 65535))) {
    return 'RabbitMQ Trigger needs parallelMessages between 1 and 65535, or -1';
  }

  const bindings: unknown = options.binding?.bindings ?? [];
  if (!Array.isArray(bindings) || !bindings.every(binding =>
    isStaticString(binding?.exchange) && binding.exchange.length > 0 && isStaticString(binding?.routingKey))) {
    return 'RabbitMQ Trigger needs static exchange names and routing keys in its bindings';
  }

  for (const key of ['assertQueue', 'durable', 'autoDelete', 'exclusive', 'jsonParseBody']) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      return 'RabbitMQ Trigger needs static boolean queue and message settings';
    }
  }
  if (options.assertQueue && Object.keys(options.arguments ?? {}).length > 0) {
    return 'RabbitMQ Trigger queue declaration does not support custom arguments';
  }

  // n8n checks the queue by default and binds only to existing exchanges.
  // Legacy assertExchange metadata does not affect its queue-trigger path.
  return {
    queue,
    bindings: bindings.map(({ exchange, routingKey }) => ({ exchange, routingKey })),
    // n8n defers acknowledgement when prefetch limits delivery concurrency.
    acknowledge: acknowledge === 'immediately' && prefetch !== -1 ? 'executionFinishes' : acknowledge,
    prefetch: prefetch === -1 ? undefined : prefetch,
    parseJson: options.jsonParseBody === true,
    declareQueue: options.assertQueue ? {
      durable: options.durable,
      autoDelete: options.autoDelete,
      exclusive: options.exclusive,
    } : undefined,
  };
}
