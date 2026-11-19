import type { N8nNode, ParsedWorkflow } from './core-parser';
import { ExpressionParser } from './expression-parser';

export interface CommunityAdapter {
  type: string;
  typeVersion: number;
  binding: string;
  fileName: string;
  parameters: string[];
  handlesRetries: boolean;
}

export function selectCommunityAdapters<T extends CommunityAdapter>(workflow: ParsedWorkflow, adapters: readonly T[]) {
  const selected = new Map<N8nNode, T>();
  for (const node of workflow.nodes) {
    if (node.disabled || workflow.triggers.includes(node)) continue;
    const adapter = adapters.find(entry => entry.type === node.type && entry.typeVersion === node.typeVersion);
    if (adapter) selected.set(node, adapter);
  }
  return selected;
}

export function mapCommunityNode(node: N8nNode, adapter: CommunityAdapter, output: string, input: string): string {
  const metadata = JSON.stringify({
    id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion,
    retryOnFail: node.retryOnFail === true, maxTries: node.maxTries, waitBetweenTries: node.waitBetweenTries,
  });
  const entries = adapter.parameters.filter(name => Object.hasOwn(node.parameters ?? {}, name)).map(name => {
    const value = node.parameters[name];
    const expression = value === null ? 'null' : ExpressionParser.parse(value, 'adapterItems[0]', 'adapterItems');
    return `[${JSON.stringify(name)}]: ${expression}`;
  });
  return `{
    const adapterItems: N8nItem[] = ${input} || inputItems;
    const parameters = (index = 0) => {
      const item = adapterItems[index] ?? { json: {} };
      return { ${entries.join(', ')} };
    };
    ${output} = await executeCommunityAdapter(${adapter.binding}, { node: ${metadata}, items: adapterItems, parameters });
    item = ${output}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(node.name)}, ${output});
  }`;
}
