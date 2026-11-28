import type { N8nNode } from '../core-parser';
import { ExpressionParser } from '../expression-parser';
import type { NodeMapperContext } from './index';

export function isRawEditFields(node: N8nNode): boolean {
  return node.type === 'n8n-nodes-base.set' && node.parameters?.mode === 'raw';
}

export function usesRawLegacyNodeReferences(node: N8nNode): boolean {
  const value = node.parameters?.jsonOutput;
  return isRawEditFields(node) && typeof value === 'string' &&
    value.startsWith('=') && /\{\{[\s\S]*?\$node\b[\s\S]*?\}\}/.test(value);
}

export function getRawEditFieldsIssue(node: N8nNode): string | undefined {
  if (!isRawEditFields(node)) return;
  if (node.typeVersion !== 3.4) return 'Edit Fields JSON Output requires node version 3.4';

  const params = node.parameters;
  const { dotNotation, stripBinary } = params.options ?? {};
  if ([params.includeOtherFields, dotNotation, stripBinary].some(value =>
    value !== undefined && typeof value !== 'boolean'
  )) {
    return 'Edit Fields JSON Output requires static field and binary options';
  }
  if (params.includeOtherFields !== false && params.includeOtherFields !== undefined &&
    !['all', 'none'].includes(params.include ?? 'all')) {
    return 'Edit Fields JSON Output supports including all or none of the input fields';
  }
  if (params.duplicateItem) return 'Edit Fields JSON Output does not support manual item duplication';
}

function compileJsonOutput(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('=')) return JSON.stringify(value);

  const template = value.replace(/^=+/, '');
  const compileExpression = (expression: string) =>
    ExpressionParser.parse('=' + expression, 'source[0]', 'source');
  const trimmed = template.trim();
  if (trimmed.startsWith('{{') && trimmed.endsWith('}}') && !trimmed.slice(2, -2).includes('{{')) {
    return compileExpression(trimmed);
  }

  const fragments: string[] = [];
  let offset = 0;
  let quoted = false;
  for (const expression of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const literal = template.slice(offset, expression.index);
    for (const [token] of literal.matchAll(/\\[\s\S]|"/g)) {
      if (token === '"') quoted = !quoted;
    }
    fragments.push(JSON.stringify(literal));
    fragments.push('encodeJsonTemplateValue(' + compileExpression(expression[0]) + ', ' + quoted + ')');
    offset = expression.index! + expression[0].length;
  }
  fragments.push(JSON.stringify(template.slice(offset)));
  return '[' + fragments.join(', ') + "].join('')";
}

export function mapRawEditFields(ctx: NodeMapperContext): string {
  const params = ctx.node.parameters;
  const options = params.options ?? {};
  const jsonOutput = compileJsonOutput(params.jsonOutput === undefined
    ? { my_field_1: 'value', my_field_2: 1 } : params.jsonOutput);
  const includeAll = params.includeOtherFields === true && (params.include ?? 'all') === 'all';
  const stripBinary = options.stripBinary ?? true;
  const dotNotation = options.dotNotation ?? true;
  const legacyBinding = ctx.legacyNodePorts
    ? 'const $node = createLegacyNodeReferences(ctx, workflowNodeNames, ' +
      JSON.stringify(ctx.legacyNodePorts) + ', itemIndex);'
    : '';
  return [
    '{',
    '  const source: N8nItem[] = ' + (ctx.previousVariableName ?? 'inputItems') + ';',
    '  ' + ctx.variableName + ' = source.map((item, itemIndex) => {',
    ...(legacyBinding ? ['    ' + legacyBinding] : []),
    '    return applyRawEditFields(item, itemIndex, ' + jsonOutput + ', {',
    '      includeAll: ' + includeAll + ', stripBinary: ' + stripBinary + ',',
    '      dotNotation: ' + dotNotation + ',',
    '    });',
    '  });',
    '}',
    'item = ' + ctx.variableName + '[0] || { json: {} };',
    'ctx.setNodeOutput(' + JSON.stringify(ctx.node.name) + ', ' + ctx.variableName + ');',
  ].join('\n');
}
