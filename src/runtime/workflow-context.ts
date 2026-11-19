import { N8nItem } from './n8n-helper';
import { WorkflowTrace } from './workflow-trace';
import type { NodeTraceSink } from './workflow-trace';

export interface NodeAccessor {
  item?: N8nItem;
  first: () => N8nItem | undefined;
  all: () => N8nItem[];
}

interface PollingRun {
  nodes: string[];
  decision: string;
  backEdge: { source: string; output: number };
  exitPorts: number[];
}

export interface PollingDispatchPlan {
  entry: string;
  routes: Array<[string, { output: number; target: string }[]]>;
  boundaryRoutes: PollingDispatchPlan['routes'];
}

function pollingAttemptLimit(): number {
  const limit = Number(process.env.N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS must be a positive integer');
  }
  return limit;
}

/**
 * Runtime execution context for a single compiled workflow invocation.
 * Tracks node outputs, active conditional branches (IF/Switch), and webhook reply state.
 */
export class WorkflowContext {
  private nodeOutputs = new Map<string, N8nItem[]>();
  private outputPorts = new Map<string, Map<number, N8nItem[]>>();
  private outputBatches = new Map<string, Map<number, N8nItem[][]>>();
  private pollingExitBatches = new Map<string, Map<string, N8nItem[][]>>();
  private activeBranches = new Map<string, Set<number>>();
  private executedNodes = new Set<string>();
  private readonly trace?: WorkflowTrace;
  public webhookResponse?: { statusCode: number; body: any; headers?: Record<string, string> };

  constructor(traceSink?: NodeTraceSink) {
    if (!traceSink && process.env.N8N_TO_FASTIFY_TRACE === '1') {
      traceSink = event => console.info(JSON.stringify(event));
    }
    if (traceSink) this.trace = new WorkflowTrace(traceSink);
  }

  public startNodeTrace(workflowId: string, nodeId: string, nodeName: string) {
    return this.trace?.startNode({ workflowId, nodeId, nodeName });
  }

  public skipNodeTrace(workflowId: string, nodeId: string, nodeName: string): void {
    this.trace?.skipNode({ workflowId, nodeId, nodeName });
  }

  public setNodeOutput(nodeName: string, items: N8nItem[], activeOutputIndex: number = 0): void {
    this.outputPorts.delete(nodeName);
    this.outputBatches.delete(nodeName);
    this.nodeOutputs.set(nodeName, items);
    this.executedNodes.add(nodeName);
    this.activateBranch(nodeName, activeOutputIndex);
    this.trace?.recordOutput(nodeName, activeOutputIndex, items.length);
  }

  public setNodeOutputs(nodeName: string, outputs: Iterable<[number, N8nItem[]]>, items: N8nItem[]): void {
    this.activeBranches.delete(nodeName);
    this.outputBatches.delete(nodeName);
    const ports = new Map<number, N8nItem[]>();
    for (const [port, output] of outputs) {
      if (output.length > 0) {
        this.setNodeOutput(nodeName, output, port);
        ports.set(port, output);
      }
    }
    this.outputPorts.set(nodeName, ports);
    this.nodeOutputs.set(nodeName, items);
    this.executedNodes.add(nodeName);
  }

  public getNodeOutput(nodeName: string, outputIndex: number): N8nItem[] | undefined {
    if (!this.isBranchActive(nodeName, outputIndex)) return;
    const ports = this.outputPorts.get(nodeName);
    return ports ? ports.get(outputIndex) : this.nodeOutputs.get(nodeName);
  }

  public getNodeOutputBatches(nodeName: string, outputIndex: number): N8nItem[][] {
    const batches = this.outputBatches.get(nodeName)?.get(outputIndex);
    if (batches) return batches;
    const items = this.getNodeOutput(nodeName, outputIndex);
    return items === undefined ? [] : [items];
  }

  public async runNodeBatches(
    nodeName: string,
    batches: N8nItem[][],
    run: (items: N8nItem[]) => Promise<void>,
  ): Promise<void> {
    if (batches.length < 2) {
      if (batches.length === 1) await run(batches[0]);
      return;
    }

    const byPort = new Map<number, N8nItem[][]>();
    const all: N8nItem[][] = [];
    for (const input of batches) {
      this.clearNodeOutput(nodeName);
      await run(input);

      const items = this.nodeOutputs.get(nodeName);
      if (items?.length) all.push(items);
      for (const port of this.activeBranches.get(nodeName) ?? []) {
        const output = this.getNodeOutput(nodeName, port);
        if (!output?.length) continue;
        let portBatches = byPort.get(port);
        if (!portBatches) {
          portBatches = [];
          byPort.set(port, portBatches);
        }
        portBatches.push(output);
      }
    }
    this.setBatchedOutputs(nodeName, byPort, all);
  }

  public async runPollingLoop(
    plan: PollingRun,
    initialBatches: N8nItem[][],
    runAttempt: (items: N8nItem[], assertCanRetry: () => void) => Promise<void>,
  ): Promise<void> {
    if (!initialBatches.some(batch => batch.length)) return;
    const limit = pollingAttemptLimit();

    const exits = new Map<number, N8nItem[][]>();
    const completed: N8nItem[][] = [];
    for (const initial of initialBatches) {
      let pending = initial;
      let attempt = 0;
      const assertCanRetry = () => {
        if (attempt >= limit) throw new Error(`Polling loop exceeded its limit of ${limit} attempts`);
      };
      while (pending.length > 0) {
        assertCanRetry();
        attempt++;
        for (const nodeName of plan.nodes) {
          this.clearNodeOutput(nodeName);
          this.executedNodes.delete(nodeName);
        }
        await runAttempt(pending, assertCanRetry);
        for (const port of plan.exitPorts) {
          const items = this.getNodeOutput(plan.decision, port);
          if (!items?.length) continue;
          if (!exits.has(port)) exits.set(port, []);
          exits.get(port)!.push(items);
          completed.push(items);
        }
        pending = this.getNodeOutput(plan.backEdge.source, plan.backEdge.output) ?? [];
      }
    }
    this.setBatchedOutputs(plan.decision, exits, completed);
  }

  public async runMultiReturnPollingLoop(
    plan: PollingDispatchPlan,
    initialBatches: N8nItem[][],
    steps: Array<[string, (items: N8nItem[]) => Promise<void>]>,
  ): Promise<void> {
    const byTarget = new Map<string, N8nItem[][]>();
    this.pollingExitBatches.set(plan.entry, byTarget);
    for (const [name] of steps) {
      this.clearNodeOutput(name);
      this.executedNodes.delete(name);
    }
    if (!initialBatches.some(batch => batch.length)) return;
    const limit = pollingAttemptLimit();
    const handlers = new Map(steps);
    const routes = new Map(plan.routes);
    const boundaryRoutes = new Map(plan.boundaryRoutes);
    const exits = new Map<string, Map<number, N8nItem[][]>>();

    for (const initial of initialBatches) {
      if (!initial.length) continue;
      let attempts = 0;
      const pending = [{ name: plan.entry, items: initial }];
      while (pending.length) {
        const { name, items } = pending.pop()!;
        if (name === plan.entry) {
          if (attempts >= limit) throw new Error(`Polling loop exceeded its limit of ${limit} attempts`);
          attempts++;
        }
        this.clearNodeOutput(name);
        await this.runNodeBatches(name, [items], handlers.get(name)!);

        const recordedPorts = new Set<number>();
        for (const { output: port, target } of boundaryRoutes.get(name) ?? []) {
          const output = this.getNodeOutput(name, port);
          if (!output?.length) continue;
          if (!byTarget.has(target)) byTarget.set(target, []);
          byTarget.get(target)!.push(output);
          if (recordedPorts.has(port)) continue;
          recordedPorts.add(port);
          if (!exits.has(name)) exits.set(name, new Map());
          const batches = exits.get(name)!;
          if (!batches.has(port)) batches.set(port, []);
          batches.get(port)!.push(output);
        }
        // Use a stack to complete a higher canvas branch before starting its sibling.
        const next = routes.get(name) ?? [];
        for (let index = next.length - 1; index >= 0; index--) {
          const { output, target } = next[index];
          const batch = this.getNodeOutput(name, output);
          if (batch?.length) pending.push({ name: target, items: batch });
        }
      }
    }
    for (const [name, batches] of exits) {
      this.setBatchedOutputs(name, batches, [...batches.values()].flat());
    }
  }

  public getPollingExitBatches(entry: string, target: string): N8nItem[][] {
    return this.pollingExitBatches.get(entry)?.get(target) ?? [];
  }

  private clearNodeOutput(nodeName: string): void {
    this.nodeOutputs.delete(nodeName);
    this.outputPorts.delete(nodeName);
    this.outputBatches.delete(nodeName);
    this.activeBranches.delete(nodeName);
  }

  private setBatchedOutputs(nodeName: string, byPort: Map<number, N8nItem[][]>, all: N8nItem[][]): void {
    this.setNodeOutputs(nodeName, [...byPort].map(([port, runs]) => [port, runs.flat()]), all.flat());
    this.outputBatches.set(nodeName, byPort);
  }

  public activateBranch(nodeName: string, outputIndex: number): void {
    if (!this.activeBranches.has(nodeName)) {
      this.activeBranches.set(nodeName, new Set());
    }
    this.activeBranches.get(nodeName)!.add(outputIndex);
  }

  public isBranchActive(nodeName: string, outputIndex: number): boolean {
    return this.activeBranches.get(nodeName)?.has(outputIndex) ?? false;
  }

  public hasExecutedNode(nodeName: string): boolean {
    return this.executedNodes.has(nodeName);
  }

  public getNode(nodeName: string): NodeAccessor {
    const items = this.nodeOutputs.get(nodeName) || [];
    return {
      item: items[0],
      first: () => items[0],
      all: () => items,
    };
  }

  public setWebhookResponse(statusCode: number, body: any, headers?: Record<string, string>): void {
    if (!this.webhookResponse) {
      this.webhookResponse = { statusCode, body, headers };
    }
  }
}
