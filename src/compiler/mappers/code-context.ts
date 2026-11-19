import type { N8nNode } from '../core-parser';

export function isCodeNode(node: N8nNode): boolean {
  return node.type.includes('code') || node.type.includes('function');
}

export function usesLegacyNodeReferences(node: N8nNode): boolean {
  if (!isCodeNode(node)) return false;
  const code = node.parameters?.jsCode || node.parameters?.functionCode;
  return typeof code === 'string' && /\$node\b/.test(code);
}

export function getLegacyNodeReferenceIssue(node: N8nNode): string | undefined {
  if (usesLegacyNodeReferences(node) && node.parameters?.mode === 'runOnceForEachItem') {
    return 'Code legacy $node references require Run Once for All Items';
  }
}

export function collectLegacyNodePorts(
  node: N8nNode,
  nodesByName: ReadonlyMap<string, N8nNode>,
): Array<[string, number]> {
  const upstream = new Map<string, number>();
  const queue = [node];
  const visited = new Set([node.name]);
  for (let index = 0; index < queue.length; index++) {
    const incoming = [...(queue[index].incomingConnections ?? [])];
    // n8n's lookup walks the nearest incoming paths in destination-port order.
    incoming.sort((a, b) => (a.inputIndex ?? 0) - (b.inputIndex ?? 0));
    for (const { sourceNode, outputIndex } of incoming) {
      if (visited.has(sourceNode)) continue;
      visited.add(sourceNode);
      upstream.set(sourceNode, outputIndex);
      const source = nodesByName.get(sourceNode);
      if (source) queue.push(source);
    }
  }
  return [...upstream];
}
