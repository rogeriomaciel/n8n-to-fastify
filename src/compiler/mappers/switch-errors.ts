import type { N8nNode } from '../core-parser';

export function continuesSwitchOnRegularOutput(node: N8nNode): boolean {
  const params = node.parameters;
  const rules = params?.rules?.values;
  return node.type === 'n8n-nodes-base.switch' && node.typeVersion === 3.2 &&
    node.onError === 'continueRegularOutput' && (params?.mode ?? 'rules') === 'rules' &&
    (params?.options?.allMatchingOutputs ?? false) === false &&
    Array.isArray(rules) && rules.length > 0 && rules.every(rule => {
      const group = rule?.conditions;
      const conditions = group?.conditions;
      const operator = conditions?.[0]?.operator;
      return group?.options?.typeValidation === 'strict' && group.options.version === 2 &&
        Array.isArray(conditions) && conditions.length === 1 && operator?.type === 'boolean' &&
        (operator.operation === 'true' || operator.operation === 'false');
    });
}
