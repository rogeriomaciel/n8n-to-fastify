# ⚡ n8n-to-fastify

**`n8n-to-fastify`** is an open-source Ahead-Of-Time (AOT) compiler that transpiles exported n8n workflow JSONs (including nested subworkflows) into standalone, zero-overhead TypeScript/Fastify microservices. Built for engineering teams hitting n8n Out-of-Memory (OOM) crashes, database queue locks, and ~200ms+ webhook latency in production, it eliminates the runtime interpreter so you can design visually in n8n and deploy bare-metal Node.js/Bun services via CI/CD.

[![CI](https://github.com/rogeriomaciel/n8n-to-fastify/actions/workflows/ci.yml/badge.svg)](https://github.com/rogeriomaciel/n8n-to-fastify/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![Fastify](https://img.shields.io/badge/Fastify-v4.x-black.svg)](https://www.fastify.io/)
[![Bun](https://img.shields.io/badge/Bun-1.x-fbf0df.svg)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Use n8n as your visual IDE in staging. Compile & deploy pure, bare-metal Fastify microservices to production via CI/CD.**
>
> **[⚡ Try the Live Browser Playground](https://rogeriomaciel.com.br/en/n8n-to-fastify/)** *(100% client-side — paste any n8n JSON, zero data leaves your browser)*

---

## 🔥 Why Transpile n8n to Fastify?

Visual workflow engines are incredible for rapid prototyping, debugging, and iterating in staging. However, running an interpreted low-code engine in high-concurrency production introduces severe bottlenecks:

- **Memory Bloat:** Heavy container overhead (> 1.2 GB RAM under burst load).
- **Queue Starvation & DB Locks:** Every execution writes state to `execution_entity` and queues subworkflows.
- **Webhook Latency:** ~180ms–250ms TTFB ACK latency just to wake up the execution engine.

**`n8n-to-fastify` eliminates the runtime interpreter completely.**

| Metric | Traditional n8n Container | Compiled Fastify Microservice | Improvement |
| :--- | :--- | :--- | :--- |
| **Webhook ACK Latency (TTFB)** | ~180ms – 250ms | **< 5 ms** | **~40x faster** |
| **Subworkflow Invocation** | ~300ms – 500ms (DB + IPC) | **< 0.05 ms** (In-memory call) | **~6,000x faster** |
| **RAM Consumption** | > 1.2 GB | **~25 MB** | **~98% RAM reduction** |
| **Circular Dependency Safety** | Runtime crash / infinite loop | **Fail-fast at build-time** | 100% deterministic |

---

## ✨ Key Architectural Features

### 1. In-Memory Subworkflow Transpilation (`Execute Workflow`)
Unlike naive transpilers that only convert single flat workflows, `n8n-to-fastify` parses an entire directory of workflows, registers them into an in-memory `WorkflowRegistry`, and compiles `Execute Workflow` nodes into **direct async TypeScript function calls**. Cross-workflow communication happens in microseconds with zero HTTP hops and zero database locking.

### 2. Strict DAG Topological Sorting & Cycle Detection
Using a Kahn-inspired topological sorter, the compiler validates your visual graph before emitting a single line of code. Circular dependencies fail immediately at CI/CD build-time rather than causing silent infinite loops in production.

### 3. Native Expression Transpiler
n8n expressions like `={{ $json.customer.email }}`, `={{ $('Webhook').item.json.token }}`, and `={{ $env.API_KEY }}` are compiled into safe native JavaScript with deep optional chaining (`?.`).

---

## 🚀 Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/rogeriomaciel/n8n-to-fastify.git
cd n8n-to-fastify

# 2. Install dependencies with Bun
bun install

# 3. Compile the included examples (Main Workflow + Subworkflow)
bun run compile ./examples --out ./compiled-service

# 4. Run the generated Fastify microservice
cd compiled-service
bun install
bun run start
```

Test the compiled endpoint (with subworkflow validation, IF branching, and JSON response):

```bash
# Valid payload -> 200 OK (< 5ms)
curl -X POST http://localhost:3000/webhook/lead-intake \
  -H "Content-Type: application/json" \
  -d '{"name": "Ada Lovelace", "email": "ada@analyticalengine.org"}'

# Invalid email -> 400 Bad Request
curl -X POST http://localhost:3000/webhook/lead-intake \
  -H "Content-Type: application/json" \
  -d '{"name": "Invalid", "email": "not-an-email"}'
```

> Unexpected workflow exceptions return a generic HTTP `500` response with a generated `errorId`, which is recorded in the server error log for correlation without leaking internal exception details.

---

## 🔐 Runtime Environment

Place a `.env` file in the generated service directory and run `bun run start` from that directory (Bun loads `.env` automatically at runtime). In both expressions and `Code` nodes, read variables with `$env.MY_VARIABLE` or `$env["MY_VARIABLE"]`. Always keep `.env` out of version control.

---

## 🧩 Supported Nodes (v0.1)

| n8n Node | Compiled Native Behavior |
| :--- | :--- |
| **Webhook** | Native Fastify route handler (`GET`, `POST`, `PUT`, `DELETE`, `ALL`) |
| **Respond to Webhook** | `reply.code(status).send(payload)` with JSON/Text support |
| **Code / Function** | Native async JavaScript execution with `$input`, `$json`, `$env`, and `$('Node')` bindings |
| **Code on Error** | JavaScript Code running once for all items can emit `json.error` through its regular output |
| **Disabled nodes** | Skips detached nodes and passes a single main input through to output 0 |
| **Execute Workflow** | Direct in-memory function invocation via `WorkflowRegistry` |
| **IF** | Routes each item to its true or false output |
| **Filter** | Deterministic branch tracking |
| **Switch** | Routes each item by rule or output-index expression, with configurable fallback in rules mode |
| **Set / Edit Fields** | Manual assignments, v3.4 JSON Output, dot-notation, `keepOnlySet`, and binary preservation |
| **HTTP Request** | Native `fetch()` with JSON headers and JSON or multipart form bodies |
| **HTTP Request on Error** | v4.2 can route failed items to the error output with their input JSON, original item index, and a safe error summary |
| **Aggregate** | In-memory item aggregation |
| **Split Out** | Expands nested arrays into individual `N8nItem[]` items |
| **Merge** | Appends branches or combines items by position across up to ten destination ports |
| **PostgreSQL** | Parameterized SQL execution via `DATABASE_URL` |
| **RabbitMQ** | Publish messages to an existing exchange (`RABBITMQ_URL`) |
| **RabbitMQ Trigger** | Consume a queue and acknowledge delivery after successful execution |
| **S3** | Downloads files into binary items from an S3-compatible endpoint |
| **Convert to File** | Converts all input items into a single UTF-8 JSON binary file |
| **Compression** | Decompresses inline ZIP and GZIP binary fields with anti-Zip-Bomb & path-traversal limits |
| **OpenAI / Gemini LLM** | Native `fetch()` completion calls via `OPENAI_API_KEY` |
| **Wait** | In-process time intervals with version-specific defaults and runtime expressions |
| **Stop and Error** | Stops an active workflow path with a message or structured error |
| **Stop and Error** | Stops an active workflow path with a message or structured error |

> Legacy `$node["Node name"]` references in a `Code` node running once for all items read the first item from the connected output (`.json`, legacy `.data` alias, and `.binary` metadata).
>
> Compiled polling loops support a single-entry cycle with one timed `Wait` and one `IF` or `Switch` retry port; completed batches continue after the cycle and direct `Stop and Error` exits fail immediately. Set `N8N_TO_FASTIFY_POLL_MAX_ATTEMPTS` at runtime to override the default limit of `100` attempts per batch.

---

## 📦 Code Node Dependencies

`Code` nodes can import built-in Node.js modules directly (e.g. `require('node:path')`). For third-party npm packages, pass a JSON file mapping package names to versions via `--dependencies`:

```json
{ "@supabase/supabase-js": "^2.0.0" }
```

```bash
bun run compile ./workflows --out ./compiled-service --dependencies ./workflow-dependencies.json
cd compiled-service
bun install
bun run start
```

The compiler merges these entries into the generated `package.json`. Declare every third-party package the workflow may load, including packages resolved dynamically via `require()` or `import()`.

---

## 🧪 Tests & Reproducible Benchmark

```bash
# Run unit + E2E HTTP integration tests
bun test

# Run 1,000-request TCP loopback benchmark (Main Webhook + Subworkflow + IF + Set)
bun run benchmark
```

Measured output:
- **Compilation Time:** ~2.77 ms
- **Avg Latency:** ~0.53 ms (`p95`: ~0.74 ms)
- **Throughput:** ~1,885 req/s

---

## 🏗️ Visual-to-Bare-Metal CI/CD Pattern

```mermaid
flowchart LR
    A[Visual n8n in Staging] -->|Export & PR| B[GitHub Actions CI]
    B -->|n8n-to-fastify compile| C[Standalone Fastify TypeScript]
    C -->|Deploy| D[Production Bare-Metal / Docker]
```

1. **Staging:** Build and iterate visually in n8n.
2. **Pull Request:** Export workflow `.json` files into your repository.
3. **CI/CD:** Run `n8n-to-fastify compile ./workflows --out ./dist`.
4. **Production:** Deploy pure Node.js/Bun containers with zero n8n runtime overhead.

---

## 🔍 Workflow Execution Traces

Set `N8N_TO_FASTIFY_TRACE=1` when running the generated service to emit one JSON line per node event (`schemaVersion: 1`) with `executionId`, `workflowId`, `nodeId`, `nodeName`, and `status` (`started`, `completed`, `skipped`, or `error`). Completed events include output ports and item counts; completed and error events include `durationMs`.

Traces are disabled by default and record execution metadata only (no payloads or error details). Hosts invoking compiled workflows directly can also pass a custom trace sink to `WorkflowContext`.

---

## 🛡️ Strict Compatibility Checks

```bash
bun run compile ./workflows --strict --out ./compiled-service
```

In `--strict` mode, the CLI validates workflows and stops before writing output if it detects known unsupported features: unsupported node types, non-`main` connections, disabled nodes, unsupported error handling (`continueOnFail` / `onError`), unsupported `HTTP Request` or `Edit Fields` (`raw`) options, or `Merge` (`combine`) with more than two inputs. Place only workflow exports in the input directory, as invalid JSON or non-workflow JSON files also fail compilation in strict mode.

Passing `--strict` means no known compatibility issues were detected; always validate runtime behavior against representative n8n runs.

---

## 🐇 RabbitMQ Publisher

The compiler supports the RabbitMQ **Send Message** operation in **Exchange** mode with default options (`typeVersion` 1 and 1.1). Declare and bind the exchange before starting the service, and set `RABBITMQ_URL` to the broker's AMQP or AMQPS connection URL at runtime. The generated `package.json` includes `amqplib` automatically when a workflow uses this node.

The publisher evaluates the exchange and routing key using the first input item, publishes one JSON message per item, waits for broker confirmation, and returns the n8n `{ success }` output shape.

## 🐇 RabbitMQ Trigger

The compiler supports RabbitMQ Trigger v1 with `executionFinishesSuccessfully` using the same `RABBITMQ_URL`. The generated service checks (or optionally declares via `assertQueue`) and binds the queue, limits unacknowledged deliveries with `parallelMessages`, and skips disabled triggers.

Each delivery triggers the branch with message fields, properties, and text (or parsed JSON when `jsonParseBody` is enabled), acknowledging after success, requeuing on failure, and draining in-flight executions on `SIGINT`/`SIGTERM`.

---

## 🪣 S3 Downloads

The compiler supports `File / Download` from S3 node v1. Set `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` at runtime (optional `AWS_REGION`, defaulting to `us-east-1`, and `AWS_SESSION_TOKEN`). Path-style addressing is enabled by default; set `S3_FORCE_PATH_STYLE=false` for virtual-hosted addressing.

Each object is downloaded in order and stored as base64 under the configured binary property (`data` by default), preserving input JSON and other binary fields. The generated `package.json` includes `@aws-sdk/client-s3` and `mime-types` automatically when a workflow uses this node.

## 📤 HTTP Request Multipart

`HTTP Request` supports multipart text fields and n8n binary-file fields for `POST`, `PUT`, and `PATCH`. Binary fields read inline base64 data from the selected binary property and preserve file name and MIME type; the runtime removes manual `content-type` and `content-length` headers so `FormData` computes the boundary automatically.

With `Send Headers` enabled, `specifyHeaders: 'json'` accepts either a JSON string or an object of header names and values.

---

## 📚 Architecture Guides & Deep Dives

If you are evaluating or running `n8n-to-fastify` in production, these engineering notes document the design decisions behind the compiler:

- **[Solving n8n Out-of-Memory (OOM) Crashes with Compiled Services](https://rogeriomaciel.com.br/en/solutions/n8n-out-of-memory-oom-solution/)** — Why visual execution trees exhaust RAM under webhook spikes and how compiled Fastify workers cut memory overhead.
- **[Compiling n8n RabbitMQ Triggers & Publishers with Post-Success Ack](https://rogeriomaciel.com.br/en/solutions/compile-n8n-rabbitmq-ack-after-success/)** — Preserving at-least-once delivery semantics, deferred `ack`/`nack`, and exchange-mode routing.
- **[Redacting Uncaught Webhook Errors & Opt-In Structured Tracing](https://rogeriomaciel.com.br/en/solutions/redact-webhook-errors-structured-tracing-fastify/)** — Keeping HTTP error responses safe at the edge while emitting JSON execution traces internally.
- **[Preserving Binary Data, S3 Downloads & Multipart Uploads](https://rogeriomaciel.com.br/en/solutions/preserve-binary-data-s3-multipart-compiled-workflows/)** — Handling S3 file downloads, `Edit Fields` binary preservation, and multipart `FormData` without OOM bloat.
- **[Strict Compatibility Checks & Per-Item IF/Switch Routing](https://rogeriomaciel.com.br/en/solutions/strict-workflow-compatibility-checks-deterministic-routing/)** — Failing fast at compile time with `--strict`, deterministic item branching, and bounded loops.
- **[GitOps & CI/CD Versioning for n8n Workflows](https://rogeriomaciel.com.br/en/solutions/gitops-cicd-n8n-production/)** — Turning `.json` workflow exports into repeatable CI-compiled TypeScript services.

---

## 👤 Author & Enterprise Migration Consulting

Built by **[Rogério Maciel](https://rogeriomaciel.com.br/en/)** — Software Architect (20+ years in production systems, Ex-Head at Neoway, Ex-CTO).

Need help migrating high-volume n8n infrastructure (50+ workflows, custom database connectors, Prometheus telemetry, Kubernetes CI/CD) to bare-metal Fastify? Reach out via [GitHub](https://github.com/rogeriomaciel) or [rogeriomaciel.com.br](https://rogeriomaciel.com.br/en/).

---

## 📄 License

MIT © [Rogério Maciel](LICENSE)
