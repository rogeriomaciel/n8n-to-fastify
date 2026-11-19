import type { N8nItem } from './n8n-helper';

class HttpErrorStatus extends Error {
  constructor(readonly status: number) {
    super(`HTTP Request failed with status ${status}`);
  }
}

export async function fetchForErrorOutput(url: string, neverError: boolean, options: RequestInit): Promise<Response> {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || !URL.canParse(url)) {
    throw new Error('HTTP Request URL must be a valid HTTP or HTTPS URL');
  }
  const response = await fetch(url, options);
  if (!response.ok && !neverError) {
    await response.body?.cancel().catch(() => {});
    throw new HttpErrorStatus(response.status);
  }
  return response;
}

export async function settleHttpErrorItems(requests: Promise<N8nItem>[]): Promise<N8nItem[]> {
  const results = await Promise.allSettled(requests);
  return results.map((result, item) => {
    const pairedItem = { item };
    if (result.status === 'fulfilled') return { ...result.value, pairedItem };
    const error = result.reason instanceof HttpErrorStatus
      ? { message: result.reason.message, status: result.reason.status }
      : 'HTTP Request item failed';
    return { json: { error }, pairedItem };
  });
}

export function partitionHttpErrorItems(items: N8nItem[], inputs: N8nItem[]): [N8nItem[], N8nItem[]] {
  const success: N8nItem[] = [];
  const failure: N8nItem[] = [];
  for (const [index, item] of items.entries()) {
    const keys = Object.keys(item.json).length;
    // n8n also routes response bodies containing only error or error and message.
    if (item.json.error && (keys === 1 || (keys === 2 && item.json.message))) {
      const { json } = inputs[index];
      failure.push({ ...item, json: { ...json, ...item.json } });
    } else {
      success.push(item);
    }
  }
  return [success, failure];
}
