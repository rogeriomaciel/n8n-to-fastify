import type { N8nNode } from '../core-parser';
import { ExpressionParser } from '../expression-parser';
import type { NodeMapperContext } from './index';
import { withNodeRetry } from './node-retry';

export const s3NodeType = 'n8n-nodes-base.s3';

export function getS3DownloadIssue(node: N8nNode): string | undefined {
  const params = node.parameters ?? {};
  if ((node.typeVersion ?? 1) !== 1 || (params.resource ?? 'file') !== 'file' ||
    (params.operation ?? 'download') !== 'download') {
    return 'S3 supports File / Download on node version 1';
  }
  if (typeof params.bucketName !== 'string' || !params.bucketName ||
    typeof params.fileKey !== 'string' || !params.fileKey) {
    return 'S3 Download requires bucketName and fileKey';
  }
}

export function mapS3Download(ctx: NodeMapperContext): string {
  const issue = getS3DownloadIssue(ctx.node);
  if (issue) throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);

  const params = ctx.node.parameters;
  const source = ctx.previousVariableName ?? 'inputItems';
  const bucket = ExpressionParser.parse(params.bucketName);
  const key = ExpressionParser.parse(params.fileKey);
  const binaryProperty = ExpressionParser.parse(params.binaryPropertyName ?? 'data');

  const download = `downloadS3Files((${source} || inputItems).map((item: N8nItem) => ({
        item,
        bucket: String(${bucket} ?? ''),
        key: String(${key} ?? ''),
        binaryProperty: String(${binaryProperty} ?? ''),
      })))`;
  return `
    {
      ${ctx.variableName} = await ${withNodeRetry(ctx.node, download)};
      item = ${ctx.variableName}[0] || { json: {} };
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
}
