(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };

  // src/browser.ts
  var exports_browser = {};
  __export(exports_browser, {
    compileWorkflowJson: () => compileWorkflowJson
  });

  // src/compiler/rabbitmq-trigger.ts
  var rabbitMqTriggerType = "n8n-nodes-base.rabbitmqTrigger";
  function getRabbitMqTriggers(workflow) {
    return workflow.nodes.filter((node) => node.type === rabbitMqTriggerType && !node.disabled);
  }
  function isStaticString(value) {
    return typeof value === "string" && !value.startsWith("=") && !value.includes("{{");
  }
  function parseRabbitMqTrigger(node) {
    if ((node.typeVersion ?? 1) !== 1)
      return "RabbitMQ Trigger needs typeVersion 1";
    const { queue, options: rawOptions } = node.parameters ?? {};
    const options = rawOptions ?? {};
    if (!isStaticString(queue) || !queue.trim())
      return "RabbitMQ Trigger needs a static queue name";
    if (typeof options !== "object" || Array.isArray(options)) {
      return "RabbitMQ Trigger needs static options";
    }
    if (options.acknowledge !== "executionFinishesSuccessfully") {
      return "RabbitMQ Trigger needs the executionFinishesSuccessfully acknowledgement mode";
    }
    if (options.contentIsBinary || options.onlyContent) {
      return "RabbitMQ Trigger supports text or parsed JSON in the message envelope";
    }
    const prefetch = options.parallelMessages ?? -1;
    if (!Number.isInteger(prefetch) || prefetch !== -1 && (prefetch < 1 || prefetch > 65535)) {
      return "RabbitMQ Trigger needs parallelMessages between 1 and 65535, or -1";
    }
    const bindings = options.binding?.bindings ?? [];
    if (!Array.isArray(bindings) || !bindings.every((binding) => isStaticString(binding?.exchange) && binding.exchange.length > 0 && isStaticString(binding?.routingKey))) {
      return "RabbitMQ Trigger needs static exchange names and routing keys in its bindings";
    }
    for (const key of ["assertQueue", "durable", "autoDelete", "exclusive", "jsonParseBody"]) {
      if (options[key] !== undefined && typeof options[key] !== "boolean") {
        return "RabbitMQ Trigger needs static boolean queue and message settings";
      }
    }
    if (options.assertQueue && Object.keys(options.arguments ?? {}).length > 0) {
      return "RabbitMQ Trigger queue declaration does not support custom arguments";
    }
    return {
      queue,
      bindings: bindings.map(({ exchange, routingKey }) => ({ exchange, routingKey })),
      prefetch: prefetch === -1 ? undefined : prefetch,
      parseJson: options.jsonParseBody === true,
      declareQueue: options.assertQueue ? {
        durable: options.durable,
        autoDelete: options.autoDelete,
        exclusive: options.exclusive
      } : undefined
    };
  }

  // src/compiler/polling-loops.ts
  var waitType = "n8n-nodes-base.wait";
  var allowedTypes = new Set(["if", "switch", "wait", "httpRequest", "code", "set"].map((type) => "n8n-nodes-base." + type));
  function readMainEdges(nodes, connections) {
    const edges = [];
    for (const [source, outputs] of Object.entries(connections)) {
      if (!nodes.has(source) || !Array.isArray(outputs?.main))
        continue;
      outputs.main.forEach((targets, output) => {
        if (!Array.isArray(targets))
          return;
        for (const target of targets) {
          if (target && nodes.has(target.node)) {
            edges.push({ source, output, target: target.node, input: target.index ?? 0 });
          }
        }
      });
    }
    return edges;
  }
  function cyclicComponents(nodes, outgoing) {
    const indices = new Map;
    const low = new Map;
    const stack = [];
    const onStack = new Set;
    const result = [];
    function visit(node) {
      const index = indices.size;
      indices.set(node, index);
      low.set(node, index);
      stack.push(node);
      onStack.add(node);
      for (const { target } of outgoing.get(node) ?? []) {
        if (!indices.has(target)) {
          visit(target);
          low.set(node, Math.min(low.get(node), low.get(target)));
        } else if (onStack.has(target)) {
          low.set(node, Math.min(low.get(node), indices.get(target)));
        }
      }
      if (low.get(node) !== index)
        return;
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1 || outgoing.get(node)?.some((edge) => edge.target === node)) {
        result.push(component);
      }
    }
    for (const node of nodes) {
      if (!indices.has(node))
        visit(node);
    }
    return result;
  }
  function findPollingLoops(nodes, connections) {
    const byName = new Map(nodes.map((node) => [node.name, node]));
    const edges = readMainEdges(byName, connections);
    const outgoing = new Map;
    const incoming = new Map;
    for (const edge of edges) {
      if (!outgoing.has(edge.source))
        outgoing.set(edge.source, []);
      if (!incoming.has(edge.target))
        incoming.set(edge.target, []);
      outgoing.get(edge.source).push(edge);
      incoming.get(edge.target).push(edge);
    }
    return cyclicComponents(byName.keys(), outgoing).map((component) => {
      const loop = planLoop(component, byName, outgoing, incoming);
      if (!loop) {
        throw new Error("[n8n-to-fastify] Cyclic dependency detected. Only single-entry polling loops " + "with a timed Wait and one IF or Switch retry output are supported. Nodes: " + component.slice().sort().map((node) => JSON.stringify(node)).join(", "));
      }
      return loop;
    });
  }
  function projectPollingSchedule(nodes, connections, loops) {
    const entries = new Map(loops.flatMap((loop) => loop.nodes.map((node) => [node, loop.entry])));
    const projected = Object.create(null);
    for (const edge of readMainEdges(new Map(nodes.map((node) => [node.name, node])), connections)) {
      const source = entries.get(edge.source) ?? edge.source;
      const target = entries.get(edge.target) ?? edge.target;
      if (source === target)
        continue;
      const { main } = projected[source] ??= { main: [[]] };
      main[0].push({ node: target, type: "main", index: 0 });
    }
    return { nodes: nodes.filter((node) => (entries.get(node.name) ?? node.name) === node.name), connections: projected };
  }
  function planLoop(component, nodes, outgoing, incoming) {
    const members = new Set(component);
    const definitions = component.map((name) => nodes.get(name));
    if (definitions.some((node) => !allowedTypes.has(node.type) || node.disabled))
      return;
    const decisions = definitions.filter((node) => node.type === "n8n-nodes-base.if" || node.type === "n8n-nodes-base.switch");
    const waits = definitions.filter((node) => node.type === waitType);
    if (decisions.length !== 1 || waits.length !== 1 || (waits[0].parameters?.resume ?? "timeInterval") !== "timeInterval")
      return;
    if (decisions[0].parameters?.options?.allMatchingOutputs)
      return;
    const decision = decisions[0].name;
    const entries = component.flatMap((node) => (incoming.get(node) ?? []).filter((edge) => !members.has(edge.source)));
    if (entries.length !== 1 || entries[0].input !== 0)
      return;
    const entry = entries[0].target;
    const order = [entry];
    const exits = [];
    let backEdge;
    let repeatPort;
    for (let index = 0;index < component.length; index++) {
      const node = order[index];
      const all = outgoing.get(node) ?? [];
      const next = all.filter((edge) => members.has(edge.target));
      if (next.length !== 1 || next[0].input !== 0 || node !== decision && next[0].output !== 0)
        return;
      const external = all.filter((edge) => !members.has(edge.target));
      if (external.length > 0 && (node !== decision || external.some((edge) => edge.output === next[0].output)))
        return;
      exits.push(...external);
      if (node === decision)
        repeatPort = next[0].output;
      if (next[0].target === entry) {
        if (index !== component.length - 1)
          return;
        backEdge = next[0];
      } else {
        order.push(next[0].target);
      }
    }
    if (!backEdge || repeatPort === undefined || exits.length === 0)
      return;
    const terminalExits = [];
    const exitPorts = new Set;
    for (const edge of exits) {
      const target = nodes.get(edge.target);
      if (target.type === "n8n-nodes-base.stopAndError" && !target.disabled) {
        if (edge.input !== 0 || incoming.get(edge.target)?.length !== 1 || outgoing.get(edge.target)?.length)
          return;
        terminalExits.push({ output: edge.output, target: edge.target });
      }
      exitPorts.add(edge.output);
    }
    return {
      entry,
      nodes: order,
      decision,
      repeatPort,
      backEdge: { source: backEdge.source, output: backEdge.output },
      exitPorts: [...exitPorts].sort((a, b) => a - b),
      terminalExits
    };
  }

  // src/compiler/core-parser.ts
  class CoreWorkflowParser {
    static parseWorkflow(json, fallbackName, relativePath) {
      if (!json || !Array.isArray(json.nodes)) {
        return null;
      }
      const id = json.id || fallbackName;
      const name = json.name || fallbackName;
      const nodes = json.nodes || [];
      const connections = json.connections || {};
      const relPath = relativePath || `${fallbackName}.json`;
      const incomingMap = new Map;
      nodes.forEach((n) => incomingMap.set(n.name, []));
      Object.entries(connections).forEach(([sourceNodeName, outputs]) => {
        if (outputs && Array.isArray(outputs.main)) {
          outputs.main.forEach((outputTargets, outputIndex) => {
            if (Array.isArray(outputTargets)) {
              outputTargets.forEach((target) => {
                if (target && target.node && incomingMap.has(target.node)) {
                  incomingMap.get(target.node)?.push({
                    sourceNode: sourceNodeName,
                    outputIndex,
                    inputIndex: target.index ?? 0
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
      const triggers = nodes.filter((node) => node.type === rabbitMqTriggerType || node.type.includes("webhook") || node.type.includes("trigger") || node.type.includes("cron"));
      const triggerNames = new Set(triggers.map((t) => t.name));
      nodes.forEach((node) => {
        const ancestorTriggers = new Set;
        const visited = new Set;
        const queue = [...(incomingMap.get(node.name) || []).map((c) => c.sourceNode)];
        while (queue.length > 0) {
          const curr = queue.shift();
          if (visited.has(curr))
            continue;
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
      const entryGroups = new Map(pollingLoops.map((loop) => [loop.entry, loop.nodes]));
      const nodeByName = new Map(nodes.map((node) => [node.name, node]));
      const orderedNodes = this.topologicalSort(schedule.nodes, schedule.connections).flatMap((node) => entryGroups.get(node.name)?.map((name) => nodeByName.get(name)) ?? [node]);
      return {
        id,
        name,
        fileName: fallbackName,
        relativePath: relPath.replace(/\.json$/, ".ts"),
        nodes,
        connections,
        orderedNodes,
        triggers,
        pollingLoops
      };
    }
    static topologicalSort(nodes, connections) {
      const nodeMap = new Map;
      const adjList = new Map;
      nodes.forEach((node) => {
        nodeMap.set(node.name, node);
        adjList.set(node.name, []);
      });
      Object.entries(connections).forEach(([sourceNodeName, outputs]) => {
        if (outputs.main && Array.isArray(outputs.main)) {
          outputs.main.forEach((outputTargets) => {
            if (Array.isArray(outputTargets)) {
              outputTargets.forEach((target) => {
                if (target && target.node && nodeMap.has(target.node)) {
                  adjList.get(sourceNodeName)?.push(target.node);
                }
              });
            }
          });
        }
      });
      const visited = new Set;
      const visiting = new Set;
      const result = [];
      const dfs = (nodeName, pathStack = []) => {
        if (visited.has(nodeName))
          return;
        if (visiting.has(nodeName)) {
          const cycle = [...pathStack, nodeName].join(" -> ");
          throw new Error(`[n8n-to-fastify] Cyclic dependency detected in workflow DAG: (${cycle}). Transpiled workflows must be strict Directed Acyclic Graphs.`);
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
      const inDegree = new Map;
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

  // src/compiler/expression-parser.ts
  class ExpressionParser {
    static parse(expression, firstInputItem, inputItems = "inputItems") {
      if (expression === undefined || expression === null) {
        return JSON.stringify("");
      }
      if (typeof expression !== "string") {
        return JSON.stringify(expression);
      }
      let expr = expression.trim();
      if (!expr.includes("{{")) {
        return JSON.stringify(expression);
      }
      if (expr.startsWith("=")) {
        const innerContent = expr.substring(1).trim();
        if (innerContent.startsWith("{{") && innerContent.endsWith("}}")) {
          const between = innerContent.substring(2, innerContent.length - 2).trim();
          if (!between.includes("{{") && !between.includes("}}")) {
            const transformed = this.transformTokens(between, firstInputItem, inputItems);
            return `(${transformed})`;
          }
        }
        expr = expr.substring(1).trim();
      }
      const replacements = [];
      let placeholderIdx = 0;
      const tokenized = expr.replace(/\{\{(.*?)\}\}/g, (_, inner) => {
        const transformed = this.transformTokens(inner.trim(), firstInputItem, inputItems);
        const placeholder = `__EXPR_PLACEHOLDER_${placeholderIdx++}__`;
        replacements.push(`\${(${transformed}) ?? ''}`);
        return placeholder;
      });
      let safeLiteral = tokenized.replace(/`/g, "\\`").replace(/\${/g, "\\${");
      replacements.forEach((rep, idx) => {
        safeLiteral = safeLiteral.replace(`__EXPR_PLACEHOLDER_${idx}__`, rep);
      });
      return `\`${safeLiteral}\``;
    }
    static transformTokens(code, firstInputItem, inputItems) {
      let result = code;
      result = result.replace(/\$now\b/g, "new Date().toISOString()");
      result = result.replace(/\$today\b/g, 'new Date().toISOString().split("T")[0]');
      result = result.replace(/\$\(['"](.*?)['"]\)\.item\.json([a-zA-Z0-9_.]*)/g, (_, nodeName, path) => {
        const parts = path ? path.split(".").filter(Boolean) : [];
        return `(ctx.getNode(${JSON.stringify(nodeName)})?.item?.json${parts.length ? "?." + parts.join("?.") : ""})`;
      });
      result = result.replace(/\$\(['"](.*?)['"]\)\.first\(\)\.json([a-zA-Z0-9_.]*)/g, (_, nodeName, path) => {
        const parts = path ? path.split(".").filter(Boolean) : [];
        return `(ctx.getNode(${JSON.stringify(nodeName)})?.first()?.json${parts.length ? "?." + parts.join("?.") : ""})`;
      });
      result = result.replace(/\$\(['"](.*?)['"]\)/g, (_, nodeName) => {
        return `ctx.getNode(${JSON.stringify(nodeName)})`;
      });
      result = result.replace(/\$node\(['"](.*?)['"]\)/g, (_, nodeName) => {
        return `ctx.getNode(${JSON.stringify(nodeName)})`;
      });
      result = result.replace(/\$json([a-zA-Z0-9_.]*)/g, (_, path) => {
        if (!path)
          return "item?.json";
        const parts = path.split(".").filter(Boolean);
        return `item?.json?.${parts.join("?.")}`;
      });
      result = result.replace(/\$input\.first\(\)\.json/g, `${firstInputItem ?? "item"}?.json`);
      if (firstInputItem)
        result = result.replace(/\$input\.first\(\)/g, firstInputItem);
      result = result.replace(/\$input\.item\.json/g, "item?.json");
      result = result.replace(/\$input\.all\(\)/g, inputItems);
      result = result.replace(/\$env\.([a-zA-Z0-9_]+)/g, (_, envVar) => {
        return `process.env.${envVar}`;
      });
      return result;
    }
  }

  // src/compiler/mappers/position-merge.ts
  function isPositionMerge(node) {
    return node.type === "n8n-nodes-base.merge" && node.parameters?.mode === "combine" && node.parameters?.combineBy === "combineByPosition";
  }
  function getPositionMergeIssue(node) {
    const portCount = node.parameters.numberInputs ?? 2;
    if (!Number.isInteger(portCount) || portCount < 2 || portCount > 10) {
      return "position Merge requires 2 to 10 input ports";
    }
    for (const { inputIndex = 0 } of node.incomingConnections ?? []) {
      if (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= portCount) {
        return "position Merge has an invalid input port";
      }
    }
  }
  function mapPositionMerge(ctx) {
    const issue = getPositionMergeIssue(ctx.node);
    if (issue)
      throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
    const params = ctx.node.parameters;
    const portCount = params.numberInputs ?? 2;
    const sources = Array.from({ length: portCount }, () => []);
    for (const { sourceNode, outputIndex, inputIndex = 0 } of ctx.node.incomingConnections ?? []) {
      sources[inputIndex].push(`ctx.getNodeOutput(${JSON.stringify(sourceNode)}, ${outputIndex}) || []`);
    }
    const inputs = sources.map((port) => `[${port.join(", ")}].flat()`);
    const options = params.options ?? {};
    const includeUnpaired = ExpressionParser.parse(options.includeUnpaired ?? false);
    return `
    {
      const inputs: N8nItem[][] = [${inputs.join(", ")}];
      const merged = ((item: N8nItem) => mergeByPosition(
        inputs, Boolean(${includeUnpaired}), ${JSON.stringify(options.clashHandling?.values ?? {})},
      ))(inputs[0][0] || { json: {} });
      ${ctx.variableName} = merged;
      item = merged[0] || { json: {} };
      ctx.setNodeOutputs(${JSON.stringify(ctx.node.name)}, [[0, merged]], merged);
    }`;
  }

  // src/compiler/mappers/code-context.ts
  function usesLegacyNodeReferences(node) {
    if (!node.type.includes("code") && !node.type.includes("function"))
      return false;
    const code = node.parameters?.jsCode || node.parameters?.functionCode;
    return typeof code === "string" && /\$node\b/.test(code);
  }
  function getLegacyNodeReferenceIssue(node) {
    if (usesLegacyNodeReferences(node) && node.parameters?.mode === "runOnceForEachItem") {
      return "Code legacy $node references require Run Once for All Items";
    }
  }
  function collectLegacyNodePorts(node, nodesByName) {
    const upstream = new Map;
    const queue = [node];
    const visited = new Set([node.name]);
    for (let index = 0;index < queue.length; index++) {
      const incoming = [...queue[index].incomingConnections ?? []];
      incoming.sort((a, b) => (a.inputIndex ?? 0) - (b.inputIndex ?? 0));
      for (const { sourceNode, outputIndex } of incoming) {
        if (visited.has(sourceNode))
          continue;
        visited.add(sourceNode);
        upstream.set(sourceNode, outputIndex);
        const source = nodesByName.get(sourceNode);
        if (source)
          queue.push(source);
      }
    }
    return [...upstream];
  }

  // src/compiler/mappers/code-errors.ts
  function continuesCodeOnRegularOutput(node) {
    const params = node.parameters ?? {};
    return node.type === "n8n-nodes-base.code" && node.onError === "continueRegularOutput" && (params.language ?? "javaScript") === "javaScript" && (params.mode ?? "runOnceForAllItems") === "runOnceForAllItems";
  }

  // src/compiler/mappers/raw-edit-fields.ts
  function isRawEditFields(node) {
    return node.type === "n8n-nodes-base.set" && node.parameters?.mode === "raw";
  }
  function usesRawLegacyNodeReferences(node) {
    const value = node.parameters?.jsonOutput;
    return isRawEditFields(node) && typeof value === "string" && value.startsWith("=") && /\{\{[\s\S]*?\$node\b[\s\S]*?\}\}/.test(value);
  }
  function getRawEditFieldsIssue(node) {
    if (!isRawEditFields(node))
      return;
    if (node.typeVersion !== 3.4)
      return "Edit Fields JSON Output requires node version 3.4";
    const params = node.parameters;
    const { dotNotation, stripBinary } = params.options ?? {};
    if ([params.includeOtherFields, dotNotation, stripBinary].some((value) => value !== undefined && typeof value !== "boolean")) {
      return "Edit Fields JSON Output requires static field and binary options";
    }
    if (params.includeOtherFields !== false && params.includeOtherFields !== undefined && !["all", "none"].includes(params.include ?? "all")) {
      return "Edit Fields JSON Output supports including all or none of the input fields";
    }
    if (params.duplicateItem)
      return "Edit Fields JSON Output does not support manual item duplication";
  }
  function compileJsonOutput(value) {
    if (typeof value !== "string" || !value.startsWith("="))
      return JSON.stringify(value);
    const template = value.replace(/^=+/, "");
    const compileExpression = (expression) => ExpressionParser.parse("=" + expression, "source[0]", "source");
    const trimmed = template.trim();
    if (trimmed.startsWith("{{") && trimmed.endsWith("}}") && !trimmed.slice(2, -2).includes("{{")) {
      return compileExpression(trimmed);
    }
    const fragments = [];
    let offset = 0;
    let quoted = false;
    for (const expression of template.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
      const literal = template.slice(offset, expression.index);
      for (const [token] of literal.matchAll(/\\[\s\S]|"/g)) {
        if (token === '"')
          quoted = !quoted;
      }
      fragments.push(JSON.stringify(literal));
      fragments.push("encodeJsonTemplateValue(" + compileExpression(expression[0]) + ", " + quoted + ")");
      offset = expression.index + expression[0].length;
    }
    fragments.push(JSON.stringify(template.slice(offset)));
    return "[" + fragments.join(", ") + "].join('')";
  }
  function mapRawEditFields(ctx) {
    const params = ctx.node.parameters;
    const options = params.options ?? {};
    const jsonOutput = compileJsonOutput(params.jsonOutput === undefined ? { my_field_1: "value", my_field_2: 1 } : params.jsonOutput);
    const includeAll = params.includeOtherFields === true && (params.include ?? "all") === "all";
    const stripBinary = options.stripBinary ?? true;
    const dotNotation = options.dotNotation ?? true;
    const legacyBinding = ctx.legacyNodePorts ? "const $node = createLegacyNodeReferences(ctx, legacyNodeNames, " + JSON.stringify(ctx.legacyNodePorts) + ", itemIndex);" : "";
    return [
      "{",
      "  const source: N8nItem[] = " + (ctx.previousVariableName ?? "inputItems") + ";",
      "  " + ctx.variableName + " = source.map((item, itemIndex) => {",
      ...legacyBinding ? ["    " + legacyBinding] : [],
      "    return applyRawEditFields(item, itemIndex, " + jsonOutput + ", {",
      "      includeAll: " + includeAll + ", stripBinary: " + stripBinary + ",",
      "      dotNotation: " + dotNotation + ",",
      "    });",
      "  });",
      "}",
      "item = " + ctx.variableName + "[0] || { json: {} };",
      "ctx.setNodeOutput(" + JSON.stringify(ctx.node.name) + ", " + ctx.variableName + ");"
    ].join(`
`);
  }

  // src/compiler/mappers/rabbitmq.ts
  var rabbitMqPublisherType = "n8n-nodes-base.rabbitmq";
  function getRabbitMqPublisherIssue(node) {
    const params = node.parameters ?? {};
    const version = node.typeVersion ?? 1;
    if (version !== 1 && version !== 1.1) {
      return "RabbitMQ needs typeVersion 1 or 1.1";
    }
    if ((params.operation ?? "sendMessage") !== "sendMessage" || params.mode !== "exchange" || Object.keys(params.options ?? {}).length > 0) {
      return "RabbitMQ only supports Send Message to an existing exchange with default options";
    }
  }
  function mapRabbitMqPublisher(ctx) {
    const issue = getRabbitMqPublisherIssue(ctx.node);
    if (issue)
      throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
    const params = ctx.node.parameters ?? {};
    const source = ctx.previousVariableName ?? "inputItems";
    const exchange = ExpressionParser.parse(params.exchange ?? "");
    const routingKey = ExpressionParser.parse(params.routingKey ?? "");
    const sendInputData = ExpressionParser.parse(params.sendInputData ?? true);
    const message = ExpressionParser.parse(params.message ?? "");
    const output = ctx.variableName;
    return `
    {
      const source: N8nItem[] = ${source} || inputItems;
      ${output} = [];
      if (source.length > 0) {
        item = source[0];
        const exchange = String(${exchange});
        const routingKey = String(${routingKey});
        const sendInputData = Boolean(${sendInputData});
        const messages = source.map((item) => sendInputData ? JSON.stringify(item.json) : String(${message}));
        ${output} = await publishRabbitMq(exchange, routingKey, messages);
      }
      item = ${output}[0] || { json: {} };
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${output});
    }`;
  }

  // src/compiler/mappers/node-retry.ts
  function usesNodeRetry(node) {
    return node.retryOnFail === true && (node.type === "n8n-nodes-base.httpRequest" || node.type === "n8n-nodes-base.s3");
  }
  function withNodeRetry(node, operation) {
    if (!usesNodeRetry(node))
      return operation;
    const maxTries = Math.min(5, Math.max(2, Math.trunc(Number(node.maxTries) || 3)));
    const configuredDelay = node.waitBetweenTries;
    const delayNumber = typeof configuredDelay === "string" && configuredDelay.trim() ? Number(configuredDelay) : configuredDelay;
    const delay = typeof delayNumber === "number" && Number.isFinite(delayNumber) ? Math.min(5000, Math.max(0, Math.trunc(delayNumber))) : 1000;
    return `runWithNodeRetry(() => ${operation}, ${maxTries}, ${delay})`;
  }

  // src/compiler/mappers/s3.ts
  var s3NodeType = "n8n-nodes-base.s3";
  function getS3DownloadIssue(node) {
    const params = node.parameters ?? {};
    if ((node.typeVersion ?? 1) !== 1 || (params.resource ?? "file") !== "file" || (params.operation ?? "download") !== "download") {
      return "S3 supports File / Download on node version 1";
    }
    if (typeof params.bucketName !== "string" || !params.bucketName || typeof params.fileKey !== "string" || !params.fileKey) {
      return "S3 Download requires bucketName and fileKey";
    }
  }
  function mapS3Download(ctx) {
    const issue = getS3DownloadIssue(ctx.node);
    if (issue)
      throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
    const params = ctx.node.parameters;
    const source = ctx.previousVariableName ?? "inputItems";
    const bucket = ExpressionParser.parse(params.bucketName);
    const key = ExpressionParser.parse(params.fileKey);
    const binaryProperty = ExpressionParser.parse(params.binaryPropertyName ?? "data");
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

  // src/compiler/mappers/compression.ts
  var compressionNodeType = "n8n-nodes-base.compression";
  function getCompressionIssue(node) {
    const version = node.typeVersion ?? 1;
    if (version !== 1 && version !== 1.1 || (node.parameters?.operation ?? "decompress") !== "decompress") {
      return "Compression supports ZIP and GZIP decompression on node versions 1 and 1.1";
    }
  }
  function mapCompression(ctx) {
    const issue = getCompressionIssue(ctx.node);
    if (issue)
      throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
    const params = ctx.node.parameters ?? {};
    const input = ctx.previousVariableName ?? "inputItems";
    const fields = ExpressionParser.parse(params.binaryPropertyName ?? "data");
    const prefix = ExpressionParser.parse(params.outputPrefix ?? "file_");
    return `
    {
      const source: N8nItem[] = ${input} || inputItems;
      ${ctx.variableName} = [];
      if (source.length > 0) {
        const item = source[0];
        ${ctx.variableName} = await decompressItems(source, String(${fields}), String(${prefix}));
      }
    }
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  // src/compiler/mappers/convert-to-file.ts
  var convertToFileType = "n8n-nodes-base.convertToFile";
  function getConvertToFileIssue(node) {
    const params = node.parameters ?? {};
    const version = node.typeVersion ?? 1;
    if (version !== 1 && version !== 1.1 || params.operation !== "toJson") {
      return "Convert to File supports Convert to JSON on node versions 1 and 1.1";
    }
    if ((params.mode ?? "once") !== "once") {
      return "Convert to JSON supports the All Items to One File mode";
    }
    if (!["utf8", "utf-8"].includes(params.options?.encoding ?? "utf8")) {
      return "Convert to JSON supports UTF-8 encoding";
    }
  }
  function mapConvertToFile(ctx) {
    const issue = getConvertToFileIssue(ctx.node);
    if (issue)
      throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
    const params = ctx.node.parameters ?? {};
    const options = params.options ?? {};
    const source = ctx.previousVariableName ?? "inputItems";
    const binaryProperty = ExpressionParser.parse(params.binaryPropertyName ?? "data");
    const fileName = ExpressionParser.parse(options.fileName ?? "");
    const format = ExpressionParser.parse(options.format ?? false);
    const addBOM = ExpressionParser.parse(options.addBOM ?? false);
    return `
    {
      const source: N8nItem[] = ${source} || inputItems;
      ${ctx.variableName} = [];
      if (source.length > 0) {
        const item = source[0];
        ${ctx.variableName} = [convertItemsToJsonFile(source, {
          binaryProperty: String(${binaryProperty} ?? ''),
          fileName: String(${fileName} ?? ''),
          format: Boolean(${format}),
          addBOM: Boolean(${addBOM}),
        })];
      }
    }
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  // src/runtime/wait-interval.ts
  var unitMilliseconds = {
    seconds: 1000,
    minutes: 60000,
    hours: 3600000,
    days: 86400000
  };
  function getWaitDelayMs(amount, unit) {
    if (typeof unit !== "string" || !Object.hasOwn(unitMilliseconds, unit)) {
      throw new Error("Wait unit must be seconds, minutes, hours, or days");
    }
    const numericAmount = typeof amount === "string" && amount.trim() ? Number(amount) : amount;
    if (typeof numericAmount !== "number" || !Number.isFinite(numericAmount) || numericAmount < 0) {
      throw new Error("Wait amount must be a finite nonnegative number");
    }
    const delay = numericAmount * unitMilliseconds[unit];
    if (delay > Number.MAX_SAFE_INTEGER)
      throw new Error("Wait interval is too large");
    return delay;
  }

  // src/compiler/mappers/wait-interval.ts
  var waitNodeType = "n8n-nodes-base.wait";
  function intervalParameters(node) {
    const params = node.parameters ?? {};
    return {
      amount: params.amount ?? (node.typeVersion === 1 ? 1 : 5),
      unit: params.unit ?? (node.typeVersion === 1 ? "hours" : "seconds")
    };
  }
  function isExpression(value) {
    return typeof value === "string" && value.trimStart().startsWith("=") && value.includes("{{");
  }
  function getWaitIntervalIssue(node) {
    const version = node.typeVersion ?? 1.1;
    if (version !== 1 && version !== 1.1 || (node.parameters?.resume ?? "timeInterval") !== "timeInterval") {
      return "Wait supports the After Time Interval mode on node versions 1 and 1.1";
    }
    const { amount, unit } = intervalParameters(node);
    try {
      getWaitDelayMs(isExpression(amount) ? 0 : amount, isExpression(unit) ? "seconds" : unit);
    } catch (error) {
      return error.message;
    }
  }
  function mapWaitInterval(ctx) {
    const issue = getWaitIntervalIssue(ctx.node);
    if (issue)
      throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
    const { amount, unit } = intervalParameters(ctx.node);
    const previous = ctx.previousVariableName ?? "inputItems";
    return `
    ${ctx.variableName} = ${previous} || inputItems;
    if (${ctx.variableName}.length > 0) {
      const inputItems: N8nItem[] = ${ctx.variableName};
      const item = inputItems[0];
      await waitForInterval(${ExpressionParser.parse(amount)}, ${ExpressionParser.parse(unit)});
    }
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
  }

  // src/compiler/mappers/stop-and-error.ts
  var stopAndErrorType = "n8n-nodes-base.stopAndError";
  function getStopAndErrorIssue(node) {
    if ((node.typeVersion ?? 1) !== 1)
      return "Stop and Error supports node version 1";
    const type = node.parameters?.errorType ?? "errorMessage";
    if (type !== "errorMessage" && type !== "errorObject") {
      return "Stop and Error supports Error Message and Error Object";
    }
  }
  function mapStopAndError(ctx) {
    const issue = getStopAndErrorIssue(ctx.node);
    if (issue)
      throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
    const params = ctx.node.parameters ?? {};
    const type = params.errorType ?? "errorMessage";
    const configured = params[type] ?? "";
    const value = ExpressionParser.parse(typeof configured === "string" && !configured.includes("{{") ? configured.replace(/^=/, "") : configured);
    const input = ctx.previousVariableName ?? "inputItems";
    return `
    {
      const source: N8nItem[] = ${input} || inputItems;
      if (source.length > 0) {
        const inputItems = source;
        const item = inputItems[0];
        throw createWorkflowStopError(${JSON.stringify(type)}, ${value});
      }
    }`;
  }

  // src/compiler/mappers/http-request.ts
  function usesMultipartBody(params) {
    return params?.sendBody === true && params.contentType === "multipart-form-data";
  }
  function usesJsonHeaders(params) {
    return params?.sendHeaders === true && params.specifyHeaders === "json";
  }
  function getMultipartIssue(params) {
    const method = (params.method ?? "GET").toUpperCase();
    if (!["POST", "PUT", "PATCH"].includes(method)) {
      return "HTTP Request multipart supports POST, PUT and PATCH";
    }
    const parts = params.bodyParameters?.parameters ?? [];
    if (!Array.isArray(parts))
      return "HTTP Request multipart needs an array of form fields";
    for (const part of parts) {
      if (typeof part?.name !== "string" || !part.name)
        return "HTTP Request multipart fields require a name";
      if (part.parameterType === "formBinaryData") {
        if (typeof part.inputDataFieldName !== "string" || !part.inputDataFieldName) {
          return "HTTP Request multipart binary fields require an input binary property";
        }
      } else if (part.parameterType && !["formData", "text"].includes(part.parameterType)) {
        return "HTTP Request multipart supports text and binary form fields";
      }
    }
  }
  function generateMultipartBody(params) {
    const parts = params.bodyParameters?.parameters ?? [];
    const fields = parts.map((part) => {
      const name = ExpressionParser.parse(part.name);
      const valueKey = part.parameterType === "formBinaryData" ? "binaryProperty" : "value";
      const value = ExpressionParser.parse(part.parameterType === "formBinaryData" ? part.inputDataFieldName : part.value);
      return `{ name: String(${name} ?? ''), ${valueKey}: String(${value} ?? '') }`;
    });
    return `createRequestForm(item, [${fields.join(", ")}])`;
  }

  // src/compiler/mappers/index.ts
  class NodeMappers {
    static mapNode(ctx) {
      const type = ctx.node.type;
      if (type === stopAndErrorType)
        return mapStopAndError(ctx);
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
      if (type.includes("respondToWebhook")) {
        return this.mapRespondToWebhookNode(ctx);
      }
      if (type.includes("code") || type.includes("function")) {
        return this.mapCodeNode(ctx);
      }
      if (type.includes("executeWorkflowTrigger")) {
        return this.mapGenericNode(ctx, "Subworkflow Entry Trigger");
      }
      if (type.includes("executeWorkflow")) {
        return this.mapSubworkflowNode(ctx);
      }
      if (type.includes("filter")) {
        return this.mapFilterNode(ctx);
      }
      if (type.includes("if")) {
        return this.mapIfNode(ctx);
      }
      if (type.includes("switch")) {
        return this.mapSwitchNode(ctx);
      }
      if (type.includes("set")) {
        if (isRawEditFields(ctx.node) && !getRawEditFieldsIssue(ctx.node))
          return mapRawEditFields(ctx);
        return this.mapSetNode(ctx);
      }
      if (type.includes("httpRequest")) {
        return this.mapHttpRequestNode(ctx);
      }
      if (type.includes("aggregate") || type.includes("itemLists")) {
        return this.mapAggregateNode(ctx);
      }
      if (type.includes("splitOut")) {
        return this.mapSplitOutNode(ctx);
      }
      if (type.includes("merge")) {
        return isPositionMerge(ctx.node) ? mapPositionMerge(ctx) : this.mapMergeNode(ctx);
      }
      if (type.includes("postgres")) {
        return this.mapPostgresNode(ctx);
      }
      if (type.includes("openAi") || type.includes("googleGemini") || type.includes("chainLlm")) {
        return this.mapLlmNode(ctx);
      }
      if (type === waitNodeType) {
        return mapWaitInterval(ctx);
      }
      return this.mapGenericNode(ctx, `Unmapped Node (${type})`);
    }
    static mapRespondToWebhookNode(ctx) {
      const params = ctx.node.parameters || {};
      const respondWith = params.respondWith || "firstIncomingItem";
      const statusCode = params.options?.responseCode || 200;
      const prevVar = ctx.previousVariableName || "inputItems";
      let responseExpr = "item?.json || {}";
      if (respondWith === "allIncomingItems") {
        responseExpr = `${ctx.variableName}.map((i: any) => i.json)`;
      } else if (respondWith === "json" && params.responseBody) {
        responseExpr = ExpressionParser.parse(params.responseBody);
      } else if (respondWith === "text" && params.responseBody) {
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
    static mapCodeNode(ctx) {
      const issue = getLegacyNodeReferenceIssue(ctx.node);
      if (issue)
        throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
      const params = ctx.node.parameters || {};
      const rawCode = params.jsCode || params.functionCode || "return $input.all();";
      const prevVar = ctx.previousVariableName || "inputItems";
      const legacyBinding = ctx.legacyNodePorts ? `      const $node = createLegacyNodeReferences(ctx, legacyNodeNames, ${JSON.stringify(ctx.legacyNodePorts)});
` : "";
      const transformedCode = rawCode.replace(/\$input\.all\(\)/g, "currentItems").replace(/\$input\.first\(\)/g, "(currentItems[0] || { json: {} })").replace(/\$input\.item/g, "(currentItems[0] || { json: {} })").replace(/\$json/g, "(currentItems[0]?.json || {})").replace(/\$\(['"](.*?)['"]\)\.first\(\)/g, (_, n) => `(ctx.getNode(${JSON.stringify(n)})?.first() || { json: {} })`).replace(/\$\(['"](.*?)['"]\)\.item/g, (_, n) => `(ctx.getNode(${JSON.stringify(n)})?.item || { json: {} })`).replace(/\$\(['"](.*?)['"]\)\.all\(\)/g, (_, n) => `(ctx.getNode(${JSON.stringify(n)})?.all() || [])`).replace(/\$now/g, "DateTime.now()");
      const runCode = `
      const result = await (async () => {
        ${transformedCode}
      })();
      return n8n.normalizeItems(result);`;
      const execution = continuesCodeOnRegularOutput(ctx.node) ? `
      try {${runCode}
      } catch (error) {
        return [{ json: { error: error instanceof Error ? error.message : String(error) } }];
      }` : runCode;
      return `
    // [Node: ${ctx.node.name}] Code Execution
    ${ctx.variableName} = await (async () => {
      const currentItems = ${prevVar} || inputItems;
${legacyBinding}${execution}
    })();
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
    }
    static mapSubworkflowNode(ctx) {
      const params = ctx.node.parameters || {};
      const workflowId = typeof params.workflowId === "object" ? params.workflowId?.value || params.workflowId?.cachedResultName || "" : params.workflowId || "";
      const prevVar = ctx.previousVariableName || "inputItems";
      return `
    // [Node: ${ctx.node.name}] In-Memory Subworkflow Execution (< 0.05ms)
    ${ctx.variableName} = await executeSubworkflow(${JSON.stringify(workflowId)}, ${prevVar} || inputItems, ctx);
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
    }
    static mapSetNode(ctx) {
      const params = ctx.node.parameters || {};
      const prevVar = ctx.previousVariableName || "inputItems";
      const keepOnlySet = params.options?.keepOnlySet === true || params.include === "none";
      const version = ctx.node.typeVersion ?? 3.4;
      const options = params.options ?? {};
      let includeBinary;
      if (version >= 3.4) {
        const includeOtherFields = ExpressionParser.parse(params.includeOtherFields ?? false);
        const include = ExpressionParser.parse(params.include ?? "all");
        const stripBinary = ExpressionParser.parse(options.stripBinary ?? false);
        includeBinary = `(${includeOtherFields}) && (${include}) !== 'none' && !(${stripBinary})`;
      } else if (version >= 3) {
        includeBinary = ExpressionParser.parse(options.includeBinary ?? false);
      } else {
        includeBinary = `!(${ExpressionParser.parse(params.keepOnlySet ?? options.keepOnlySet ?? false)})`;
      }
      const assignments = [];
      if (params.assignments?.assignments && Array.isArray(params.assignments.assignments)) {
        for (const a of params.assignments.assignments) {
          if (a.name) {
            const valExpr = ExpressionParser.parse(a.value);
            assignments.push(`n8n.setNestedProperty(newJson, ${JSON.stringify(a.name)}, ${valExpr});`);
          }
        }
      }
      if (params.values) {
        for (const typeKey of ["string", "number", "boolean"]) {
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
      const newJson: Record<string, any> = ${keepOnlySet ? "{}" : "{ ...currentItem.json }"};
      ${assignments.join(`
      `)}
      return {
        json: newJson,
        ...(currentItem.binary !== undefined && (${includeBinary}) ? { binary: { ...currentItem.binary } } : {}),
      };
    });
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
    }
    static parseConditions(group, legacyFilter = false) {
      const conditions = [];
      const firstInputItem = legacyFilter ? undefined : "firstInputItem";
      if (Array.isArray(group?.conditions)) {
        for (const cond of group.conditions) {
          let left = ExpressionParser.parse(cond.leftValue, firstInputItem);
          let right = ExpressionParser.parse(cond.rightValue, firstInputItem);
          const op = cond.operator?.operation || "equals";
          if (legacyFilter && ["true", "false", "gte", "lte"].includes(op)) {
            conditions.push(`Boolean(${left})`);
            continue;
          }
          if (!legacyFilter && group.options?.caseSensitive === false && cond.operator?.type === "string") {
            const lowerCase = "(value: unknown) => typeof value === 'string' ? value.toLowerCase() : value";
            left = `((${lowerCase})(${left}))`;
            right = `((${lowerCase})(${right}))`;
          }
          switch (op) {
            case "equals":
            case "equal":
              conditions.push(`(${left} == ${right})`);
              break;
            case "notEquals":
            case "notEqual":
              conditions.push(`(${left} != ${right})`);
              break;
            case "contains":
              conditions.push(`String(${left} ?? '').includes(String(${right} ?? ''))`);
              break;
            case "true":
              conditions.push(`(${left} === true)`);
              break;
            case "false":
              conditions.push(`(${left} === false)`);
              break;
            case "gt":
            case "larger":
              conditions.push(`(Number(${left}) > Number(${right}))`);
              break;
            case "lt":
            case "smaller":
              conditions.push(`(Number(${left}) < Number(${right}))`);
              break;
            case "gte":
              conditions.push(`(Number(${left}) >= Number(${right}))`);
              break;
            case "lte":
              conditions.push(`(Number(${left}) <= Number(${right}))`);
              break;
            case "isEmpty":
            case "empty":
              conditions.push(`(${left} === undefined || ${left} === null || ${left} === '')`);
              break;
            case "isNotEmpty":
            case "notEmpty":
              conditions.push(`(${left} !== undefined && ${left} !== null && ${left} !== '')`);
              break;
            default:
              conditions.push(`Boolean(${left})`);
          }
        }
      }
      const combinator = group?.combinator === "or" ? " || " : " && ";
      return conditions.length ? conditions.join(combinator) : "true";
    }
    static mapFilterNode(ctx) {
      const prevVar = ctx.previousVariableName || "inputItems";
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
    static mapIfNode(ctx) {
      const prevVar = ctx.previousVariableName || "inputItems";
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
    static mapSwitchNode(ctx) {
      const params = ctx.node.parameters || {};
      const prevVar = ctx.previousVariableName || "inputItems";
      const rules = params.rules?.values || [];
      const options = params.options ?? {};
      const fallback = options.fallbackOutput ?? "none";
      const fallbackPort = fallback === "extra" ? rules.length : fallback;
      const hasFallback = fallback === "extra" || Number.isInteger(fallbackPort) && fallbackPort >= 0 && fallbackPort < rules.length;
      const fallbackCode = hasFallback ? `
        if (!matched) {
          send(item, ${fallbackPort});
          matched = true;
        }` : "";
      const predicates = rules.map((rule) => `(item: N8nItem) => (${rule.conditions ? this.parseConditions(rule.conditions) : "false"})`);
      const matchRules = `
      const predicates = [${predicates.join(", ")}];
      for (const item of source) {
        let matched = false;
        for (const [port, matches] of predicates.entries()) {
          if (matches(item)) {
            send(item, port);
            matched = true;
            if (!(${ExpressionParser.parse(options.allMatchingOutputs ?? false, "firstInputItem")})) break;
          }
        }
        ${fallbackCode}
        if (matched) routed.push(item);
      }`;
      const matchExpression = `
      const numberOutputs = source.length > 0
        ? ((item: N8nItem) => (${ExpressionParser.parse(params.numberOutputs ?? 4, "firstInputItem")}))(source[0])
        : 0;
      for (const item of source) {
        const port = ${ExpressionParser.parse(params.output ?? 0, "firstInputItem")};
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
      ${params.mode === "expression" ? matchExpression : matchRules}
      ${ctx.variableName} = routed;
      item = routed[0] || { json: {} };
      ctx.setNodeOutputs(${JSON.stringify(ctx.node.name)}, outputs, routed);
    }`;
    }
    static mapHttpRequestNode(ctx) {
      const params = ctx.node.parameters || {};
      const prevVar = ctx.previousVariableName || "inputItems";
      const method = (params.method || "GET").toUpperCase();
      const urlExpr = ExpressionParser.parse(params.url || "");
      const multipart = usesMultipartBody(params);
      const jsonHeaders = usesJsonHeaders(params);
      let headersObj = "{}";
      if (jsonHeaders) {
        headersObj = `parseRequestHeaders(${ExpressionParser.parse(params.jsonHeaders ?? "{}")})`;
      } else if (params.headerParameters?.parameters && Array.isArray(params.headerParameters.parameters)) {
        const pairs = params.headerParameters.parameters.filter((p) => p.name).map((p) => `${JSON.stringify(p.name)}: ${ExpressionParser.parse(p.value)}`);
        headersObj = `{ ${pairs.join(", ")} }`;
      }
      let bodySnippet = "undefined";
      if (multipart) {
        const issue = getMultipartIssue(params);
        if (issue)
          throw new Error(`Node ${JSON.stringify(ctx.node.name)}: ${issue}`);
        bodySnippet = generateMultipartBody(params);
      } else if (["POST", "PUT", "PATCH"].includes(method)) {
        if (params.jsonBody) {
          bodySnippet = `JSON.stringify(${ExpressionParser.parse(params.jsonBody)})`;
        } else if (params.bodyParameters?.parameters && Array.isArray(params.bodyParameters.parameters)) {
          const pairs = params.bodyParameters.parameters.filter((p) => p.name).map((p) => `${JSON.stringify(p.name)}: ${ExpressionParser.parse(p.value)}`);
          bodySnippet = `JSON.stringify({ ${pairs.join(", ")} })`;
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
      const collectItems = usesNodeRetry(ctx.node) ? "settleRetryRequests" : "Promise.all";
      const request = `${collectItems}((${prevVar} || inputItems).map(async (currentItem: N8nItem) => {
      const item = currentItem;
      const targetUrl = ${urlExpr};
      ${headersSnippet}
      const reqBody = ${bodySnippet};
      const res = await fetch(targetUrl, {
        method: ${JSON.stringify(method)},
        headers: reqHeaders,
        ...(reqBody !== undefined ? { body: reqBody } : {})
      });
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { json: typeof data === 'object' && data !== null ? data : { data } };
    }))`;
      return `
    // [Node: ${ctx.node.name}] Native HTTP Request (${method})
    ${ctx.variableName} = await ${withNodeRetry(ctx.node, request)};
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
    }
    static mapAggregateNode(ctx) {
      const params = ctx.node.parameters || {};
      const prevVar = ctx.previousVariableName || "inputItems";
      const destinationField = params.destinationFieldName || "data";
      return `
    // [Node: ${ctx.node.name}] Aggregate Items
    {
      const source = ${prevVar} || inputItems;
      ${ctx.variableName} = [{ json: { ${JSON.stringify(destinationField)}: source.map((i: N8nItem) => i.json) } }];
      item = ${ctx.variableName}[0];
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
    }
    static mapSplitOutNode(ctx) {
      const params = ctx.node.parameters || {};
      const prevVar = ctx.previousVariableName || "inputItems";
      const fieldToSplit = params.fieldToSplitOut || "data";
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
    static mapMergeNode(ctx) {
      const incoming = ctx.node.incomingConnections || [];
      const mode = ctx.node.parameters?.mode || "append";
      const sources = incoming.map((c) => `(ctx.getNodeOutput(${JSON.stringify(c.sourceNode)}, ${c.outputIndex}) || [])`);
      if (mode === "combine" && sources.length >= 2) {
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
      const combined = [${sources.join(", ")}].flat();
      ${ctx.variableName} = combined.length > 0 ? combined : inputItems;
      item = ${ctx.variableName}[0] || { json: {} };
      ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});
    }`;
    }
    static mapPostgresNode(ctx) {
      const params = ctx.node.parameters || {};
      const prevVar = ctx.previousVariableName || "inputItems";
      const queryExpr = ExpressionParser.parse(params.query || "SELECT 1;");
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
    static mapLlmNode(ctx) {
      const params = ctx.node.parameters || {};
      const prevVar = ctx.previousVariableName || "inputItems";
      const model = params.modelId?.value || params.model || "gpt-4o-mini";
      const promptText = params.messages?.values?.[0]?.content || params.prompt || params.text || "Hello";
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
    static mapGenericNode(ctx, label) {
      const prevVar = ctx.previousVariableName || "inputItems";
      return `
    // [Node: ${ctx.node.name}] ${label} (Pass-through)
    ${ctx.variableName} = ${prevVar} || inputItems;
    item = ${ctx.variableName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(ctx.node.name)}, ${ctx.variableName});`;
    }
  }

  // src/compiler/polling-code.ts
  function emitPollingLoop(loop, nodes, mapNode, wrapNode) {
    const { entry, terminalExits, repeatPort, ...runtimePlan } = loop;
    const entryNode = nodes.get(entry);
    const initial = entryNode.incomingConnections.find((connection) => !loop.nodes.includes(connection.sourceNode));
    const inputBatches = "ctx.getNodeOutputBatches(" + JSON.stringify(initial.sourceNode) + ", " + initial.outputIndex + ")";
    let body = "";
    for (const [index, name] of loop.nodes.entries()) {
      const node = nodes.get(name);
      if (index === 0) {
        body += wrapNode(node, "true", mapNode(node, "pollingItems"));
      } else {
        const incoming = node.incomingConnections.find((connection) => connection.sourceNode === loop.nodes[index - 1]);
        const input = "pollingInput_" + index;
        body += "    const " + input + " = ctx.getNodeOutput(" + JSON.stringify(incoming.sourceNode) + ", " + incoming.outputIndex + `);
`;
        body += wrapNode(node, input + "?.length", mapNode(node, input));
      }
      if (name !== loop.decision)
        continue;
      for (const [exitIndex, exit] of terminalExits.entries()) {
        const terminal = nodes.get(exit.target);
        const output = "pollingTerminal_" + exitIndex;
        body += "    const " + output + " = ctx.getNodeOutput(" + JSON.stringify(name) + ", " + exit.output + `);
`;
        body += wrapNode(terminal, output + "?.length", mapNode(terminal, output));
      }
      body += "    if (ctx.getNodeOutput(" + JSON.stringify(name) + ", " + repeatPort + `)?.length) assertCanRetry();
`;
    }
    return "  await ctx.runPollingLoop(" + JSON.stringify(runtimePlan) + ", " + inputBatches + `, async (pollingItems, assertCanRetry) => {
` + body + `  });
`;
  }

  // src/compiler/disabled-node.ts
  function getDisabledNodeMode(node, workflow) {
    if (!node.disabled || workflow.triggers.includes(node) || node.type.toLowerCase().endsWith("trigger"))
      return;
    const outputs = Object.entries(workflow.connections[node.name] ?? {});
    let hasOutgoing = false;
    for (const [type, ports] of outputs) {
      for (const [port, targets] of ports.entries()) {
        if (!targets?.length)
          continue;
        if (type !== "main" || port !== 0)
          return;
        hasOutgoing = true;
      }
    }
    let hasIncoming = false;
    for (const outputs of Object.values(workflow.connections)) {
      for (const [type, ports] of Object.entries(outputs)) {
        for (const targets of ports) {
          for (const target of targets ?? []) {
            if (target?.node !== node.name)
              continue;
            if (hasIncoming || type !== "main" || (target.index ?? 0) !== 0)
              return;
            hasIncoming = true;
          }
        }
      }
    }
    if (hasIncoming)
      return "passthrough";
    if (!hasOutgoing)
      return "skip";
  }

  // src/compiler/code-generator.ts
  class CodeGenerator {
    static sanitizeIdentifier(str) {
      return str.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^[0-9]/, "_$&").replace(/__+/g, "_");
    }
    static generateWorkflowCode(wf) {
      const functionName = `workflow_${this.sanitizeIdentifier(wf.fileName)}`;
      const depth = (wf.relativePath.match(/\//g) || []).length;
      const runtimePrefix = "../".repeat(depth + 1) + "runtime";
      const positionMergeImport = wf.nodes.some(isPositionMerge) ? `import { mergeByPosition } from '${runtimePrefix}/position-merge';
` : "";
      const legacyNodes = new Set(wf.nodes.filter((node) => usesLegacyNodeReferences(node) || usesRawLegacyNodeReferences(node)));
      const rawFieldsImport = wf.nodes.some(isRawEditFields) ? `import { applyRawEditFields, encodeJsonTemplateValue } from '${runtimePrefix}/raw-edit-fields';
` : "";
      const legacyImport = legacyNodes.size > 0 ? `import { createLegacyNodeReferences } from '${runtimePrefix}/code-context';
` : "";
      const retryNodes = wf.nodes.filter((node) => !node.disabled && usesNodeRetry(node));
      const retryImport = retryNodes.length > 0 ? `import { runWithNodeRetry${retryNodes.some((node) => node.type === "n8n-nodes-base.httpRequest") ? ", settleRetryRequests" : ""} } from '${runtimePrefix}/node-retry';
` : "";
      const legacyNames = legacyNodes.size > 0 ? `const legacyNodeNames = new Set<string>(${JSON.stringify(wf.nodes.map((node) => node.name))});
` : "";
      const nodesByName = new Map(wf.nodes.map((node) => [node.name, node]));
      const rabbitMqImport = wf.nodes.some((node) => node.type === rabbitMqPublisherType) ? `import { publishRabbitMq } from '${runtimePrefix}/rabbitmq';
` : "";
      const s3Import = wf.nodes.some((node) => node.type === s3NodeType) ? `import { downloadS3Files } from '${runtimePrefix}/s3';
` : "";
      const compressionImport = wf.nodes.some((node) => node.type === compressionNodeType) ? `import { decompressItems } from '${runtimePrefix}/compression';
` : "";
      const jsonFileImport = wf.nodes.some((node) => node.type === convertToFileType) ? `import { convertItemsToJsonFile } from '${runtimePrefix}/convert-to-json';
` : "";
      const httpRequestImport = wf.nodes.some((node) => node.type.includes("httpRequest") && (usesMultipartBody(node.parameters) || usesJsonHeaders(node.parameters))) ? `import { createRequestForm, parseRequestHeaders } from '${runtimePrefix}/http-request';
` : "";
      const waitImport = wf.nodes.some((node) => node.type === waitNodeType) ? `import { waitForInterval } from '${runtimePrefix}/wait-interval';
` : "";
      const stopAndErrorImport = wf.nodes.some((node) => node.type === stopAndErrorType) ? `import { createWorkflowStopError } from '${runtimePrefix}/stop-and-error';
` : "";
      const imports = `import { WorkflowContext } from '${runtimePrefix}/workflow-context';
import { n8n, N8nItem } from '${runtimePrefix}/n8n-helper';
import { executeSubworkflow, registerWorkflow } from '${runtimePrefix}/workflow-registry';
${positionMergeImport}${legacyImport}${rawFieldsImport}${rabbitMqImport}${s3Import}${compressionImport}${jsonFileImport}${httpRequestImport}${waitImport}${stopAndErrorImport}
${legacyNames}
${retryImport}const DateTime = {
  now: () => ({
    toString: () => new Date().toISOString(),
    toJSDate: () => new Date()
  })
};
`;
      let declCode = `  let item: N8nItem = inputItems[0] || { json: {} };
`;
      let bodyCode = `  ctx.setNodeOutput("__initial__", inputItems);
`;
      const nodeVarMap = new Map;
      wf.orderedNodes.forEach((node, index) => {
        const varName = `node_${index}_${this.sanitizeIdentifier(node.name)}`;
        nodeVarMap.set(node.name, varName);
      });
      const triggers = wf.triggers;
      const hasRabbitMqTrigger = triggers.some((node) => node.type === rabbitMqTriggerType);
      const disabledModes = new Map(wf.orderedNodes.map((node) => [node, getDisabledNodeMode(node, wf)]));
      const nonTriggers = wf.orderedNodes.filter((n) => !triggers.includes(n) && disabledModes.get(n) !== "skip");
      const loops = wf.pollingLoops ?? [];
      const loopsByMember = new Map(loops.flatMap((loop) => loop.nodes.map((name) => [name, loop])));
      const terminalNames = new Set(loops.flatMap((loop) => loop.terminalExits.map((exit) => exit.target)));
      const mapNode = (node, previousVariableName) => {
        const varName = nodeVarMap.get(node.name);
        return disabledModes.get(node) === "passthrough" ? `
    ${varName} = ${previousVariableName} || [];
    item = ${varName}[0] || { json: {} };
    ctx.setNodeOutput(${JSON.stringify(node.name)}, ${varName});` : NodeMappers.mapNode({
          node,
          workflowName: wf.name,
          variableName: varName,
          previousVariableName,
          legacyNodePorts: legacyNodes.has(node) ? collectLegacyNodePorts(node, nodesByName) : undefined
        });
      };
      triggers.forEach((node) => {
        const index = wf.orderedNodes.indexOf(node);
        const varName = nodeVarMap.get(node.name);
        declCode += `  let ${varName}: any = inputItems;
`;
        const nodeName = JSON.stringify(node.name);
        let condition = `entryNode === ${nodeName}`;
        if (node.type !== rabbitMqTriggerType) {
          const rawNodePath = (node.parameters?.path || node.name).toLowerCase().trim().replace(/^\/+/, "");
          bodyCode += `  const triggerNode_${index} = item?.json?.__triggerNode;
`;
          bodyCode += `  const triggerPath_${index} = item?.json?.__triggerPath;
`;
          condition = `entryNode === undefined && (!triggerNode_${index} || triggerNode_${index} === ${nodeName} || triggerPath_${index} === ${JSON.stringify(rawNodePath)})`;
        }
        const nodeCode = `${varName} = inputItems;
ctx.setNodeOutput(${nodeName}, inputItems);`;
        bodyCode += this.generateNodeBlock(wf.id, node, condition, nodeCode);
      });
      nonTriggers.forEach((node) => {
        const varName = nodeVarMap.get(node.name);
        declCode += `  let ${varName}: any = inputItems;
`;
        const loop = loopsByMember.get(node.name);
        if (loop) {
          if (node.name === loop.entry) {
            bodyCode += emitPollingLoop(loop, nodesByName, mapNode, (member, condition, code) => this.generateNodeBlock(wf.id, member, condition, code));
          }
          return;
        }
        if (terminalNames.has(node.name))
          return;
        let branchCheckStr = "true";
        const incoming = node.incomingConnections ?? [];
        const runPerIncomingBatch = incoming.length > 0 && (disabledModes.get(node) === "passthrough" || !node.type.includes("merge"));
        if (incoming.length > 0) {
          const branchChecks = incoming.map((conn) => `ctx.isBranchActive(${JSON.stringify(conn.sourceNode)}, ${conn.outputIndex})`);
          branchCheckStr = `(${branchChecks.join(" || ")})`;
        }
        const prevExpr = runPerIncomingBatch ? "incomingItems" : "inputItems";
        let nodeCode = mapNode(node, prevExpr);
        if (runPerIncomingBatch) {
          const batches = incoming.map((conn) => `ctx.getNodeOutputBatches(${JSON.stringify(conn.sourceNode)}, ${conn.outputIndex})`);
          nodeCode = `await ctx.runNodeBatches(${JSON.stringify(node.name)}, [${batches.join(", ")}].flat(), async (incomingItems) => {
${nodeCode.trim()}
});`;
        }
        const ancestorTriggers = node.ancestorTriggers ?? [];
        if (ancestorTriggers.length > 0) {
          const triggerConditions = ancestorTriggers.map((t) => `ctx.hasExecutedNode(${JSON.stringify(t)})`).join(" || ");
          branchCheckStr = `(${triggerConditions}) && ${branchCheckStr}`;
        } else if (hasRabbitMqTrigger) {
          branchCheckStr = `entryNode === undefined && ${branchCheckStr}`;
        }
        bodyCode += this.generateNodeBlock(wf.id, node, branchCheckStr, nodeCode, ancestorTriggers.length > 0 ? "      " : "    ");
      });
      const lastNodeName = wf.orderedNodes.filter((node) => disabledModes.get(node) !== "skip" && (node.type !== stopAndErrorType || node.disabled)).at(-1)?.name;
      const returnItemsExpr = lastNodeName ? `(ctx.getNode(${JSON.stringify(lastNodeName)})?.all() || [{ json: item.json }])` : `inputItems`;
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
    static generateNodeBlock(workflowId, node, condition, nodeCode, nodeIndent = "    ") {
      const traceArgs = [workflowId, node.id || node.name, node.name].map((value) => JSON.stringify(value)).join(", ");
      const body = nodeIndent + nodeCode.trim().replace(/\n/g, `
${nodeIndent}`);
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

  // src/compiler/route-generator.ts
  class RouteGenerator {
    static generateRoutesCode(workflows) {
      let imports = `import { randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { N8nItem } from '../runtime/n8n-helper';
import { WorkflowContext } from '../runtime/workflow-context';
`;
      const importedFunctions = [];
      workflows.forEach((wf) => {
        const functionName = `workflow_${CodeGenerator.sanitizeIdentifier(wf.fileName)}`;
        const importPath = wf.relativePath.replace(/\.ts$/, "");
        imports += `import { ${functionName} } from '../workflows/${importPath}';
`;
        importedFunctions.push(functionName);
      });
      let routeDefinitions = "";
      const rabbitMqStarts = [];
      const registeredRoutes = new Set;
      workflows.forEach((wf) => {
        const functionName = `workflow_${CodeGenerator.sanitizeIdentifier(wf.fileName)}`;
        const webhooks = wf.nodes.filter((node) => node.type.includes("webhook"));
        for (const node of getRabbitMqTriggers(wf)) {
          const options = parseRabbitMqTrigger(node);
          if (typeof options === "string") {
            throw new Error(`Workflow ${JSON.stringify(wf.name)}, node ${JSON.stringify(node.name)}: ${options}`);
          }
          const logContext = JSON.stringify({ workflowId: wf.id, node: node.name });
          rabbitMqStarts.push(`      stopConsumers.push(await startRabbitMqConsumer(
        ${JSON.stringify(options)},
        (items) => ${functionName}(items, undefined, ${JSON.stringify(node.name)}),
        (message) => fastify.log.error(${logContext}, message),
      ));`);
        }
        webhooks.forEach((node) => {
          const rawPath = (node.parameters?.path || wf.fileName).toLowerCase().trim().replace(/^\/+/, "");
          const configuredMethod = (node.parameters?.httpMethod || "POST").toUpperCase();
          const methods = configuredMethod === "ALL" ? ["GET", "POST", "PUT", "DELETE"] : [configuredMethod];
          const targetPaths = Array.from(new Set([`/${rawPath}`, `/webhook/${rawPath}`]));
          methods.forEach((httpMethod) => {
            targetPaths.forEach((routePath) => {
              const routeKey = `${httpMethod}:${routePath}`;
              if (registeredRoutes.has(routeKey))
                return;
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
      if (rabbitMqStarts.length > 0) {
        imports += `import { startRabbitMqConsumer } from '../runtime/rabbitmq';
`;
        routeDefinitions += `
  const stopConsumers: Array<() => Promise<void>> = [];
  const closeConsumers = async () => {
    await Promise.allSettled(stopConsumers.splice(0).map(stop => stop()));
  };
  fastify.addHook('onReady', async () => {
    try {
${rabbitMqStarts.join(`
`)}
    } catch (error) {
      await closeConsumers();
      throw error;
    }
  });
  fastify.addHook('onClose', closeConsumers);
`;
      }
      return `${imports}
// Prevent bundler/runtime tree-shaking so subworkflows self-register into WorkflowRegistry
const _registeredWorkflows = [${importedFunctions.join(", ")}];
void _registeredWorkflows;

export async function registerCompiledRoutes(fastify: FastifyInstance): Promise<void> {
${routeDefinitions}
}
`;
    }
    static generateServerEntry(workflows = []) {
      const shutdown = workflows.some((workflow) => getRabbitMqTriggers(workflow).length > 0) ? `
  const close = () => {
    void fastify.close().catch(error => {
      fastify.log.error(error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);` : "";
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
    static generateOutputPackageJson(workflows = [], dependencies = {}) {
      const needsRabbitMq = workflows.some((workflow) => getRabbitMqTriggers(workflow).length > 0 || workflow.nodes.some((node) => node.type === rabbitMqPublisherType));
      const needsS3 = workflows.some((workflow) => workflow.nodes.some((node) => node.type === s3NodeType));
      const needsCompression = workflows.some((workflow) => workflow.nodes.some((node) => node.type === compressionNodeType));
      const needsMimeTypes = needsS3 || needsCompression || workflows.some((workflow) => workflow.nodes.some((node) => node.type === convertToFileType));
      return JSON.stringify({
        name: "compiled-n8n-service",
        version: "1.0.0",
        type: "module",
        scripts: {
          start: "bun run server.ts",
          dev: "bun --watch run server.ts"
        },
        dependencies: {
          "@fastify/cors": "^9.0.1",
          fastify: "^4.28.1",
          ...needsRabbitMq ? { amqplib: "^0.10.9" } : {},
          ...needsS3 ? { "@aws-sdk/client-s3": "3.808.0" } : {},
          ...needsMimeTypes ? { "mime-types": "^3.0.1" } : {},
          ...needsCompression ? { fflate: "0.8.3" } : {},
          ...dependencies
        }
      }, null, 2);
    }
  }

  // src/browser.ts
  function compileWorkflowJson(jsonInput) {
    const start = performance.now();
    const raw = typeof jsonInput === "string" ? JSON.parse(jsonInput) : jsonInput;
    const parsed = CoreWorkflowParser.parseWorkflow(raw, raw?.name || "workflow", "workflow.ts");
    if (!parsed) {
      throw new Error('Invalid n8n workflow JSON: missing "nodes" array.');
    }
    const workflowCode = CodeGenerator.generateWorkflowCode(parsed);
    const routesCode = RouteGenerator.generateRoutesCode([parsed]);
    const elapsedMs = (performance.now() - start).toFixed(2);
    return {
      name: parsed.name,
      nodeCount: parsed.nodes.length,
      triggerCount: parsed.triggers.length,
      elapsedMs,
      workflowCode,
      routesCode
    };
  }
  if (typeof window !== "undefined") {
    window.N8nToFastify = { compileWorkflowJson };
  }
})();
