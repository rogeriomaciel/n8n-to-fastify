export interface N8nItem {
  json: Record<string, any>;
  binary?: Record<string, any>;
  pairedItem?: { item: number } | { item: number }[];
}

/**
 * Helper utilities mimicking core n8n data transformation patterns.
 */
export const n8n = {
  /**
   * Normalizes arbitrary return values into standard N8nItem[] arrays.
   */
  normalizeItems(data: any): N8nItem[] {
    if (!data) return [{ json: {} }];
    if (Array.isArray(data)) {
      if (data.length === 0) return [];
      return data.map(item =>
        item && typeof item === 'object' && 'json' in item
          ? (item as N8nItem)
          : { json: typeof item === 'object' && item !== null ? item : { value: item } }
      );
    }
    if (typeof data === 'object' && 'json' in data) {
      return [data as N8nItem];
    }
    return [{ json: typeof data === 'object' && data !== null ? data : { value: data } }];
  },

  /** Set a nested Edit Fields property with dot or numeric bracket notation. */
  setNestedProperty(obj: Record<string, any>, path: string, value: any): void {
    const parts = Object.hasOwn(obj, path) ? [path] : path
      .replace(/\[(0|[1-9]\d*)\](?=\.|\[|$)/g, (_, index, offset) => offset === 0 ? index : '.' + index)
      .split('.');
    if (parts.some(part => part === '__proto__' || part === 'constructor' || part === 'prototype')) return;

    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!Object.hasOwn(current, part) || !current[part] || typeof current[part] !== 'object') {
        const next = parts[i + 1];
        current[part] = /^(0|[1-9]\d*)$/.test(next) && Number(next) < 2 ** 32 - 1 ? [] : {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }
};
