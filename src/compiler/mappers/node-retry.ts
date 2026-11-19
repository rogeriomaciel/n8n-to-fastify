import type { N8nNode } from '../core-parser';

export function usesNodeRetry(node: N8nNode): boolean {
  return node.retryOnFail === true &&
    (node.type === 'n8n-nodes-base.httpRequest' || node.type === 'n8n-nodes-base.s3');
}

export function withNodeRetry(node: N8nNode, operation: string): string {
  if (!usesNodeRetry(node)) return operation;
  const maxTries = Math.min(5, Math.max(2, Math.trunc(Number(node.maxTries) || 3)));
  const configuredDelay: unknown = node.waitBetweenTries;
  const delayNumber = typeof configuredDelay === 'string' && configuredDelay.trim()
    ? Number(configuredDelay)
    : configuredDelay;
  // Zero is an explicit request to retry without waiting.
  const delay = typeof delayNumber === 'number' && Number.isFinite(delayNumber)
    ? Math.min(5000, Math.max(0, Math.trunc(delayNumber)))
    : 1000;
  return `runWithNodeRetry(() => ${operation}, ${maxTries}, ${delay})`;
}
