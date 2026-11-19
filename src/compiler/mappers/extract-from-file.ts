import type { N8nNode } from '../core-parser';
import { ExpressionParser } from '../expression-parser';
import type { NodeMapperContext } from './index';

export const extractFromFileType = 'n8n-nodes-base.extractFromFile';

export function getExtractFromFileIssue(node: N8nNode): string | undefined {
  const version = node.typeVersion ?? 1;
  if ((version !== 1 && version !== 1.1) || node.parameters?.operation !== 'binaryToPropery') {
    return 'Extract From File supports Move File to Base64 String on node versions 1 and 1.1';
  }
}

export function mapExtractFromFile(ctx: NodeMapperContext): string {
  const issue = getExtractFromFileIssue(ctx.node);
  if (issue) throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);

  const params = ctx.node.parameters ?? {};
  const parse = (value: unknown) => ExpressionParser.parse(value, 'source[0]', 'source');
  const binaryProperty = parse(params.binaryPropertyName ?? 'data');
  const destination = parse(params.destinationKey ?? 'data');
  const keepSource = parse(params.options?.keepSource ?? '');
  return `
    {
      const source: N8nItem[] = ${ctx.previousVariableName ?? 'inputItems'} || inputItems;
      ${ctx.variableName} = extractBase64Items(source, item => ({
        keepSource: ${keepSource},
        binaryProperty: String(${binaryProperty} ?? ''),
        get destination() { return String(${destination} ?? ''); },
      }));
      item = ${ctx.variableName}[0] || { json: {} };
      ctx.setNodeOutputs(${JSON.stringify(ctx.node.name)}, [[0, ${ctx.variableName}]], ${ctx.variableName});
    }`;
}
