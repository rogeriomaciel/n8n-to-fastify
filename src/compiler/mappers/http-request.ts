import type { N8nNode } from '../core-parser';
import { ExpressionParser } from '../expression-parser';

export function continuesHttpOnRegularOutput(node: N8nNode): boolean {
  return node.type === 'n8n-nodes-base.httpRequest' && node.onError === 'continueRegularOutput';
}

export function usesMultipartBody(params: N8nNode['parameters']): boolean {
  return params?.sendBody === true && params.contentType === 'multipart-form-data';
}

export function usesJsonHeaders(params: N8nNode['parameters']): boolean {
  return params?.sendHeaders === true && params.specifyHeaders === 'json';
}

export function getMultipartIssue(params: N8nNode['parameters']): string | undefined {
  const method = (params.method ?? 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    return 'HTTP Request multipart supports POST, PUT and PATCH';
  }
  const parts = params.bodyParameters?.parameters ?? [];
  if (!Array.isArray(parts)) return 'HTTP Request multipart needs an array of form fields';

  for (const part of parts) {
    if (typeof part?.name !== 'string' || !part.name) return 'HTTP Request multipart fields require a name';
    if (part.parameterType === 'formBinaryData') {
      if (typeof part.inputDataFieldName !== 'string' || !part.inputDataFieldName) {
        return 'HTTP Request multipart binary fields require an input binary property';
      }
    } else if (part.parameterType && !['formData', 'text'].includes(part.parameterType)) {
      return 'HTTP Request multipart supports text and binary form fields';
    }
  }
}

export function generateMultipartBody(params: N8nNode['parameters']): string {
  const parts: Array<Record<string, unknown>> = params.bodyParameters?.parameters ?? [];
  const fields = parts.map(part => {
    const name = ExpressionParser.parse(part.name);
    const valueKey = part.parameterType === 'formBinaryData' ? 'binaryProperty' : 'value';
    const value = ExpressionParser.parse(part.parameterType === 'formBinaryData' ? part.inputDataFieldName : part.value);
    return `{ name: String(${name} ?? ''), ${valueKey}: String(${value} ?? '') }`;
  });
  return `createRequestForm(item, [${fields.join(', ')}])`;
}
