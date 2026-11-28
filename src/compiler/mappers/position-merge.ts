import type { N8nNode } from '../core-parser';
import { ExpressionParser } from '../expression-parser';
import type { NodeMapperContext } from './index';

export function isPositionMerge(node: N8nNode): boolean {
  return node.type === 'n8n-nodes-base.merge' &&
    node.parameters?.mode === 'combine' && node.parameters?.combineBy === 'combineByPosition';
}

export function getPositionMergeIssue(node: N8nNode): string | undefined {
  const portCount = node.parameters.numberInputs ?? 2;
  if (!Number.isInteger(portCount) || portCount < 2 || portCount > 10) {
    return 'position Merge requires 2 to 10 input ports';
  }
  for (const { inputIndex = 0 } of node.incomingConnections ?? []) {
    if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= portCount) {
      return 'position Merge has an invalid input port';
    }
  }
}

export function mapPositionMerge(ctx: NodeMapperContext): string {
  const issue = getPositionMergeIssue(ctx.node);
  if (issue) throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);

  const params = ctx.node.parameters;
  const portCount = params.numberInputs ?? 2;
  const options = params.options ?? {};
  const includeUnpaired = ExpressionParser.parse(options.includeUnpaired ?? false);
  const nodeName = JSON.stringify(ctx.node.name);
  const merge = `
      const merged = ((item: N8nItem) => mergeByPosition(
        inputs, Boolean(${includeUnpaired}), ${JSON.stringify(options.clashHandling?.values ?? {})},
      ))(inputs[0][0] || { json: {} });
      ${ctx.variableName} = merged;
      item = merged[0] || { json: {} };
      ctx.setNodeOutputs(${nodeName}, [[0, merged]], merged);`;

  if (ctx.positionMergeEdges) {
    return `
    await appendBatches.runMerge(${nodeName}, ${JSON.stringify(ctx.positionMergeEdges)}, async (received) => {
      const inputs = Array.from({ length: ${portCount} }, (_, port) => received[port] ?? []);${merge}
    });`;
  }

  const sources = Array.from({ length: portCount }, () => [] as string[]);
  for (const { sourceNode, outputIndex, inputIndex = 0 } of ctx.node.incomingConnections ?? []) {
    sources[inputIndex].push(`ctx.getNodeOutput(${JSON.stringify(sourceNode)}, ${outputIndex}) || []`);
  }
  const inputs = sources.map(port => `[${port.join(', ')}].flat()`);
  return `
    {
      const inputs: N8nItem[][] = [${inputs.join(', ')}];${merge}
    }`;
}
