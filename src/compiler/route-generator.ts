import { ParsedWorkflow } from './parser';
import { CodeGenerator } from './code-generator';
import { rabbitMqPublisherType } from './mappers/rabbitmq';
import { s3NodeType } from './mappers/s3';
import { compressionNodeType } from './mappers/compression';
import { convertToFileType } from './mappers/convert-to-file';
import { getRabbitMqTriggers, parseRabbitMqTrigger } from './rabbitmq-trigger';
import { getPostgresTriggers, parsePostgresTrigger } from './postgres-trigger';

export class RouteGenerator {
  /**
   * Generates Fastify route definitions and a standalone server entry point
   * for all compiled workflows and webhook triggers.
   */
  static generateRoutesCode(workflows: ParsedWorkflow[]): string {
    let imports = `import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { N8nItem } from '../runtime/n8n-helper';
import { WorkflowContext } from '../runtime/workflow-context';
`;

    const importedFunctions: string[] = [];

    workflows.forEach((wf) => {
      const functionName = `workflow_${CodeGenerator.sanitizeIdentifier(wf.fileName)}`;
      const importPath = wf.relativePath.replace(/\.ts$/, '');
      imports += `import { ${functionName} } from '../workflows/${importPath}';\n`;
      importedFunctions.push(functionName);
    });

    let routeDefinitions = '';
    const listenerStarts: string[] = [];
    const needsRabbitMq = workflows.some(workflow => getRabbitMqTriggers(workflow).length > 0);
    const needsPostgres = workflows.some(workflow => getPostgresTriggers(workflow).length > 0);
    const registeredRoutes = new Set<string>();

    workflows.forEach((wf) => {
      const functionName = `workflow_${CodeGenerator.sanitizeIdentifier(wf.fileName)}`;
      const webhooks = wf.nodes.filter((node) => node.type.includes('webhook'));

      for (const node of getRabbitMqTriggers(wf)) {
        const options = parseRabbitMqTrigger(node);
        if (typeof options === 'string') {
          throw new Error(`Workflow ${JSON.stringify(wf.name)}, node ${JSON.stringify(node.name)}: ${options}`);
        }
        const logContext = JSON.stringify({ workflowId: wf.id, node: node.name });
        listenerStarts.push(`      stopListeners.push(await startRabbitMqConsumer(
        ${JSON.stringify(options)},
        (items) => ${functionName}(items, undefined, ${JSON.stringify(node.name)}),
        (message) => fastify.log.error(${logContext}, message),
      ));`);
      }

      for (const node of getPostgresTriggers(wf)) {
        const options = parsePostgresTrigger(node);
        if (typeof options === 'string') {
          throw new Error(`Workflow ${JSON.stringify(wf.name)}, node ${JSON.stringify(node.name)}: ${options}`);
        }
        const logContext = JSON.stringify({ workflowId: wf.id, node: node.name });
        listenerStarts.push(`      stopListeners.push(await startPostgresTrigger(
        ${JSON.stringify(options)},
        (items) => ${functionName}(items, undefined, ${JSON.stringify(node.name)}),
        (message) => fastify.log.error(${logContext}, message),
      ));`);
      }

      webhooks.forEach((node) => {
        const rawPath = (node.parameters?.path || wf.fileName).toLowerCase().trim().replace(/^\/+/, '');
        const configuredMethod = (node.parameters?.httpMethod || 'POST').toUpperCase();
        const methods = configuredMethod === 'ALL' ? ['GET', 'POST', 'PUT', 'DELETE'] : [configuredMethod];

        const targetPaths = Array.from(new Set([`/${rawPath}`, `/webhook/${rawPath}`]));

        methods.forEach((httpMethod) => {
          targetPaths.forEach((routePath) => {
            const routeKey = `${httpMethod}:${routePath}`;
            if (registeredRoutes.has(routeKey)) return;
            registeredRoutes.add(routeKey);

            routeDefinitions += `
  fastify.route({
    method: '${httpMethod}',
    url: '${routePath}',
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const startTime = performance.now();
      const ctx = new WorkflowContext();
      const body = (request.body as Record<string, any>) || {};
      const query = (request.query as Record<string, any>) || {};
      const headers = (request.headers as Record<string, any>) || {};

      const inputItems: N8nItem[] = [{
        json: {
          ...query,
          ...body,
          body,
          query,
          headers,
          __triggerNode: ${JSON.stringify(node.name)},
          __triggerPath: ${JSON.stringify(rawPath)}
        }
      }];

      try {
        const { items, context } = await ${functionName}(inputItems, ctx);
        const durationMs = (performance.now() - startTime).toFixed(2);
        reply.header('X-Compiled-By', 'n8n-to-fastify');
        reply.header('X-Execution-Time', \`\${durationMs}ms\`);

        if (context.webhookResponse) {
          reply.code(context.webhookResponse.statusCode);
          return context.webhookResponse.body;
        }
        reply.code(200);
        return items.length === 1 ? items[0].json : items.map(i => i.json);
      } catch {
        const errorId = randomUUID();
        request.log.error({ errorId }, 'Workflow execution failed');
        reply.code(500);
        return { error: 'Workflow Execution Error', message: 'Workflow execution failed', errorId };
      }
    }
  });
`;
          });
        });
      });
    });

    if (needsRabbitMq) {
      imports += "import { startRabbitMqConsumer } from '../runtime/rabbitmq';\n";
    }
    if (needsPostgres) {
      imports += "import { startPostgresTrigger } from '../runtime/postgres-trigger';\n";
    }
    if (listenerStarts.length > 0) {
      routeDefinitions += `
  const stopListeners: Array<() => Promise<void>> = [];
  const closeListeners = async () => {
    await Promise.allSettled(stopListeners.splice(0).map(stop => stop()));
  };
  fastify.addHook('onReady', async () => {
    try {
${listenerStarts.join('\n')}
    } catch (error) {
      await closeListeners();
      throw error;
    }
  });
  fastify.addHook('onClose', closeListeners);
`;
    }

    return `${imports}
// Prevent bundler/runtime tree-shaking so subworkflows self-register into WorkflowRegistry
const _registeredWorkflows = [${importedFunctions.join(', ')}];
void _registeredWorkflows;

export async function registerCompiledRoutes(fastify: FastifyInstance): Promise<void> {
${routeDefinitions}
}
`;
  }

  /**
   * Generates the standalone server.ts entry point.
   */
  static generateServerEntry(workflows: ParsedWorkflow[] = []): string {
    const shutdown = workflows.some(workflow =>
      getRabbitMqTriggers(workflow).length > 0 || getPostgresTriggers(workflow).length > 0)
      ? `
  const close = () => {
    void fastify.close().catch(error => {
      fastify.log.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);`
      : '';
    return `import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerCompiledRoutes } from './routes/index';
import { workflowRegistry } from './runtime/workflow-registry';

const fastify = Fastify({
  logger: true,
});

await fastify.register(cors, { origin: '*' });
await fastify.register(registerCompiledRoutes);

fastify.get('/health', async () => {
  return {
    status: 'ok',
    engine: 'n8n-to-fastify',
    registeredWorkflows: workflowRegistry.listRegistered().length,
  };
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

try {
  await fastify.listen({ port, host });
  console.log(\`⚡ [n8n-to-fastify] Microservice online at http://\${host}:\${port}\`);${shutdown}
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
`;
  }

  /**
   * Generates package.json for the compiled standalone microservice.
   */
  static generateOutputPackageJson(
    workflows: ParsedWorkflow[] = [],
    dependencies: Record<string, string> = {}
  ): string {
    const needsRabbitMq = workflows.some((workflow) =>
      getRabbitMqTriggers(workflow).length > 0 ||
      workflow.nodes.some((node) => node.type === rabbitMqPublisherType)
    );
    const needsPostgres = workflows.some(workflow => getPostgresTriggers(workflow).length > 0);
    const needsS3 = workflows.some(workflow => workflow.nodes.some(node => node.type === s3NodeType));
    const needsCompression = workflows.some(workflow => workflow.nodes.some(node => node.type === compressionNodeType));
    const needsMimeTypes = needsS3 || needsCompression ||
      workflows.some(workflow => workflow.nodes.some(node => node.type === convertToFileType));
    return JSON.stringify(
      {
        name: 'compiled-n8n-service',
        version: '1.0.0',
        type: 'module',
        scripts: {
          start: 'bun run server.ts',
          dev: 'bun --watch run server.ts',
        },
        dependencies: {
          '@fastify/cors': '^9.0.1',
          fastify: '^4.28.1',
          ...(needsRabbitMq ? { amqplib: '^0.10.9' } : {}),
          ...(needsPostgres ? { pg: '8.16.3' } : {}),
          ...(needsS3 ? { '@aws-sdk/client-s3': '3.808.0' } : {}),
          ...(needsMimeTypes ? { 'mime-types': '^3.0.1' } : {}),
          ...(needsCompression ? { fflate: '0.8.3' } : {}),
          ...dependencies,
        },
      },
      null,
      2
    );
  }
}
