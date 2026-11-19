import type { ParsedWorkflow } from './core-parser';
import { usesNodeRetry } from './mappers/node-retry';
import { getDisabledNodeMode } from './disabled-node';
import { getPositionMergeIssue, isPositionMerge } from './mappers/position-merge';
import { getLegacyNodeReferenceIssue } from './mappers/code-context';
import { continuesCodeOnRegularOutput } from './mappers/code-errors';
import { getRawEditFieldsIssue } from './mappers/raw-edit-fields';
import { getRabbitMqPublisherIssue, rabbitMqPublisherType } from './mappers/rabbitmq';
import { getS3DownloadIssue, s3NodeType } from './mappers/s3';
import { compressionNodeType, getCompressionIssue } from './mappers/compression';
import { convertToFileType, getConvertToFileIssue } from './mappers/convert-to-file';
import { getMultipartIssue, usesMultipartBody } from './mappers/http-request';
import { getWaitIntervalIssue, waitNodeType } from './mappers/wait-interval';
import { getStopAndErrorIssue, stopAndErrorType } from './mappers/stop-and-error';
import { parseRabbitMqTrigger, rabbitMqTriggerType } from './rabbitmq-trigger';

const supportedNodeTypes = new Set([
  compressionNodeType,
  convertToFileType,
  rabbitMqPublisherType,
  rabbitMqTriggerType,
  s3NodeType,
  stopAndErrorType,
  ...[
    'webhook',
    'respondToWebhook',
    'code',
    'function',
    'functionItem',
    'executeWorkflow',
    'executeWorkflowTrigger',
    'if',
    'filter',
    'switch',
    'set',
    'httpRequest',
    'aggregate',
    'itemLists',
    'splitOut',
    'merge',
    'postgres',
    'wait',
  ].map(type => `n8n-nodes-base.${type}`),
  ...['openAi', 'googleGemini', 'chainLlm'].map(type => `@n8n/n8n-nodes-langchain.${type}`),
]);

export function getCompatibilityIssues(workflow: ParsedWorkflow): string[] {
  const issues: string[] = [];
  const workflowLabel = JSON.stringify(workflow.name);
  const report = (nodeName: string, issue: string) => {
    issues.push(`Workflow ${workflowLabel}, node ${JSON.stringify(nodeName)}: ${issue}`);
  };

  for (const [source, outputs] of Object.entries(workflow.connections)) {
    for (const type of Object.keys(outputs)) {
      if (type !== 'main') {
        report(source, `connection type ${JSON.stringify(type)} is ignored`);
      }
    }
  }

  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.stickyNote') continue;
    if (node.type === rabbitMqTriggerType && node.disabled) continue;
    if (node.disabled) {
      if (!getDisabledNodeMode(node, workflow)) report(node.name, 'disabled node configuration is unsupported');
      continue;
    }
    if (!supportedNodeTypes.has(node.type)) {
      report(node.name, `unsupported node type ${JSON.stringify(node.type)}`);
      continue;
    }
    if (node.retryOnFail === true && !usesNodeRetry(node)) {
      report(node.name, 'Retry On Fail is only supported for HTTP Request and S3 Download');
    }
    if (node.continueOnFail) {
      report(node.name, 'legacy continueOnFail is ignored');
    }
    if (node.onError && node.onError !== 'stopWorkflow' && !continuesCodeOnRegularOutput(node)) {
      report(node.name, 'the configured onError behavior is ignored');
    }
    if (node.type === rabbitMqPublisherType) {
      const issue = getRabbitMqPublisherIssue(node);
      if (issue) report(node.name, issue);
    }
    if (node.type === rabbitMqTriggerType) {
      const options = parseRabbitMqTrigger(node);
      if (typeof options === 'string') report(node.name, options);
    }

    const params = node.parameters ?? {};
    const codeIssue = getLegacyNodeReferenceIssue(node);
    if (codeIssue) report(node.name, codeIssue);
    if (node.type === waitNodeType) {
      const issue = getWaitIntervalIssue(node);
      if (issue) report(node.name, issue);
    }
    if (node.type === stopAndErrorType) {
      const issue = getStopAndErrorIssue(node);
      if (issue) report(node.name, issue);
    }
    if (node.type === compressionNodeType) {
      const issue = getCompressionIssue(node);
      if (issue) report(node.name, issue);
    }
    if (node.type === convertToFileType) {
      const issue = getConvertToFileIssue(node);
      if (issue) report(node.name, issue);
    }
    if (node.type === s3NodeType) {
      const issue = getS3DownloadIssue(node);
      if (issue) report(node.name, issue);
    }
    if (node.type === 'n8n-nodes-base.httpRequest') {
      if (usesMultipartBody(params)) {
        const issue = getMultipartIssue(params);
        if (issue) report(node.name, issue);
      } else if (params.sendBody && params.contentType && params.contentType !== 'json') {
        report(node.name, 'only JSON and multipart request bodies are supported');
      }
      if (params.authentication && params.authentication !== 'none') {
        report(node.name, 'configured HTTP Request authentication is ignored');
      }
    }
    const rawIssue = getRawEditFieldsIssue(node);
    if (rawIssue) report(node.name, rawIssue);
    if (isPositionMerge(node)) {
      const issue = getPositionMergeIssue(node);
      if (issue) report(node.name, issue);
    } else if (node.type === 'n8n-nodes-base.merge' && params.mode === 'combine' &&
      (Number(params.numberInputs) > 2 || (node.incomingConnections?.length ?? 0) > 2)) {
      report(node.name, 'combine mode reads at most two inputs');
    }
  }

  return issues;
}
