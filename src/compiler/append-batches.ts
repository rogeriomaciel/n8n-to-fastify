import type { N8nNode, ParsedWorkflow } from './core-parser';
import type { BatchEdge } from '../runtime/append-batches';

export function planAppendBatches(workflow: ParsedWorkflow) {
  const merges = new Set(workflow.executionOrder === 'v1' ? workflow.nodes.filter(node =>
    node.type === 'n8n-nodes-base.merge' && !node.disabled &&
    (node.parameters?.mode ?? 'append') === 'append' && node.incomingConnections?.length
  ).map(node => node.name) : []);

  const tracked = new Set<string>();
  const nodes = new Map(workflow.nodes.map(node => [node.name, node]));
  const visit = (name: string) => {
    if (tracked.has(name)) return;
    tracked.add(name);
    for (const edge of nodes.get(name)?.incomingConnections ?? []) visit(edge.sourceNode);
  };
  merges.forEach(visit);

  const edges = new Map<string, BatchEdge[]>();
  for (const [fallback, source] of workflow.orderedNodes.entries()) {
    if (!tracked.has(source.name)) continue;
    const outputs = workflow.connections[source.name]?.main;
    if (!Array.isArray(outputs)) continue;
    const outgoing: Array<{ target: N8nNode; output: number; input: number }> = [];
    for (const [output, targets] of outputs.entries()) {
      if (!Array.isArray(targets)) continue;
      for (const connection of targets) {
        const target = nodes.get(connection?.node);
        if (target) outgoing.push({ target, output, input: connection.index ?? 0 });
      }
    }
    // v1 enqueues lower branches first on a LIFO stack.
    outgoing.sort((a, b) => {
      const [ax, ay] = a.target.position ?? [0, 0];
      const [bx, by] = b.target.position ?? [0, 0];
      return by - ay || (ax > bx ? -1 : 0);
    });
    for (const [index, edge] of outgoing.entries()) {
      if (!tracked.has(edge.target.name)) continue;
      const incoming = edges.get(edge.target.name) ?? [];
      incoming.push({
        source: source.name,
        output: edge.output,
        input: edge.input,
        priority: outgoing.length - 1 - index,
        fallback,
      });
      edges.set(edge.target.name, incoming);
    }
  }

  // Ordinary nodes preserve the input order established by the parser.
  const orderedEdges = (node: N8nNode): BatchEdge[] => {
    const remaining = [...edges.get(node.name) ?? []];
    return (node.incomingConnections ?? []).map(({ sourceNode, outputIndex, inputIndex = 0 }) => {
      const index = remaining.findIndex(edge =>
        edge.source === sourceNode && edge.output === outputIndex && edge.input === inputIndex
      );
      return index < 0 ? undefined : remaining.splice(index, 1)[0];
    }).filter(edge => edge !== undefined);
  };
  return { merges, tracked, orderedEdges };
}
