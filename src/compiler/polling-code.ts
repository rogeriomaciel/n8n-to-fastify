import type { N8nNode } from './core-parser';
import type { PollingLoop } from './polling-loops';
import type { BatchEdge } from '../runtime/append-batches';

export function emitPollingLoop(
  loop: PollingLoop,
  nodes: Map<string, N8nNode>,
  mapNode: (node: N8nNode, input: string) => string,
  wrapNode: (node: N8nNode, condition: string, body: string) => string,
  trackedEdges?: (node: N8nNode) => BatchEdge[],
): string {
  const { entry, terminalExits, repeatPort, ...runtimePlan } = loop;
  const entryNode = nodes.get(entry)!;
  const initial = entryNode.incomingConnections!.find(connection => !loop.nodes.includes(connection.sourceNode))!;
  const trackedEntry = trackedEdges?.(entryNode).find(edge =>
    edge.source === initial.sourceNode && edge.output === initial.outputIndex
  );
  const retryTarget = loop.nodes[(loop.nodes.indexOf(loop.decision) + 1) % loop.nodes.length];
  const trackedRetry = trackedEdges?.(nodes.get(retryTarget)!).find(edge =>
    edge.source === loop.decision && edge.output === repeatPort
  );
  const runner = trackedEntry ? 'appendBatches.runPollingLoop' : 'ctx.runPollingLoop';
  const inputArgs = trackedEntry ? `${JSON.stringify(trackedEntry)}, ${trackedRetry!.priority}` :
    'ctx.getNodeOutputBatches(' + JSON.stringify(initial.sourceNode) + ', ' + initial.outputIndex + ')';
  let body = '';
  for (const [index, name] of loop.nodes.entries()) {
    const node = nodes.get(name)!;
    if (index === 0) {
      body += wrapNode(node, 'true', mapNode(node, 'pollingItems'));
    } else {
      const incoming = node.incomingConnections!.find(connection => connection.sourceNode === loop.nodes[index - 1])!;
      const input = 'pollingInput_' + index;
      body += '    const ' + input + ' = ctx.getNodeOutput(' +
        JSON.stringify(incoming.sourceNode) + ', ' + incoming.outputIndex + ');\n';
      body += wrapNode(node, input + '?.length', mapNode(node, input));
    }
    if (name !== loop.decision) continue;
    for (const [exitIndex, exit] of terminalExits.entries()) {
      const terminal = nodes.get(exit.target)!;
      const output = 'pollingTerminal_' + exitIndex;
      body += '    const ' + output + ' = ctx.getNodeOutput(' + JSON.stringify(name) + ', ' + exit.output + ');\n';
      body += wrapNode(terminal, output + '?.length', mapNode(terminal, output));
    }
    body += '    if (ctx.getNodeOutput(' + JSON.stringify(name) + ', ' + repeatPort + ')?.length) assertCanRetry();\n';
  }
  return '  await ' + runner + '(' + JSON.stringify(runtimePlan) + ', ' + inputArgs +
    ', async (pollingItems, assertCanRetry) => {\n' + body + '  });\n';
}
