import type { N8nItem } from './n8n-helper';

export interface CommunityNodeExecution {
  node: { id: string; name: string; type: string; typeVersion: number; retryOnFail: boolean; maxTries?: number; waitBetweenTries?: number };
  items: N8nItem[];
  parameters(index?: number): Record<string, unknown>;
}

type Execute = (context: CommunityNodeExecution) => N8nItem[] | Promise<N8nItem[]>;

export async function executeCommunityAdapter(execute: Execute, context: CommunityNodeExecution): Promise<N8nItem[]> {
  const items = await execute(context);
  if (!Array.isArray(items) || items.some(item => !item || !item.json || typeof item.json !== 'object')) {
    throw new Error('Community adapter must return an array of n8n items');
  }
  return items;
}
