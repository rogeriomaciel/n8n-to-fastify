import type { N8nItem } from './n8n-helper';

interface BatchOrigin {
  nodeName: string;
  output: N8nItem[];
  inputRows: N8nItem[];
}

interface BatchParents {
  input: N8nItem[];
  rows: Array<number[] | undefined>;
}

function pairedIndex(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'item' in value && typeof value.item === 'number' &&
      (!('input' in value) || value.input === undefined || value.input === 0) && !('sourceOverwrite' in value)) {
    return value.item;
  }
}

export class ItemMatching {
  private readonly origins = new WeakMap<N8nItem[], BatchOrigin>();
  private readonly parents = new WeakMap<N8nItem[], Map<string, BatchParents | undefined>>();

  public select(nodeName: string, output: N8nItem[]): N8nItem[] {
    // Pairings received by a node refer to its current input batch, not the previous edge.
    const input = output.map((item, index) => ({ ...item, pairedItem: { item: index } }));
    this.origins.set(input, { nodeName, output, inputRows: input.slice() });
    return input;
  }

  public record(nodeName: string, input: N8nItem[], output: N8nItem[]): void {
    const original = this.origins.get(input)?.inputRows;
    if (!original) return;
    let runs = this.parents.get(output);
    if (!runs) {
      runs = new Map();
      this.parents.set(output, runs);
    }
    // A reused output array with two attributions cannot identify a unique run.
    if (runs.has(nodeName) && runs.get(nodeName)?.input !== input) {
      runs.set(nodeName, undefined);
      return;
    }
    const identities = new Map<N8nItem, number | undefined>();
    original.forEach((item, index) => identities.set(item, identities.has(item) ? undefined : index));
    const rows = output.map((item, index) => {
      if (item.pairedItem !== undefined) {
        const pairs = Array.isArray(item.pairedItem) ? item.pairedItem : [item.pairedItem];
        const indices = pairs.map(pairedIndex);
        if (indices.length && indices.every((row): row is number => row !== undefined)) return indices;
        return;
      }
      if (identities.has(item)) {
        const row = identities.get(item);
        return row === undefined ? undefined : [row];
      }
      if (original.length === 1) return [0];
      if (original.length === output.length) return [index];
    });
    runs.set(nodeName, { input, rows });
  }

  public resolve(nodeName: string, input: N8nItem[], index: number): N8nItem {
    const seen = new WeakMap<N8nItem[], Set<number>>();
    const pending = [{ batch: input, row: index }];
    let match: { output: N8nItem[]; row: number } | undefined;
    while (pending.length) {
      const { batch, row } = pending.pop()!;
      const origin = this.origins.get(batch);
      if (!origin || !Number.isSafeInteger(row) || row < 0 || row >= origin.output.length) {
        throw new Error('Cannot resolve a unique linked item');
      }
      let visited = seen.get(batch);
      if (!visited) seen.set(batch, visited = new Set());
      if (visited.has(row)) continue;
      visited.add(row);
      if (origin.nodeName === nodeName) {
        if (match && (match.output !== origin.output || match.row !== row)) {
          throw new Error('Cannot resolve a unique linked item');
        }
        match = { output: origin.output, row };
        continue;
      }
      const parent = this.parents.get(origin.output)?.get(origin.nodeName);
      const rows = parent?.rows[row];
      if (!parent || !rows) throw new Error('Cannot resolve a unique linked item');
      for (const previous of rows) pending.push({ batch: parent.input, row: previous });
    }
    if (match) return match.output[match.row];
    throw new Error('Cannot resolve a unique linked item');
  }
}
