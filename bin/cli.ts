#!/usr/bin/env bun
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkflowParser } from '../src/compiler/parser';
import { CodeGenerator } from '../src/compiler/code-generator';
import { getCompatibilityIssues } from '../src/compiler/compatibility';
import { RouteGenerator } from '../src/compiler/route-generator';
import { selectCommunityAdapters } from '../src/compiler/community-adapters';
import { readAdapterFiles, validateDependencies, withAdapterDependencies, type AdapterFile } from './community-adapter-files';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

function readDependencies(filePath: string): Record<string, string> {
  return validateDependencies(JSON.parse(fs.readFileSync(filePath, 'utf8')), JSON.stringify(filePath));
}

program
  .name('n8n-to-fastify')
  .description('Ahead-Of-Time (AOT) compiler that transpiles n8n workflows into bare-metal Fastify microservices')
  .version('0.2.0');

const compile = program
  .command('compile')
  .description('Compile a single workflow.json or a directory of workflows into a standalone Fastify project')
  .argument('<input>', 'Path to a workflow .json file or directory of workflows')
  .option('-o, --out <dir>', 'Output directory for the generated microservice', './compiled-service')
  .option('--dependencies <file>', 'JSON file mapping npm package names to versions for the generated service')
  .option('--adapters <file>', 'JSON manifest for local community node adapters')
  .option('--strict', 'Reject known unsupported workflow features before generating output')
  .action((input: string, options: { out: string; dependencies?: string; adapters?: string; strict?: boolean }) => {
    let dependencies: Record<string, string> | undefined;
    try {
      dependencies = options.dependencies ? readDependencies(options.dependencies) : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      program.error(`[n8n-to-fastify] Cannot load dependencies: ${message}`);
    }
    let adapters: AdapterFile[] = [];
    try {
      adapters = options.adapters ? readAdapterFiles(options.adapters) : [];
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      program.error(`[n8n-to-fastify] Cannot load community adapters: ${message}`);
    }

    const startTime = performance.now();
    const outDir = path.resolve(options.out);

    console.log(`\n⚡ [n8n-to-fastify] Parsing workflows from: ${path.resolve(input)}`);

    const workflows = WorkflowParser.parseInput(input, { failOnParseError: options.strict });
    if (workflows.length === 0) {
      console.error('❌ No valid n8n workflows found.');
      process.exit(1);
    }

    if (options.strict) {
      const issues = workflows.flatMap(workflow => getCompatibilityIssues(workflow, adapters));
      if (issues.length > 0) {
        program.error(`[n8n-to-fastify] Strict compatibility check failed.\n${issues.map(issue => `  - ${issue}`).join('\n')}`);
      }
    }

    const usedAdapters = new Set(workflows.flatMap(workflow => [...selectCommunityAdapters(workflow, adapters).values()]));
    let packageJson = RouteGenerator.generateOutputPackageJson(workflows, dependencies);
    try {
      packageJson = withAdapterDependencies(packageJson, usedAdapters);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      program.error(`[n8n-to-fastify] Cannot configure community adapters: ${message}`);
    }

    // Prepare output directories
    const workflowsOutDir = path.join(outDir, 'workflows');
    const routesOutDir = path.join(outDir, 'routes');
    const runtimeOutDir = path.join(outDir, 'runtime');

    fs.mkdirSync(workflowsOutDir, { recursive: true });
    fs.mkdirSync(routesOutDir, { recursive: true });
    fs.mkdirSync(runtimeOutDir, { recursive: true });

    // Copy runtime files
    const srcRuntimeDir = path.resolve(__dirname, '../src/runtime');
    for (const file of fs.readdirSync(srcRuntimeDir)) {
      if (file.endsWith('.ts')) {
        fs.copyFileSync(path.join(srcRuntimeDir, file), path.join(runtimeOutDir, file));
      }
    }
    if (usedAdapters.size > 0) {
      const adapterOutDir = path.join(runtimeOutDir, 'adapters');
      fs.mkdirSync(adapterOutDir, { recursive: true });
      for (const adapter of usedAdapters) {
        fs.writeFileSync(path.join(adapterOutDir, adapter.fileName), adapter.source, 'utf8');
      }
    }

    // Compile each workflow
    for (const wf of workflows) {
      const targetPath = path.join(workflowsOutDir, wf.relativePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      const code = CodeGenerator.generateWorkflowCode(wf, adapters);
      fs.writeFileSync(targetPath, code, 'utf8');
      console.log(`  ✓ Compiled: ${wf.name} -> workflows/${wf.relativePath}`);
    }

    // Generate Fastify routes, server entry, and package.json
    fs.writeFileSync(
      path.join(routesOutDir, 'index.ts'),
      RouteGenerator.generateRoutesCode(workflows),
      'utf8'
    );
    fs.writeFileSync(path.join(outDir, 'server.ts'), RouteGenerator.generateServerEntry(workflows), 'utf8');
    fs.writeFileSync(path.join(outDir, 'package.json'), packageJson, 'utf8');

    const elapsedMs = (performance.now() - startTime).toFixed(2);
    console.log(`\n🚀 Compilation finished in ${elapsedMs}ms!`);
    console.log(`📁 Output ready at: ${outDir}\n`);
    console.log(`Next steps:`);
    console.log(`  cd ${options.out}`);
    console.log(`  bun install`);
    console.log(`  bun run start\n`);
  });

program.parse();
