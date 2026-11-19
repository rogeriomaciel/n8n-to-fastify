import type { N8nNode, ParsedWorkflow } from './core-parser';
import type { PostgresTriggerOptions } from '../runtime/postgres-trigger';

export const postgresTriggerType = 'n8n-nodes-base.postgresTrigger';

export function getPostgresTriggers(workflow: ParsedWorkflow): N8nNode[] {
  return workflow.nodes.filter(node => node.type === postgresTriggerType && !node.disabled);
}

export function parsePostgresTrigger(node: N8nNode): PostgresTriggerOptions | string {
  if ((node.typeVersion ?? 1) !== 1) return 'Postgres Trigger needs typeVersion 1';
  const { triggerMode, channelName, options = {} } = node.parameters ?? {};
  if (triggerMode !== 'listenTrigger') return 'Postgres Trigger supports only Listen to Channel mode';
  if (typeof channelName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(channelName)) {
    return 'Postgres Trigger needs a static channel name of up to 63 letters, digits or underscores';
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'connectionTimeout' && key !== 'delayClosingIdleConnection') ||
      (options.delayClosingIdleConnection ?? 0) !== 0) {
    return 'Postgres Trigger supports only the connection timeout option';
  }
  const seconds = options.connectionTimeout ?? 30;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 2_147_483) {
    return 'Postgres Trigger needs a positive connection timeout in seconds within the timer range';
  }
  return { channel: channelName.toLowerCase(), connectionTimeoutMillis: seconds * 1000 };
}
