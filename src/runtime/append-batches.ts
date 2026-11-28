import type { N8nItem } from './n8n-helper';
import type { PollingRun, WorkflowContext } from './workflow-context';

interface OrderedBatch {
  items: N8nItem[];
  order: number[];
}

interface OrderedInputs {
  inputs: N8nItem[][];
  order: number[];
}

interface Delivery extends OrderedBatch {
  input: number;
  priority: number;
}

export interface BatchEdge {
  source: string;
  output: number;
  input: number;
  priority: number;
  fallback: number;
}

function compareOrder(left: number[], right: number[]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

function compareDelivery(a: Delivery, b: Delivery): number {
  // The native stack receives a producer's edges in reverse execution order.
  return compareOrder(a.order, b.order) || b.priority - a.priority;
}

/**
 * Reconstructs v1 delivery order for Append inputs while the compiled nodes
 * evaluate in dependency order. A run's order records its depth-first path.
 * Partial runs follow complete ones, in the order their nodes began waiting.
 * This models Append deliveries without replaying the native execution stack.
 */
export class AppendBatches {
  private readonly outputOrders = new Map<string, Map<number, number[][]>>();

  constructor(private readonly ctx: WorkflowContext) {}

  private read(edge: BatchEdge): OrderedBatch[] {
    const orders = this.outputOrders.get(edge.source)?.get(edge.output);
    return this.ctx.getNodeOutputBatches(edge.source, edge.output).map((items, index) => ({
      items,
      order: orders?.[index] ?? [0, edge.fallback, index],
    }));
  }

  inputs(edges: BatchEdge[]): OrderedBatch[] {
    // Preserve the existing execution order of normal nodes. The paths let
    // Append re-order their output batches at the point of delivery.
    return edges.flatMap(edge => this.read(edge).map(batch => ({
      items: batch.items,
      order: [...batch.order, edge.priority],
    })));
  }

  private deliveries(edges: BatchEdge[]): Delivery[] {
    return edges.flatMap(edge => this.read(edge)
      .filter(batch => batch.items.length > 0)
      .map(batch => ({ ...batch, input: edge.input, priority: edge.priority })));
  }

  recordMergedOutput(node: string, edges: BatchEdge[]): void {
    // Single-run Merge mappers carry the last contributing delivery.
    let latest: Delivery | undefined;
    for (const delivery of this.deliveries(edges)) {
      if (!latest || compareDelivery(delivery, latest) > 0) latest = delivery;
    }
    const orders = new Map<number, number[][]>();
    if (latest) {
      const order = [...latest.order, latest.priority];
      for (const port of this.ctx.getActiveOutputIndexes(node)) orders.set(port, [order]);
    }
    this.outputOrders.set(node, orders);
  }

  append(edges: BatchEdge[]): OrderedBatch[] {
    return this.mergeInputs(edges).map(({ inputs, order }) => ({ items: inputs.flat(), order }));
  }

  async runMerge(
    node: string,
    edges: BatchEdge[],
    execute: (inputs: N8nItem[][]) => Promise<void>,
  ): Promise<void> {
    const runs = this.mergeInputs(edges);
    const batches = runs.map(({ inputs, order }) => ({ items: inputs.flat(), order }));
    let index = 0;
    await this.run(node, batches, () => execute(runs[index++].inputs));
  }

  private mergeInputs(edges: BatchEdge[]): OrderedInputs[] {
    const arrivals = this.deliveries(edges).sort(compareDelivery);

    if (!arrivals.length) return [];

    const inputCount = edges.reduce((count, edge) => Math.max(count, edge.input + 1), 0);
    const nextRunByInput = Array<number>(inputCount).fill(0);
    const waiting: Array<{ inputs: N8nItem[][]; received: number }> = [];
    const runs: OrderedInputs[] = [];
    let outstanding = 0;
    let waitingSince = arrivals[0];
    for (const arrival of arrivals) {
      // The nth delivery for each input fills the nth run, regardless of source.
      const runIndex = nextRunByInput[arrival.input]++;
      if (!waiting[runIndex]) {
        if (outstanding++ === 0) waitingSince = arrival;
        waiting[runIndex] = { inputs: [], received: 0 };
      }
      const pending = waiting[runIndex];
      pending.inputs[arrival.input] = arrival.items;
      if (++pending.received === inputCount) {
        outstanding--;
        runs.push({ inputs: pending.inputs, order: [...arrival.order, arrival.priority] });
      }
    }

    // A single producer can complete several runs in one dispatch. They then
    // execute last-in-first-out along with that producer's other destinations.
    runs.sort((a, b) => compareOrder(a.order, b.order));

    // Pending runs become eligible after their upstream deliveries are exhausted.
    const phase = arrivals[arrivals.length - 1].order[0] + 1;
    waiting.forEach((pending, index) => {
      if (pending.received < inputCount) {
        runs.push({
          inputs: pending.inputs,
          order: [phase, ...waitingSince.order, -1, -waitingSince.priority, index],
        });
      }
    });
    return runs;
  }

  async runPollingLoop(
    plan: PollingRun,
    entry: BatchEdge,
    retryPriority: number,
    execute: (items: N8nItem[], assertCanRetry: () => void) => Promise<void>,
  ): Promise<void> {
    const batches = this.inputs([entry]);
    const orders = new Map<number, number[][]>();
    await this.ctx.runPollingLoop(plan, batches.map(batch => batch.items), execute, (port, inputIndex, attempt) => {
      const portOrders = orders.get(port) ?? [];
      // Each retry is a descendant of the previous decision's retry edge.
      const retryPath = Array<number>(attempt - 1).fill(retryPriority);
      portOrders.push([...batches[inputIndex].order, ...retryPath]);
      orders.set(port, portOrders);
    });
    this.outputOrders.set(plan.decision, orders);
  }

  async run(node: string, batches: OrderedBatch[], execute: (items: N8nItem[]) => Promise<void>): Promise<void> {
    const orders = new Map<number, number[][]>();
    let index = 0;
    await this.ctx.runNodeBatches(node, batches.map(batch => batch.items), async items => {
      const { order } = batches[index++];
      await execute(items);
      for (const port of this.ctx.getActiveOutputIndexes(node)) {
        if (!this.ctx.getNodeOutput(node, port)?.length && batches.length > 1) continue;
        const portOrders = orders.get(port) ?? [];
        portOrders.push(order);
        orders.set(port, portOrders);
      }
    });
    this.outputOrders.set(node, orders);
  }
}
