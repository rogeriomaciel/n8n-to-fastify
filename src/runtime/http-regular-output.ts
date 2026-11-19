import type { N8nItem } from './n8n-helper';

type HttpErrorOutput = string | { message: string; status?: number };

class HttpItemError extends Error {
  constructor(readonly output: HttpErrorOutput) {
    super(typeof output === 'string' ? output : output.message);
  }
}

export async function fetchForRegularOutput(url: string, neverError: boolean, options: RequestInit): Promise<Response> {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || !URL.canParse(url)) {
    throw new HttpItemError('HTTP Request URL must be a valid HTTP or HTTPS URL');
  }

  let response: Response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new HttpItemError({ message: 'HTTP Request failed before receiving a response' });
  }
  if (!response.ok && !neverError) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    throw new HttpItemError({ message: 'HTTP Request failed with status ' + status, status });
  }
  return response;
}

export async function settleHttpItems(requests: Promise<N8nItem>[]): Promise<N8nItem[]> {
  const results = await Promise.allSettled(requests);
  return results.map((result, item) => {
    const pairedItem = { item };
    if (result.status === 'fulfilled') return { ...result.value, pairedItem };

    const error = result.reason instanceof HttpItemError ? result.reason.output : 'HTTP Request item failed';
    return { json: { error }, pairedItem };
  });
}
