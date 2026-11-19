import { N8nNode, ParsedWorkflow } from './parser';
import { NodeMappers } from './mappers';
import { emitPollingLoop } from './polling-code';
import { getDisabledNodeMode } from './disabled-node';
import { isPositionMerge } from './mappers/position-merge';
import { collectLegacyNodePorts, usesLegacyNodeReferences } from './mappers/code-context';
import { isRawEditFields, usesRawLegacyNodeReferences } from './mappers/raw-edit-fields';
import { rabbitMqPublisherType } from './mappers/rabbitmq';
import { s3NodeType } from './mappers/s3';
import { compressionNodeType } from './mappers/compression';
import { convertToFileType } from './mappers/convert-to-file';
import { stopAndErrorType } from './mappers/stop-and-error';
import { waitNodeType } from './mappers/wait-interval';
import { usesJsonHeaders, usesMultipartBody } from './mappers/http-request';
import { rabbitMqTriggerType } from './rabbitmq-trigger';

export class CodeGenerator {
  static sanitizeIdentifier(str: string): string {
    return str
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^[0-9]/, '_$&')
      .replace(/__+/g, '_');
  }

  /**
   * Generates a standalone TypeScript module for a parsed n8n workflow.
   */
  static generateWorkflowCode(wf: ParsedWorkflow): string {
    const functionName = `workflow_${this.sanitizeIdentifier(wf.fileName)}`;
    const depth = (wf.relativePath.match(/\//g) || []).length;
    const runtimePrefix = '../'.repeat(depth + 1) + 'runtime';
    const positionMergeImport = wf.nodes.some(isPositionMerge)
      ? `import { mergeByPosition } from '${runtimePrefix}/position-merge';\n`
      : '';
    const legacyNodes = new Set(wf.nodes.filter(node =>
      usesLegacyNodeReferences(node) || usesRawLegacyNodeReferences(node)
    ));
    const rawFieldsImport = wf.nodes.some(isRawEditFields)
      ? `import { applyRawEditFields, encodeJsonTemplateValue } from '${runtimePrefix}/raw-edit-fields';\n`
      : '';
    const legacyImport = legacyNodes.size > 0
      ? `import { createLegacyNodeReferences } from '${runtimePrefix}/code-context';\n`
      : '';
    const legacyNames = legacyNodes.size > 0
      ? `const legacyNodeNames = new Set<string>(${JSON.stringify(wf.nodes.map(node => node.name))});\n`
      : '';
    const nodesByName = new Map(wf.nodes.map(node => [node.name, node]));
    const rabbitMqImport = wf.nodes.some((node) => node.type === rabbitMqPublisherType)
      ? `import { publishRabbitMq } from '${runtimePrefix}/rabbitmq';\n`
      : '';
    const s3Import = wf.nodes.some(node => node.type === s3NodeType)
      ? `import { downloadS3Files } from '${runtimePrefix}/s3';\n`
      : '';
    const compressionImport = wf.nodes.some(node => node.type === compressionNodeType)
      ? `import { decompressItems } from '${runtimePrefix}/compression';\n`
      : '';
    const jsonFileImport = wf.nodes.some(node => node.type === convertToFileType)
      ? `import { convertItemsToJsonFile } from '${runtimePrefix}/convert-to-json';\n`
      : '';
    const httpRequestImport = wf.nodes.some(node =>
      node.type.includes('httpRequest') && (usesMultipartBody(node.parameters) || usesJsonHeaders(node.parameters))
    ) ? `import { createRequestForm, parseRequestHeaders } from '${runtimePrefix}/http-request';\n` : '';
    const waitImport = wf.nodes.some(node => node.type === waitNodeType)
      ? `import { waitForInterval } from '${runtimePrefix}/wait-interval';\n`
      : '';
    const stopAndErrorImport = wf.nodes.some(node => node.type === stopAndErrorType)
      ? `import { createWorkflowStopError } from '${runtimePrefix}/stop-and-error';\n`
      : '';

    const imports = `import { WorkflowContext } from '${runtimePrefix}/workflow-context';
import { n8n, N8nItem } from '${runtimePrefix}/n8n-helper';
import { executeSubworkflow, registerWorkflow } from '${runtimePrefix}/workflow-registry';
${positionMergeImport}${legacyImport}${rawFieldsImport}${rabbitMqImport}${s3Import}${compressionImport}${jsonFileImport}${httpRequestImport}${waitImport}${stopAndErrorImport}
${legacyNames}
const DateTime = {
  now: () => ({
    toString: () => new Date().toISOString(),
    toJSDate: () => new Date()
  })
};
`;

    let declCode = '  let item: N8nItem = inputItems[0] || { json: {} };\n';
    let bodyCode = '  ctx.setNodeOutput("__initial__", inputItems);\n';

    const nodeVarMap = new Map<string, string>();
    wf.orderedNodes.forEach((node, index) => {
      const varName = `node_${index}_${this.sanitizeIdentifier(node.name)}`;
      nodeVarMap.set(node.name, varName);
    });

    const triggers = wf.triggers;
    const hasRabbitMqTrigger = triggers.some(node => node.type === rabbitMqTriggerType);
    const disabledModes = new Map(wf.orderedNodes.map(node => [node, getDisabledNodeMode(node, wf)]));
    const nonTriggers = wf.orderedNodes.filter((n) => !triggers.includes(n) && disabledModes.get(n) !== 'skip');
    const loops = wf.pollingLoops ?? [];
    const loopsByMember = new Map(loops.flatMap(loop => loop.nodes.map(name => [name, loop] as const)));
    const terminalNames = new Set(loops.flatMap(loop => loop.terminalExits.map(exit => exit.target)));
    const mapNode = (node: N8nNode, previousVariableName: string) => {
      const varName = nodeVarMap.get(node.name)!;
      return disabledModes.get(node) === 'passthrough'
        ? `
    ${varName} = ${previousVariableName} || [];
    item = ${varName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(node.name)}, ${varName});`
        : NodeMappers.mapNode({
            node,
            workflowName: wf.name,
            variableName: varName,
            previousVariableName,
            legacyNodePorts: legacyNodes.has(node) ? collectLegacyNodePorts(node, nodesByName) : undefined,
          });
    };

    triggers.forEach((node) => {
      const index = wf.orderedNodes.indexOf(node);
      const varName = nodeVarMap.get(node.name)!;
      declCode += `  let ${varName}: any = inputItems;\n`;

      const nodeName = JSON.stringify(node.name);
      let condition = `entryNode === ${nodeName}`;
      if (node.type !== rabbitMqTriggerType) {
        const rawNodePath = (node.parameters?.path || node.name).toLowerCase().trim().replace(/^\/+/, '');
        bodyCode += `  const triggerNode_${index} = item?.json?.__triggerNode;\n`;
        bodyCode += `  const triggerPath_${index} = item?.json?.__triggerPath;\n`;
        condition = `entryNode === undefined && (!triggerNode_${index} || triggerNode_${index} === ${nodeName} || triggerPath_${index} === ${JSON.stringify(rawNodePath)})`;
      }
      const nodeCode = `${varName} = inputItems;\nctx.setNodeOutput(${nodeName}, inputItems);`;
      bodyCode += this.generateNodeBlock(wf.id, node, condition, nodeCode);
    });

    nonTriggers.forEach((node) => {
      const varName = nodeVarMap.get(node.name)!;
      declCode += `  let ${varName}: any = inputItems;\n`;

      const loop = loopsByMember.get(node.name);
      if (loop) {
        if (node.name === loop.entry) {
          bodyCode += emitPollingLoop(loop, nodesByName, mapNode, (member, condition, code) =>
            this.generateNodeBlock(wf.id, member, condition, code)
          );
        }
        return;
      }
      if (terminalNames.has(node.name)) return;

      let branchCheckStr = 'true';
      const incoming = node.incomingConnections ?? [];
      const runPerIncomingBatch = incoming.length > 0 &&
        (disabledModes.get(node) === 'passthrough' || !node.type.includes('merge'));

      if (incoming.length > 0) {
        const branchChecks = incoming.map(
          (conn) => `ctx.isBranchActive(${JSON.stringify(conn.sourceNode)}, ${conn.outputIndex})`
        );
        branchCheckStr = `(${branchChecks.join(' || ')})`;
      }

      const prevExpr = runPerIncomingBatch ? 'incomingItems' : 'inputItems';
      let nodeCode = mapNode(node, prevExpr);
      if (runPerIncomingBatch) {
        const batches = incoming.map(
          conn => `ctx.getNodeOutputBatches(${JSON.stringify(conn.sourceNode)}, ${conn.outputIndex})`
        );
        // Keep the mapper body's original indentation, including multiline literals.
        nodeCode = `await ctx.runNodeBatches(${JSON.stringify(node.name)}, [${batches.join(', ')}].flat(), async (incomingItems) => {
${nodeCode.trim()}
});`;
      }

      const ancestorTriggers = node.ancestorTriggers ?? [];
      if (ancestorTriggers.length > 0) {
        const triggerConditions = ancestorTriggers
          .map((t) => `ctx.hasExecutedNode(${JSON.stringify(t)})`)
          .join(' || ');
        branchCheckStr = `(${triggerConditions}) && ${branchCheckStr}`;
      } else if (hasRabbitMqTrigger) {
        branchCheckStr = `entryNode === undefined && ${branchCheckStr}`;
      }
      bodyCode += this.generateNodeBlock(wf.id, node, branchCheckStr, nodeCode,
        ancestorTriggers.length > 0 ? '      ' : '    ');
    });

    const inactiveNodes = new Set<string>();
    for (const node of wf.orderedNodes) {
      const incoming = node.incomingConnections ?? [];
      // A branch with no reachable input cannot supply the workflow result.
      if (disabledModes.get(node) === 'skip' ||
          (incoming.length > 0 && incoming.every(connection => inactiveNodes.has(connection.sourceNode)))) {
        inactiveNodes.add(node.name);
      }
    }
    const lastNodeName = wf.orderedNodes
      .filter(node => !inactiveNodes.has(node.name) && (node.type !== stopAndErrorType || node.disabled))
      .at(-1)?.name;
    const returnItemsExpr = lastNodeName
      ? `(ctx.getNode(${JSON.stringify(lastNodeName)})?.all() || [{ json: item.json }])`
      : `inputItems`;

    const keys = Array.from(new Set([wf.id, wf.name, wf.fileName])).filter(Boolean);

    return `${imports}
export async function ${functionName}(
  inputItems: N8nItem[] = [{ json: {} }],
  parentCtx?: WorkflowContext,
  entryNode?: string
): Promise<{ items: N8nItem[]; context: WorkflowContext }> {
  const ctx = parentCtx || new WorkflowContext();
  const $env = process.env;
${declCode}
${bodyCode}
  const finalItems = ${returnItemsExpr};
  return { items: finalItems, context: ctx };
}

registerWorkflow(${JSON.stringify(keys)}, ${functionName});
`;
  }

  private static generateNodeBlock(
    workflowId: string,
    node: N8nNode,
    condition: string,
    nodeCode: string,
    nodeIndent = '    ',
  ): string {
    const traceArgs = [workflowId, node.id || node.name, node.name].map(value => JSON.stringify(value)).join(', ');
    // Keep the previous indentation because it also affects multiline JavaScript literals.
    const body = nodeIndent + nodeCode.trim().replace(/\n/g, `\n${nodeIndent}`);
    return `  if (${condition}) {
    const finishTrace = ctx.startNodeTrace(${traceArgs});
    try {
${body}
    } catch (error) {
      finishTrace?.('error');
      throw error;
    }
    finishTrace?.('completed');
  } else {
    ctx.skipNodeTrace(${traceArgs});
  }
`;
  }
}
