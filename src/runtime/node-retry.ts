import type { N8nItem } from './n8n-helper';

export async function runWithNodeRetry(
  run: () => Promise<N8nItem[]>,
  maxTries: number,
  delay: number,
): Promise<N8nItem[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const items = await run();
      if (attempt >= maxTries || items[0]?.json.error === undefined) return items;
    } catch (error) {
      if (attempt >= maxTries) throw error;
    }
    if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay));
  }
}

export async function settleRetryRequests(requests: Promise<N8nItem>[]): Promise<N8nItem[]> {
  const results = await Promise.allSettled(requests);
  return results.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
