import { N8nItem } from './n8n-helper';
import { WorkflowTrace } from './workflow-trace';
import type { NodeTraceSink } from './workflow-trace';

export interface NodeAccessor {
  readonly isExecuted: boolean;
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

/**
 * Runtime execution context for a single compiled workflow invocation.
 * Tracks node outputs, active conditional branches (IF/Switch), and webhook reply state.
 */
export class WorkflowContext {
  private nodeOutputs = new Map<string, N8nItem[]>();
  private outputPorts = new Map<string, Map<number, N8nItem[]>>();
  private outputBatches = new Map<string, Map<number, N8nItem[][]>>();
  private nodeRuns = new Map<string, Array<Map<number, N8nItem[]>>>();
  private batchInputs = new WeakMap<N8nItem[], N8nItem[]>();
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
    this.writeNodeOutput(nodeName, items, activeOutputIndex);
    this.recordNodeRun(nodeName, new Map([[activeOutputIndex, items]]));
  }

  private writeNodeOutput(nodeName: string, items: N8nItem[], activeOutputIndex: number): void {
    this.outputPorts.delete(nodeName);
    this.outputBatches.delete(nodeName);
    this.nodeOutputs.set(nodeName, items);
    this.executedNodes.add(nodeName);
    this.activateBranch(nodeName, activeOutputIndex);
    this.trace?.recordOutput(nodeName, activeOutputIndex, items.length);
  }

  public setNodeOutputs(nodeName: string, outputs: Iterable<[number, N8nItem[]]>, items: N8nItem[]): void {
    const ports = new Map(outputs);
    this.writeNodeOutputs(nodeName, ports, items);
    this.recordNodeRun(nodeName, ports);
  }

  private recordNodeRun(nodeName: string, outputs: Map<number, N8nItem[]>): void {
    let runs = this.nodeRuns.get(nodeName);
    if (!runs) {
      runs = [];
      this.nodeRuns.set(nodeName, runs);
    }
    // Keep one entry per execution, even when a port produces no items.
    runs.push(outputs);
  }

  private writeNodeOutputs(nodeName: string, outputs: Iterable<[number, N8nItem[]]>, items: N8nItem[]): void {
    this.activeBranches.delete(nodeName);
    this.outputBatches.delete(nodeName);
    const ports = new Map<number, N8nItem[]>();
    for (const [port, output] of outputs) {
      if (output.length > 0) {
        this.writeNodeOutput(nodeName, output, port);
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

  public getNodeRunItems(nodeName: string, outputIndex: number, runIndex: number): N8nItem[] {
    const runs = this.nodeRuns.get(nodeName);
    if (!runs) throw new Error('Referenced node has not executed');
    if (!Number.isInteger(runIndex) || runIndex < -1) throw new Error('Invalid referenced node run index');
    const run = runs.at(runIndex);
    if (!run) throw new Error('Referenced node run does not exist');
    return run.get(outputIndex) ?? [];
  }

  public getOutputForInputBatch(nodeName: string, outputIndex: number, inputBatch: N8nItem[]): N8nItem[] | undefined {
    const outputBatches = new Set(this.getNodeOutputBatches(nodeName, outputIndex));
    const visited = new Set<N8nItem[]>();
    // Each transformed batch retains its input relationship for named references.
    for (let batch: N8nItem[] | undefined = inputBatch; batch && !visited.has(batch); batch = this.batchInputs.get(batch)) {
      if (outputBatches.has(batch)) return batch;
      visited.add(batch);
    }
  }

  public async runNodeBatches(
    nodeName: string,
    batches: N8nItem[][],
    run: (items: N8nItem[]) => Promise<void>,
  ): Promise<void> {
    const runAndLinkOutputs = async (input: N8nItem[]) => {
      await run(input);
      for (const port of this.activeBranches.get(nodeName) ?? []) {
        const output = this.getNodeOutput(nodeName, port);
        if (output && output !== input && !this.batchInputs.has(output)) this.batchInputs.set(output, input);
      }
    };
    if (batches.length < 2) {
      if (batches.length === 1) await runAndLinkOutputs(batches[0]);
      return;
    }

    const byPort = new Map<number, N8nItem[][]>();
    const all: N8nItem[][] = [];
    for (const input of batches) {
      this.clearNodeOutput(nodeName);
      await runAndLinkOutputs(input);

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
    const limit = Number(process.env.N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS must be a positive integer');
    }

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

  private clearNodeOutput(nodeName: string): void {
    this.nodeOutputs.delete(nodeName);
    this.outputPorts.delete(nodeName);
    this.outputBatches.delete(nodeName);
    this.activeBranches.delete(nodeName);
  }

  private setBatchedOutputs(nodeName: string, byPort: Map<number, N8nItem[][]>, all: N8nItem[][]): void {
    // Combining batches for propagation does not execute the node again.
    this.writeNodeOutputs(nodeName, [...byPort].map(([port, runs]) => [port, runs.flat()]), all.flat());
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
      // Polling clears per-attempt outputs, but recorded runs span the invocation.
      isExecuted: this.nodeRuns.has(nodeName),
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
