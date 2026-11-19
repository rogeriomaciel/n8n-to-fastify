interface CodeHttpRequestOptions {
  url: string;
  method?: string;
  headers?: HeadersInit;
  body?: string | Record<string, unknown> | unknown[] | null;
  json?: boolean;
  timeout?: number;
  returnFullResponse?: boolean;
  ignoreHttpStatusErrors?: boolean;
}

export async function codeHttpRequest(options: CodeHttpRequestOptions) {
  const { url, timeout = 0, json, returnFullResponse, ignoreHttpStatusErrors } = options;
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Code HTTP requests require an HTTP or HTTPS URL');
  }
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && options.body != null) {
    if (typeof options.body === 'string') {
      body = options.body;
    } else {
      body = JSON.stringify(options.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
  }
  if (json && !headers.has('accept')) headers.set('accept', 'application/json');

  // Keep the timeout active until the response body has been read.
  const signal = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
  const response = await fetch(target, { method, headers, body, signal });
  if (!response.ok && !ignoreHttpStatusErrors) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Request failed with status code ${response.status}`), {
      status: response.status,
      response: { status: response.status },
    });
  }

  const text = await response.text();
  // n8n attempts to decode JSON and still returns plain text for non-JSON responses.
  let data: unknown = text;
  try { data = JSON.parse(text); } catch {}

  if (!returnFullResponse) return data;
  return {
    body: data,
    headers: Object.fromEntries(response.headers),
    statusCode: response.status,
    statusMessage: response.statusText,
  };
}
