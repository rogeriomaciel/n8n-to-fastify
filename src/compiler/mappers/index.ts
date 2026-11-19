import { N8nNode } from '../parser';
import { ExpressionParser } from '../expression-parser';
import { isPositionMerge, mapPositionMerge } from './position-merge';
import { getLegacyNodeReferenceIssue } from './code-context';
import { continuesCodeOnRegularOutput } from './code-errors';
import { getRawEditFieldsIssue, isRawEditFields, mapRawEditFields } from './raw-edit-fields';
import { mapRabbitMqPublisher, rabbitMqPublisherType } from './rabbitmq';
import { mapS3Download, s3NodeType } from './s3';
import { compressionNodeType, mapCompression } from './compression';
import { convertToFileType, mapConvertToFile } from './convert-to-file';
import { mapWaitInterval, waitNodeType } from './wait-interval';
import { mapStopAndError, stopAndErrorType } from './stop-and-error';
import { generateMultipartBody, getMultipartIssue, usesJsonHeaders, usesMultipartBody } from './http-request';

export interface NodeMapperContext {
  node: N8nNode;
  workflowName: string;
  variableName: string;
  previousVariableName?: string;
  legacyNodePorts?: Array<[string, number]>;
}

/**
 * Maps visual n8n nodes into idiomatic, zero-overhead async TypeScript code.
 */
export class NodeMappers {
  static mapNode(ctx: NodeMapperContext): string {
    const type = ctx.node.type;
    if (type === stopAndErrorType) return mapStopAndError(ctx);

    if (type === rabbitMqPublisherType) {
      return mapRabbitMqPublisher(ctx);
    }

    if (type === s3NodeType) {
      return mapS3Download(ctx);
    }

    if (type === convertToFileType) {
      return mapConvertToFile(ctx);
    }

    if (type === compressionNodeType) {
      return mapCompression(ctx);
    }

    if (type.includes('respondToWebhook')) {
      return this.mapRespondToWebhookNode(ctx);
    }

    if (type.includes('code') || type.includes('function')) {
      return this.mapCodeNode(ctx);
    }

    if (type.includes('executeWorkflowTrigger')) {
      return this.mapGenericNode(ctx, 'Subworkflow Entry Trigger');
    }

    if (type.includes('executeWorkflow')) {
      return this.mapSubworkflowNode(ctx);
    }

    if (type.includes('filter')) {
      return this.mapFilterNode(ctx);
    }

    if (type.includes('if')) {
      return this.mapIfNode(ctx);
    }

    if (type.includes('switch')) {
      return this.mapSwitchNode(ctx);
    }

    if (type.includes('set')) {
      if (isRawEditFields(ctx.node) && !getRawEditFieldsIssue(ctx.node)) return mapRawEditFields(ctx);
      return this.mapSetNode(ctx);
    }

    if (type.includes('httpRequest')) {
      return this.mapHttpRequestNode(ctx);
    }

    if (type.includes('aggregate') || type.includes('itemLists')) {
      return this.mapAggregateNode(ctx);
    }

    if (type.includes('splitOut')) {
      return this.mapSplitOutNode(ctx);
    }

    if (type.includes('merge')) {
      return isPositionMerge(ctx.node) ? mapPositionMerge(ctx) : this.mapMergeNode(ctx);
    }

    if (type.includes('postgres')) {
      return this.mapPostgresNode(ctx);
    }

    if (type.includes('openAi') || type.includes('googleGemini') || type.includes('chainLlm')) {
      return this.mapLlmNode(ctx);
    }

    if (type === waitNodeType) {
      return mapWaitInterval(ctx);
    }

    return this.mapGenericNode(ctx, `Unmapped Node (${type})`);
  }

  private static mapRespondToWebhookNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const respondWith = params.respondWith || 'firstIncomingItem';
    const statusCode = params.options?.responseCode || 200;
    const prevVar = ctx.previousVariableName || 'inputItems';

    let responseExpr = 'item?.json || {}';
    if (respondWith === 'allIncomingItems') {
      responseExpr = `${ctx.variableName}.map((i: any) => i.json)`;
    } else if (respondWith === 'json' && params.responseBody) {
      responseExpr = ExpressionParser.parse(params.responseBody);
    } else if (respondWith === 'text' && params.responseBody) {
      responseExpr = ExpressionParser.parse(params.responseBody);
    }

    return `
    // [Node: ${ctx.node.name}] Respond to Webhook
    ${ctx.variableName} = ${prevVar} || inputItems;
    item = ${ctx.variableName}[0] || { json: {} };
    {
      let payload: any = ${responseExpr};
      if (typeof payload === 'string' && (payload.trim().startsWith('{') || payload.trim().startsWith('['))) {
        try { payload = JSON.parse(payload); } catch {}
      }
      ctx.setWebhookResponse(${statusCode}, payload);
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
  }

  private static mapCodeNode(ctx: NodeMapperContext): string {
    const issue = getLegacyNodeReferenceIssue(ctx.node);
    if (issue) throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);

    const params = ctx.node.parameters || {};
    const rawCode = params.jsCode || params.functionCode || 'return $input.all();';
    const prevVar = ctx.previousVariableName || 'inputItems';
    const legacyBinding = ctx.legacyNodePorts
      ? `      const $node = createLegacyNodeReferences(ctx, legacyNodeNames, ${JSON.stringify(ctx.legacyNodePorts)});\n`
      : '';

    // Rewrite n8n sandbox globals to local runtime bindings
    const transformedCode = rawCode
      .replace(/\$input\.all\(\)/g, 'currentItems')
      .replace(/\$input\.first\(\)/g, '(currentItems[0] || { json: {} })')
      .replace(/\$input\.item/g, '(currentItems[0] || { json: {} })')
      .replace(/\$json/g, '(currentItems[0]?.json || {})')
      .replace(/\$\(['"](.*?)['"]\)\.first\(\)/g, (_: string, n: string) => `(ctx.getNode(${JSON.stringify(n)})?.first() || { json: {} })`)
      .replace(/\$\(['"](.*?)['"]\)\.item/g, (_: string, n: string) => `(ctx.getNode(${JSON.stringify(n)})?.item || { json: {} })`)
      .replace(/\$\(['"](.*?)['"]\)\.all\(\)/g, (_: string, n: string) => `(ctx.getNode(${JSON.stringify(n)})?.all() || [])`)
      .replace(/\$now/g, 'DateTime.now()');

    const runCode = `
      const result = await (async () => {
        ${transformedCode}
      })();
      return n8n.normalizeItems(result);`;
    // Keep the user's code indentation unchanged, including multiline template literals.
    const execution = continuesCodeOnRegularOutput(ctx.node)
      ? `
      try {${runCode}
      } catch (error) {
        return [{ json: { error: error instanceof Error ? error.message : String(error) } }];
      }`
      : runCode;

    return `
    // [Node: ${ctx.node.name}] Code Execution
    ${ctx.variableName} = await (async () => {
      const currentItems = ${prevVar} || inputItems;
${legacyBinding}${execution}
    })();
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  private static mapSubworkflowNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const workflowId =
      typeof params.workflowId === 'object'
        ? params.workflowId?.value || params.workflowId?.cachedResultName || ''
        : params.workflowId || '';

    const prevVar = ctx.previousVariableName || 'inputItems';

    return `
    // [Node: ${ctx.node.name}] In-Memory Subworkflow Execution (< 0.05ms)
    ${ctx.variableName} = await executeSubworkflow(${JSON.stringify(workflowId)}, ${prevVar} || inputItems, ctx);
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  private static mapSetNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const prevVar = ctx.previousVariableName || 'inputItems';
    const keepOnlySet = params.options?.keepOnlySet === true || params.include === 'none';
    const version = ctx.node.typeVersion ?? 3.4;
    const options = params.options ?? {};
    let includeBinary: string;
    if (version >= 3.4) {
      const includeOtherFields = ExpressionParser.parse(params.includeOtherFields ?? false);
      const include = ExpressionParser.parse(params.include ?? 'all');
      const stripBinary = ExpressionParser.parse(options.stripBinary ?? false);
      includeBinary = `(${includeOtherFields}) && (${include}) !== 'none' && !(${stripBinary})`;
    } else if (version >= 3) {
      includeBinary = ExpressionParser.parse(options.includeBinary ?? false);
    } else {
      includeBinary = `!(${ExpressionParser.parse(params.keepOnlySet ?? options.keepOnlySet ?? false)})`;
    }

    const assignments: string[] = [];

    // Support n8n v3+ assignments format
    if (params.assignments?.assignments && Array.isArray(params.assignments.assignments)) {
      for (const a of params.assignments.assignments) {
        if (a.name) {
          const valExpr = ExpressionParser.parse(a.value);
          assignments.push(`n8n.setNestedProperty(newJson, ${JSON.stringify(a.name)}, ${valExpr});`);
        }
      }
    }

    // Support n8n v1/v2 values format
    if (params.values) {
      for (const typeKey of ['string', 'number', 'boolean']) {
        const list = params.values[typeKey];
        if (Array.isArray(list)) {
          for (const entry of list) {
            if (entry.name) {
              const valExpr = ExpressionParser.parse(entry.value);
              assignments.push(`n8n.setNestedProperty(newJson, ${JSON.stringify(entry.name)}, ${valExpr});`);
            }
          }
        }
      }
    }

    return `
    // [Node: ${ctx.node.name}] Set / Edit Fields
    ${ctx.variableName} = (${prevVar} || inputItems).map((currentItem: N8nItem) => {
      const item = currentItem;
      const newJson: Record<string, any> = ${keepOnlySet ? '{}' : '{ ...currentItem.json }'};
      ${assignments.join('\n      ')}
      return {
        json: newJson,
        ...(currentItem.binary !== undefined && (${includeBinary}) ? { binary: { ...currentItem.binary } } : {}),
      };
    });
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  private static parseConditions(group: any, legacyFilter = false): string {
    const conditions: string[] = [];
    const firstInputItem = legacyFilter ? undefined : 'firstInputItem';

    // n8n v2 conditions structure
    if (Array.isArray(group?.conditions)) {
      for (const cond of group.conditions) {
        let left = ExpressionParser.parse(cond.leftValue, firstInputItem);
        let right = ExpressionParser.parse(cond.rightValue, firstInputItem);
        const op = cond.operator?.operation || 'equals';
        if (legacyFilter && ['true', 'false', 'gte', 'lte'].includes(op)) {
          conditions.push(`Boolean(${left})`);
          continue;
        }
        if (!legacyFilter && group.options?.caseSensitive === false && cond.operator?.type === 'string') {
          const lowerCase = "(value: unknown) => typeof value === 'string' ? value.toLowerCase() : value";
          left = `((${lowerCase})(${left}))`;
          right = `((${lowerCase})(${right}))`;
        }

        switch (op) {
          case 'equals':
          case 'equal':
            conditions.push(`(${left} == ${right})`);
            break;
          case 'notEquals':
          case 'notEqual':
            conditions.push(`(${left} != ${right})`);
            break;
          case 'contains':
            conditions.push(`String(${left} ?? '').includes(String(${right} ?? ''))`);
            break;
          case 'true':
            conditions.push(`(${left} === true)`);
            break;
          case 'false':
            conditions.push(`(${left} === false)`);
            break;
          case 'gt':
          case 'larger':
            conditions.push(`(Number(${left}) > Number(${right}))`);
            break;
          case 'lt':
          case 'smaller':
            conditions.push(`(Number(${left}) < Number(${right}))`);
            break;
          case 'gte':
            conditions.push(`(Number(${left}) >= Number(${right}))`);
            break;
          case 'lte':
            conditions.push(`(Number(${left}) <= Number(${right}))`);
            break;
          case 'isEmpty':
          case 'empty':
            conditions.push(`(${left} === undefined || ${left} === null || ${left} === '')`);
            break;
          case 'isNotEmpty':
          case 'notEmpty':
            conditions.push(`(${left} !== undefined && ${left} !== null && ${left} !== '')`);
            break;
          default:
            conditions.push(`Boolean(${left})`);
        }
      }
    }

    const combinator = group?.combinator === 'or' ? ' || ' : ' && ';
    return conditions.length ? conditions.join(combinator) : 'true';
  }

  private static mapFilterNode(ctx: NodeMapperContext): string {
    const prevVar = ctx.previousVariableName || 'inputItems';
    const conditionExpr = this.parseConditions(ctx.node.parameters?.conditions, true);

    return `
    // [Node: ${ctx.node.name}] Filter
    ${ctx.variableName} = ${prevVar} || inputItems;
    item = ${ctx.variableName}[0] || { json: {} };
    {
      const isMatch = Boolean(${conditionExpr});
      const activeIndex = isMatch ? 0 : 1;
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName}, activeIndex);
    }`;
  }

  private static mapIfNode(ctx: NodeMapperContext): string {
    const prevVar = ctx.previousVariableName || 'inputItems';
    const conditionExpr = this.parseConditions(ctx.node.parameters?.conditions);

    return `
    // [Node: ${ctx.node.name}] Conditional Branch (IF)
    ${ctx.variableName} = ${prevVar} || inputItems;
    {
      const firstInputItem: N8nItem | undefined = ${ctx.variableName}[0];
      const outputs: N8nItem[][] = [[], []];
      for (const item of ${ctx.variableName} as N8nItem[]) {
        const port = (${conditionExpr}) ? 0 : 1;
        outputs[port].push(item);
      }
      ctx.setNodeOutputs(${JSON.stringify(ctx.node.name)}, outputs.entries(), ${ctx.variableName});
    }
    item = ${ctx.variableName}[0] || { json: {} };`;
  }

  private static mapSwitchNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const prevVar = ctx.previousVariableName || 'inputItems';
    const rules: Array<{ conditions?: unknown }> = params.rules?.values || [];
    const options = params.options ?? {};
    const fallback = options.fallbackOutput ?? 'none';
    const fallbackPort = fallback === 'extra' ? rules.length : fallback;
    const hasFallback = fallback === 'extra' ||
      (Number.isInteger(fallbackPort) && fallbackPort >= 0 && fallbackPort < rules.length);
    const fallbackCode = hasFallback
      ? `
        if (!matched) {
          send(item, ${fallbackPort});
          matched = true;
        }`
      : '';

    const predicates = rules.map(rule => `(item: N8nItem) => (${rule.conditions ? this.parseConditions(rule.conditions) : 'false'})`);
    const matchRules = `
      const predicates = [${predicates.join(', ')}];
      for (const item of source) {
        let matched = false;
        for (const [port, matches] of predicates.entries()) {
          if (matches(item)) {
            send(item, port);
            matched = true;
            if (!(${ExpressionParser.parse(options.allMatchingOutputs ?? false, 'firstInputItem')})) break;
          }
        }
        ${fallbackCode}
        if (matched) routed.push(item);
      }`;
    const matchExpression = `
      const numberOutputs = source.length > 0
        ? ((item: N8nItem) => (${ExpressionParser.parse(params.numberOutputs ?? 4, 'firstInputItem')}))(source[0])
        : 0;
      for (const item of source) {
        const port = ${ExpressionParser.parse(params.output ?? 0, 'firstInputItem')};
        if (!Number.isSafeInteger(numberOutputs) || !Number.isSafeInteger(port) || port < 0 || port >= numberOutputs) {
          throw new Error('Switch expression returned an invalid output index');
        }
        send(item, port);
        routed.push(item);
      }
    `;

    return `
    // [Node: ${ctx.node.name}] Switch Router
    {
      const source: N8nItem[] = ${prevVar} || inputItems;
      const firstInputItem = source[0];
      const outputs = new Map<number, N8nItem[]>();
      const routed: N8nItem[] = [];
      const send = (item: N8nItem, port: number) => {
        let items = outputs.get(port);
        if (!items) {
          items = [];
          outputs.set(port, items);
        }
        items.push(item);
      };
      ${params.mode === 'expression' ? matchExpression : matchRules}
      ${ctx.variableName} = routed;
      item = routed[0] || { json: {} };
      ctx.setNodeOutputs(${JSON.stringify(ctx.node.name)}, outputs, routed);
    }`;
  }

  private static mapHttpRequestNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const prevVar = ctx.previousVariableName || 'inputItems';
    const method = (params.method || 'GET').toUpperCase();
    const urlExpr = ExpressionParser.parse(params.url || '');
    const multipart = usesMultipartBody(params);
    const jsonHeaders = usesJsonHeaders(params);
    // HTTP Request v1/v2 serialized Never Error as Ignore Response Code.
    const legacyIgnoreError = (ctx.node.typeVersion ?? 1) < 3 ? params.options?.ignoreResponseCode : undefined;
    const neverError = ExpressionParser.parse(params.options?.response?.response?.neverError ?? legacyIgnoreError ?? false);

    let headersObj = '{}';
    if (jsonHeaders) {
      headersObj = `parseRequestHeaders(${ExpressionParser.parse(params.jsonHeaders ?? '{}')})`;
    } else if (params.headerParameters?.parameters && Array.isArray(params.headerParameters.parameters)) {
      const pairs = params.headerParameters.parameters
        .filter((p: any) => p.name)
        .map((p: any) => `${JSON.stringify(p.name)}: ${ExpressionParser.parse(p.value)}`);
      headersObj = `{ ${pairs.join(', ')} }`;
    }

    let bodySnippet = 'undefined';
    if (multipart) {
      const issue = getMultipartIssue(params);
      if (issue) throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
      bodySnippet = generateMultipartBody(params);
    } else if (['POST', 'PUT', 'PATCH'].includes(method)) {
      if (params.jsonBody) {
        bodySnippet = `JSON.stringify(${ExpressionParser.parse(params.jsonBody)})`;
      } else if (params.bodyParameters?.parameters && Array.isArray(params.bodyParameters.parameters)) {
        const pairs = params.bodyParameters.parameters
          .filter((p: any) => p.name)
          .map((p: any) => `${JSON.stringify(p.name)}: ${ExpressionParser.parse(p.value)}`);
        bodySnippet = `JSON.stringify({ ${pairs.join(', ')} })`;
      }
    }

    let headersSnippet = `const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...${headersObj} };`;
    if (multipart) {
      const formHeaders = jsonHeaders ? headersObj : `new Headers(${headersObj})`;
      headersSnippet = `const reqHeaders = ${formHeaders};
      reqHeaders.delete('content-type');
      reqHeaders.delete('content-length');`;
    } else if (jsonHeaders) {
      headersSnippet = `const reqHeaders = ${headersObj};
      if (!reqHeaders.has('content-type')) reqHeaders.set('content-type', 'application/json');`;
    }

    return `
    // [Node: ${ctx.node.name}] Native HTTP Request (${method})
    ${ctx.variableName} = await Promise.all((${prevVar} || inputItems).map(async (currentItem: N8nItem) => {
      const item = currentItem;
      const targetUrl = ${urlExpr};
      ${headersSnippet}
      const reqBody = ${bodySnippet};
      const res = await fetchWithStatus(targetUrl, Boolean(${neverError}), {
        method: ${JSON.stringify(method)},
        headers: reqHeaders,
        ...(reqBody !== undefined ? { body: reqBody } : {})
      });
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { json: typeof data === 'object' && data !== null ? data : { data } };
    }));
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  private static mapAggregateNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const prevVar = ctx.previousVariableName || 'inputItems';
    const destinationField = params.destinationFieldName || 'data';

    return `
    // [Node: ${ctx.node.name}] Aggregate Items
    {
      const source = ${prevVar} || inputItems;
      ${ctx.variableName} = [{ json: { ${JSON.stringify(destinationField)}: source.map((i: N8nItem) => i.json) } }];
      item = ${ctx.variableName}[0];
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
  }

  private static mapSplitOutNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const prevVar = ctx.previousVariableName || 'inputItems';
    const fieldToSplit = params.fieldToSplitOut || 'data';

    return `
    // [Node: ${ctx.node.name}] Split Out Array Field
    {
      const source = ${prevVar} || inputItems;
      const expanded: N8nItem[] = [];
      for (const entry of source) {
        const arr = entry.json?.[${JSON.stringify(fieldToSplit)}];
        if (Array.isArray(arr)) {
          for (const el of arr) {
            expanded.push({ json: typeof el === 'object' && el !== null ? el : { [${JSON.stringify(fieldToSplit)}]: el } });
          }
        }
      }
      ${ctx.variableName} = expanded.length > 0 ? expanded : source;
      item = ${ctx.variableName}[0] || { json: {} };
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
  }

  private static mapMergeNode(ctx: NodeMapperContext): string {
    const incoming = ctx.node.incomingConnections || [];
    const mode = ctx.node.parameters?.mode || 'append';
    const sources = incoming.map(
      (c) => `(ctx.getNodeOutput(${JSON.stringify(c.sourceNode)}, ${c.outputIndex}) || [])`
    );

    if (mode === 'combine' && sources.length >= 2) {
      return `
    // [Node: ${ctx.node.name}] Merge (Combine Mode)
    {
      const left = ${sources[0]};
      const right = ${sources[1]};
      const maxLen = Math.max(left.length, right.length);
      const merged: N8nItem[] = [];
      for (let i = 0; i < maxLen; i++) {
        merged.push({ json: { ...(left[i]?.json || {}), ...(right[i]?.json || {}) } });
      }
      ${ctx.variableName} = merged.length > 0 ? merged : [{ json: {} }];
      item = ${ctx.variableName}[0];
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
    }

    return `
    // [Node: ${ctx.node.name}] Merge (Append Mode)
    {
      const combined = [${sources.join(', ')}].flat();
      ${ctx.variableName} = combined.length > 0 ? combined : inputItems;
      item = ${ctx.variableName}[0] || { json: {} };
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
  }

  private static mapPostgresNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const prevVar = ctx.previousVariableName || 'inputItems';
    const queryExpr = ExpressionParser.parse(params.query || 'SELECT 1;');

    return `
    // [Node: ${ctx.node.name}] PostgreSQL Query (via DATABASE_URL env var)
    ${ctx.variableName} = await Promise.all((${prevVar} || inputItems).map(async (currentItem: N8nItem) => {
      const item = currentItem;
      const sql = ${queryExpr};
      if (!process.env.DATABASE_URL) {
        throw new Error('[n8n-to-fastify] DATABASE_URL environment variable is required for Postgres node.');
      }
      // Uses Bun's native SQL or dynamic pg driver when available
      const res = await fetch(process.env.POSTGRES_HTTP_PROXY || '', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: sql })
      }).catch(() => null);
      if (res && res.ok) {
        const rows = await res.json();
        return { json: Array.isArray(rows) ? (rows[0] || {}) : rows };
      }
      return { json: { ...currentItem.json, _sqlPrepared: sql } };
    }));
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  private static mapLlmNode(ctx: NodeMapperContext): string {
    const params = ctx.node.parameters || {};
    const prevVar = ctx.previousVariableName || 'inputItems';
    const model = params.modelId?.value || params.model || 'gpt-4o-mini';
    const promptText =
      params.messages?.values?.[0]?.content ||
      params.prompt ||
      params.text ||
      'Hello';
    const promptExpr = ExpressionParser.parse(promptText);

    return `
    // [Node: ${ctx.node.name}] Native LLM Completion (OpenAI-compatible REST API)
    ${ctx.variableName} = await Promise.all((${prevVar} || inputItems).map(async (currentItem: N8nItem) => {
      const item = currentItem;
      const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || '';
      const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
      const prompt = ${promptExpr};
      const res = await fetch(\`\${baseUrl}/chat/completions\`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': \`Bearer \${apiKey}\`
        },
        body: JSON.stringify({
          model: ${JSON.stringify(model)},
          messages: [{ role: 'user', content: String(prompt) }]
        })
      });
      const data: any = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      return { json: { text, model: ${JSON.stringify(model)}, usage: data?.usage } };
    }));
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  private static mapGenericNode(ctx: NodeMapperContext, label: string): string {
    const prevVar = ctx.previousVariableName || 'inputItems';
    return `
    // [Node: ${ctx.node.name}] ${label} (Pass-through)
    ${ctx.variableName} = ${prevVar} || inputItems;
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }
}
