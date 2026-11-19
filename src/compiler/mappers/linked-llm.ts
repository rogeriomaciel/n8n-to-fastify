import type { N8nNode, ParsedWorkflow } from '../core-parser';
import { ExpressionParser } from '../expression-parser';
import type { NodeMapperContext } from './index';
import type { ModelTransport } from '../../runtime/linked-llm';

const prefix = '@n8n/n8n-nodes-langchain.';
const chainType = prefix + 'chainLlm';
const connectionType = 'ai_languageModel';

const modelTypes = new Map<string, { transport: ModelTransport; options: Record<string, string>; defaults?: Record<string, number> }>([
  [prefix + 'lmChatGroq', {
    transport: 'chat-completions',
    options: { temperature: 'temperature', maxTokensToSample: 'max_tokens' },
    defaults: { temperature: 0.7 },
  }],
  [prefix + 'lmChatOllama', { transport: 'ollama', options: { temperature: 'temperature', topK: 'top_k', topP: 'top_p', numPredict: 'num_predict' } }],
]);
const roles = new Map([
  ['SystemMessagePromptTemplate', 'system'],
  ['HumanMessagePromptTemplate', 'user'],
  ['AIMessagePromptTemplate', 'assistant'],
]);

interface Model {
  id: string;
  transport: ModelTransport;
  model: string;
  options: Array<[string, string | number]>;
}

interface ChainModels {
  primary: Model;
  fallback?: Model;
}

function readModel(node: N8nNode): Model | undefined {
  const definition = modelTypes.get(node.type);
  const params = node.parameters ?? {};
  const options = params.options ?? {};
  if (!definition || node.typeVersion !== 1 || node.disabled || !node.id ||
      typeof params.model !== 'string' || !params.model.trim() ||
      typeof options !== 'object' || Array.isArray(options)) return;
  const entries = new Map<string, string | number>(Object.entries(definition.defaults ?? {}));
  for (const [key, value] of Object.entries(options)) {
    if (!Object.hasOwn(definition.options, key) ||
        (typeof value !== 'number' && !(typeof value === 'string' && value.startsWith('=')))) return;
    entries.set(definition.options[key], value);
  }
  return { id: node.id, transport: definition.transport, model: params.model, options: [...entries] };
}

function supportsChain(node: N8nNode): boolean {
  const params = node.parameters ?? {};
  const messages = params.messages?.messageValues ?? [];
  return node.typeVersion === 1.7 && params.promptType === 'define' &&
    typeof params.text === 'string' && !params.hasOutputParser &&
    (params.needsFallback === undefined || typeof params.needsFallback === 'boolean') &&
    Array.isArray(messages) && messages.every(message => message &&
      roles.has(message.type ?? 'SystemMessagePromptTemplate') &&
      (message.messageType ?? 'text') === 'text' && typeof message.message === 'string');
}

export function planLanguageModels(workflow: ParsedWorkflow) {
  const nodes = new Map(workflow.nodes.map(node => [node.name, node]));
  const modelSubnodes = new Set(workflow.nodes.filter(node => {
    const main = workflow.connections[node.name]?.main;
    return modelTypes.has(node.type) && !node.incomingConnections?.length &&
      (main === undefined || (Array.isArray(main) && !main.some(port => port?.length)));
  }));
  const inputs = new Map<N8nNode, Map<number, Model>>();
  const invalid = new Set<N8nNode>();
  const issues: Array<[string, string]> = [];
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    if (!outputs || !Object.hasOwn(outputs, connectionType)) continue;
    const ports = outputs[connectionType];
    if (!Array.isArray(ports)) {
      issues.push([source, 'invalid language model connection']);
      continue;
    }
    for (const [port, edges] of ports.entries()) {
      if (edges == null) continue;
      if (!Array.isArray(edges)) {
        issues.push([source, 'invalid language model connection']);
        continue;
      }
      for (const edge of edges) {
        const target = nodes.get(edge?.node);
        if (!target || target.type !== chainType) {
          issues.push([source, 'language model output must connect to a Basic LLM Chain']);
          continue;
        }
        let slots = inputs.get(target);
        if (!slots) inputs.set(target, slots = new Map());
        const modelNode = nodes.get(source);
        const model = modelNode && modelSubnodes.has(modelNode) ? readModel(modelNode) : undefined;
        if (!model || edge.type !== connectionType || port !== 0 ||
            (edge.index !== 0 && edge.index !== 1) || slots.has(edge.index)) {
          invalid.add(target);
        } else {
          slots.set(edge.index, model);
        }
      }
    }
  }
  for (const node of workflow.nodes) {
    if (node.type === chainType && !node.disabled && node.parameters?.needsFallback === true && !inputs.has(node)) {
      inputs.set(node, new Map());
    }
  }
  const chains = new Map<N8nNode, ChainModels | null>();
  for (const [chain, slots] of inputs) {
    const primary = slots.get(0);
    const fallback = slots.get(1);
    if (invalid.has(chain) || !supportsChain(chain) || !primary ||
        (chain.parameters?.needsFallback === true) !== Boolean(fallback)) {
      issues.push([chain.name, 'linked Basic LLM Chain requires v1.7 text prompts, one compatible primary model, and a fallback only when enabled']);
      chains.set(chain, null);
    } else {
      chains.set(chain, { primary, fallback });
    }
  }
  return { chains, modelSubnodes, issues };
}

export function mapLinkedLlmChain(ctx: NodeMapperContext, models: ChainModels | null): string {
  if (!models) return 'throw new Error("Unsupported linked Basic LLM Chain configuration");';
  const params = ctx.node.parameters ?? {};
  const prompt = ExpressionParser.parse(params.text, 'source[0]', 'source');
  const messages = (params.messages?.messageValues ?? []).map((message: { type?: string; message: string }) => {
    const role = roles.get(message.type ?? 'SystemMessagePromptTemplate');
    return `{ role: ${JSON.stringify(role)}, content: String(${ExpressionParser.parse(message.message, 'source[0]', 'source')} ?? '') }`;
  });
  const renderModel = ({ id, transport, model, options }: Model) => `{
      id: ${JSON.stringify(id)}, transport: ${JSON.stringify(transport)}, model: String(${ExpressionParser.parse(model, 'source[0]', 'source')} ?? ''),
      options: { ${options.map(([key, value]) => `${JSON.stringify(key)}: ${ExpressionParser.parse(value, 'source[0]', 'source')}`).join(', ')} },
    }`;
  const batchSize = ExpressionParser.parse(params.batching?.batchSize ?? 5, 'source[0]', 'source');
  const delay = ExpressionParser.parse(params.batching?.delayBetweenBatches ?? 0, 'source[0]', 'source');
  return `
    {
      const source: N8nItem[] = ${ctx.previousVariableName ?? 'inputItems'} || inputItems;
      ${ctx.variableName} = await runLinkedLlmChain(source, item => [${[...messages, `{ role: 'user', content: String(${prompt} ?? '') }`].join(', ')}], item => ({
        primary: ${renderModel(models.primary)},
        ${models.fallback ? `fallback: ${renderModel(models.fallback)},` : ''}
        batchSize: Number(${batchSize}),
        delay: Number(${delay}),
      }));
      item = ${ctx.variableName}[0] || { json: {} };
      ctx.setNodeOutputs(${JSON.stringify(ctx.node.name)}, [[0, ${ctx.variableName}]], ${ctx.variableName});
    }`;
}
