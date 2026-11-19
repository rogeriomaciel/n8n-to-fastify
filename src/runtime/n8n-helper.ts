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

  coerceNumberField(value: unknown, ignoreErrors: boolean): unknown {
    if (value === null || value === undefined) return null;
    try {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) return parsed;
    } catch {
      // JSON objects can shadow conversion methods and make Number() throw.
    }
    if (ignoreErrors) return value;
    throw new Error('Edit Fields expected a number');
  },

  /**
   * Safely sets a nested property using dot notation (used by Set / Edit Fields).
   */
  setNestedProperty(obj: Record<string, any>, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current[part] || typeof current[part] !== 'object') {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = value;
  }
};
