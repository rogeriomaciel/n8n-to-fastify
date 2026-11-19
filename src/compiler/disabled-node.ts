import type { N8nConnectionTarget, N8nNode, ParsedWorkflow } from './core-parser';

type DisabledNodeMode = 'skip' | 'passthrough';

export function getDisabledNodeMode(node: N8nNode, workflow: ParsedWorkflow): DisabledNodeMode | undefined {
  if (!node.disabled || workflow.triggers.includes(node) || node.type.toLowerCase().endsWith('trigger')) return;

  const outputs = Object.entries(workflow.connections[node.name] ?? {}) as Array<[string, N8nConnectionTarget[][]]>;
  for (const [type, ports] of outputs) {
    for (const [port, targets] of ports.entries()) {
      if (!targets?.length) continue;
      if (type !== 'main' || port !== 0) return;
    }
  }

  let hasIncoming = false;
  for (const outputs of Object.values(workflow.connections)) {
    for (const [type, ports] of Object.entries(outputs) as Array<[string, N8nConnectionTarget[][]]>) {
      for (const targets of ports) {
        for (const target of targets ?? []) {
          if (target?.node !== node.name) continue;
          if (hasIncoming || type !== 'main' || (target.index ?? 0) !== 0) return;
          hasIncoming = true;
        }
      }
    }
  }

  return hasIncoming ? 'passthrough' : 'skip';
}
