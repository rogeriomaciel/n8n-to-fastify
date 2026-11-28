import { rabbitMqTriggerType } from './rabbitmq-trigger';
import { postgresTriggerType } from './postgres-trigger';
import { findPollingLoops, projectPollingSchedule, type PollingLoop } from './polling-loops';

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, any>;
  credentials?: Record<string, any>;
  disabled?: boolean;
  continueOnFail?: boolean;
  onError?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  incomingConnections?: N8nIncomingConnection[];
  ancestorTriggers?: string[];
}

export interface N8nIncomingConnection {
  sourceNode: string;
  outputIndex: number;
  inputIndex?: number;
}

export interface N8nConnectionTarget {
  node: string;
  type: string;
  index: number;
}

export interface ParsedWorkflow {
  id: string;
  name: string;
  fileName: string;
  relativePath: string;
  nodes: N8nNode[];
  connections: Record<string, any>;
  orderedNodes: N8nNode[];
  triggers: N8nNode[];
  pollingLoops?: PollingLoop[];
  executionOrder?: 'v0' | 'v1';
}

/**
 * Pure, browser-safe DAG parser and topological sorter for n8n workflows.
 */
export class CoreWorkflowParser {
  static parseWorkflow(json: any, fallbackName: string, relativePath?: string): ParsedWorkflow | null {
    if (!json || !Array.isArray(json.nodes)) {
      return null;
    }

    const id = json.id || fallbackName;
    const name = json.name || fallbackName;
    const nodes: N8nNode[] = json.nodes || [];
    const connections = json.connections || {};
    const relPath = relativePath || `${fallbackName}.json`;

    const incomingMap = new Map<string, N8nIncomingConnection[]>();
    nodes.forEach((n) => incomingMap.set(n.name, []));

    Object.entries(connections).forEach(([sourceNodeName, outputs]: [string, any]) => {
      if (outputs && Array.isArray(outputs.main)) {
        outputs.main.forEach((outputTargets: any[], outputIndex: number) => {
          if (Array.isArray(outputTargets)) {
            outputTargets.forEach((target) => {
              if (target && target.node && incomingMap.has(target.node)) {
                incomingMap.get(target.node)?.push({
                  sourceNode: sourceNodeName,
                  outputIndex,
                  inputIndex: target.index ?? 0,
                });
              }
            });
          }
        });
      }
    });

    nodes.forEach((node) => {
      node.incomingConnections = incomingMap.get(node.name) || [];
    });

    const triggers = nodes.filter(
      (node) =>
        node.type === rabbitMqTriggerType ||
        node.type === postgresTriggerType ||
        (node.type.toLowerCase().includes('webhook') && !node.type.includes('respondToWebhook')) ||
        (node.type.toLowerCase().includes('trigger') && !node.type.includes('executeWorkflowTrigger')) ||
        node.type.toLowerCase().includes('cron')
    );
    const triggerNames = new Set(triggers.map((t) => t.name));

    nodes.forEach((node) => {
      const ancestorTriggers = new Set<string>();
      const visited = new Set<string>();
      const queue = [...(incomingMap.get(node.name) || []).map((c) => c.sourceNode)];

      while (queue.length > 0) {
        const curr = queue.shift()!;
        if (visited.has(curr)) continue;
        visited.add(curr);

        if (triggerNames.has(curr)) {
          ancestorTriggers.add(curr);
        }

        const parents = incomingMap.get(curr) || [];
        parents.forEach((p) => queue.push(p.sourceNode));
      }

      node.ancestorTriggers = Array.from(ancestorTriggers);
    });

    const pollingLoops = findPollingLoops(nodes, connections);
    const schedule = pollingLoops.length ? projectPollingSchedule(nodes, connections, pollingLoops) : { nodes, connections };
    const entryGroups = new Map(pollingLoops.map(loop => [loop.entry, loop.nodes]));
    const nodeByName = new Map(nodes.map(node => [node.name, node]));
    const orderedNodes = this.topologicalSort(schedule.nodes, schedule.connections).flatMap(node =>
      entryGroups.get(node.name)?.map(name => nodeByName.get(name)!) ?? [node]
    );

    return {
      id,
      name,
      fileName: fallbackName,
      relativePath: relPath.replace(/\.json$/, '.ts'),
      nodes,
      connections,
      orderedNodes,
      triggers,
      pollingLoops,
      executionOrder: json.settings?.executionOrder,
    };
  }

  private static topologicalSort(nodes: N8nNode[], connections: Record<string, any>): N8nNode[] {
    const nodeMap = new Map<string, N8nNode>();
    const adjList = new Map<string, string[]>();

    nodes.forEach((node) => {
      nodeMap.set(node.name, node);
      adjList.set(node.name, []);
    });

    Object.entries(connections).forEach(([sourceNodeName, outputs]: [string, any]) => {
      if (outputs.main && Array.isArray(outputs.main)) {
        outputs.main.forEach((outputTargets: any[]) => {
          if (Array.isArray(outputTargets)) {
            outputTargets.forEach((target: N8nConnectionTarget) => {
              if (target && target.node && nodeMap.has(target.node)) {
                adjList.get(sourceNodeName)?.push(target.node);
              }
            });
          }
        });
      }
    });

    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: N8nNode[] = [];

    const dfs = (nodeName: string, pathStack: string[] = []) => {
      if (visited.has(nodeName)) return;
      if (visiting.has(nodeName)) {
        const cycle = [...pathStack, nodeName].join(' -> ');
        throw new Error(
          `[n8n-to-fastify] Cyclic dependency detected in workflow DAG: (${cycle}). Transpiled workflows must be strict Directed Acyclic Graphs.`
        );
      }
      visiting.add(nodeName);
      pathStack.push(nodeName);

      const neighbors = adjList.get(nodeName) || [];
      for (const neighbor of neighbors) {
        dfs(neighbor, pathStack);
      }

      pathStack.pop();
      visiting.delete(nodeName);
      visited.add(nodeName);

      const node = nodeMap.get(nodeName);
      if (node) {
        result.push(node);
      }
    };

    const inDegree = new Map<string, number>();
    nodes.forEach((n) => inDegree.set(n.name, 0));
    for (const neighbors of adjList.values()) {
      for (const neighbor of neighbors) {
        inDegree.set(neighbor, (inDegree.get(neighbor) || 0) + 1);
      }
    }

    const roots = nodes.map((n) => n.name).filter((name) => inDegree.get(name) === 0);
    for (const root of roots) {
      dfs(root);
    }

    for (const node of nodes) {
      if (!visited.has(node.name)) {
        dfs(node.name);
      }
    }

    return result.reverse();
  }
}
