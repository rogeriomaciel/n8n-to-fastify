import type { N8nItem } from './n8n-helper';
import type { WorkflowContext } from './workflow-context';

interface LegacyNodeReference {
  readonly json: N8nItem['json'];
  readonly data: N8nItem['json'];
  readonly binary: Record<string, unknown>;
}

export function createLegacyNodeReferences(
  context: WorkflowContext,
  nodeNames: ReadonlySet<string>,
  upstreamPorts: Array<[string, number]>,
  itemIndex = 0,
  inputBatch?: N8nItem[],
): Record<string, LegacyNodeReference> {
  const ports = new Map(upstreamPorts);
  return new Proxy(Object.create(null), {
    get(_, name) {
      if (typeof name !== 'string') return;
      if (!nodeNames.has(name)) throw new Error('Referenced node does not exist');

      const readItem = () => {
        if (!context.hasExecutedNode(name)) throw new Error('Referenced node has not executed');
        const port = ports.get(name);
        if (port === undefined) throw new Error('Referenced node is not connected to the Code node');
        const connected = inputBatch && context.getOutputForInputBatch(name, port, inputBatch);
        const items = connected ?? context.getNodeOutput(name, port);
        if (!items?.length) throw new Error('Referenced node output has no items');
        const item = items[itemIndex];
        if (!item) throw new Error('Referenced node output has no item at the current index');
        return item;
      };

      return {
        get json() { return readItem().json; },
        get data() { return readItem().json; },
        get binary() {
          return Object.fromEntries(Object.entries(readItem().binary ?? {}).map(([key, field]) => {
            const metadata = { ...field };
            delete metadata.data;
            return [key, metadata];
          }));
        },
      };
    },
  });
}
