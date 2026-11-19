import type { N8nItem } from './n8n-helper';

interface ExtractOptions {
  binaryProperty: string;
  destination: string;
  keepSource?: string;
}

export function extractBase64Items(items: N8nItem[], getOptions: (item: N8nItem) => ExtractOptions): N8nItem[] {
  const output: N8nItem[] = [];
  for (const [index, item] of items.entries()) {
    const options = getOptions(item);
    const { binaryProperty, keepSource } = options;
    if (!item.binary || !Object.hasOwn(item.binary, binaryProperty) || !item.binary[binaryProperty]) continue;
    const file = item.binary[binaryProperty];
    if (file.id || typeof file.data !== 'string') {
      throw new Error('Extract From File requires inline base64 binary data');
    }

    const preserveJson = keepSource === 'json' || keepSource === 'both';
    const preserveBinary = keepSource === 'binary' || keepSource === 'both';
    const json = preserveJson ? structuredClone(item.json) : {};
    const binary = preserveBinary ? item.binary : structuredClone(item.binary);
    if (!preserveBinary) delete binary[binaryProperty];

    // n8n resolves the destination only for items with a readable file.
    const { destination } = options;
    const literal = Object.hasOwn(json, destination);
    const path = literal ? [destination] : destination.split('.');
    if (path.some(part => ['__proto__', 'constructor', 'prototype'].includes(part)) ||
        (!literal && /[\[\]]/.test(destination))) {
      throw new Error('Extract From File requires a safe destination key or dot-separated path');
    }
    const value = Buffer.from(file.data, 'base64').toString('base64');
    let container = json;
    for (const [index, part] of path.slice(0, -1).entries()) {
      if (!Object.hasOwn(container, part) || !container[part] || typeof container[part] !== 'object') {
        const next = path[index + 1];
        container[part] = /^(0|[1-9]\d*)$/.test(next) && Number(next) < 2 ** 32 - 1 ? [] : {};
      }
      container = container[part];
    }
    container[path[path.length - 1]] = value;
    output.push({ json, binary, pairedItem: { item: index } });
  }
  return output;
}
