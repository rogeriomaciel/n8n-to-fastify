import fs from 'node:fs';
import path from 'node:path';
import type { CommunityAdapter } from '../src/compiler/community-adapters';

export interface AdapterFile extends CommunityAdapter {
  source: string;
  dependencies: Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateDependencies(input: unknown, source: string): Record<string, string> {
  if (!isObject(input)) throw new Error(`Expected a JSON object mapping npm package names to versions in ${source}.`);
  for (const [name, version] of Object.entries(input)) {
    if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) || typeof version !== 'string' || !version.trim()) {
      throw new Error(`Invalid npm dependency entry '${name}' in ${source}.`);
    }
  }
  return input as Record<string, string>;
}

export function readAdapterFiles(filePath: string): AdapterFile[] {
  const input: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!isObject(input) || input.schemaVersion !== 1 || !Array.isArray(input.adapters)) {
    throw new Error('Expected a community adapter manifest with schemaVersion 1 and an adapters array.');
  }
  const seen = new Set<string>();
  return input.adapters.map((entry: unknown, index: number) => {
    const label = `adapter ${index + 1}`;
    if (!isObject(entry)) throw new Error(`Expected an object for ${label}.`);
    const { type, typeVersion, module, parameters = [], handlesRetries = false, dependencies = {} } = entry;
    if (typeof type !== 'string' || !/^[\w@][\w@/.-]*\.[a-z][\w-]*$/i.test(type) ||
        type.startsWith('n8n-nodes-base.') || type.startsWith('@n8n/n8n-nodes-langchain.')) {
      throw new Error(`Expected a community node type for ${label}.`);
    }
    if (typeof typeVersion !== 'number' || !Number.isFinite(typeVersion) || typeVersion <= 0) {
      throw new Error(`Expected a positive node typeVersion for ${label}.`);
    }
    const key = `${type}@${typeVersion}`;
    if (seen.has(key)) throw new Error(`Multiple community adapters registered for ${key}.`);
    seen.add(key);
    if (typeof module !== 'string' || !/\.(?:mjs|ts)$/.test(module)) {
      throw new Error(`Expected a .mjs or .ts adapter module for ${label}.`);
    }
    if (!Array.isArray(parameters) || parameters.some(name => typeof name !== 'string' || !name) ||
        new Set(parameters).size !== parameters.length || typeof handlesRetries !== 'boolean') {
      throw new Error(`Expected unique parameter names and a boolean handlesRetries for ${label}.`);
    }
    return {
      type, typeVersion, parameters, handlesRetries,
      binding: `communityAdapter${index}`, fileName: `adapter-${index}${path.extname(module)}`,
      source: fs.readFileSync(path.resolve(path.dirname(filePath), module), 'utf8'),
      dependencies: validateDependencies(dependencies, label),
    };
  });
}

export function withAdapterDependencies(packageJson: string, adapters: ReadonlySet<AdapterFile>): string {
  if (adapters.size === 0) return packageJson;
  const manifest = JSON.parse(packageJson);
  for (const adapter of adapters) {
    for (const [name, version] of Object.entries(adapter.dependencies)) {
      if (Object.hasOwn(manifest.dependencies, name) && manifest.dependencies[name] !== version) {
        throw new Error(`Conflicting generated dependency '${name}' for adapter ${adapter.type}@${adapter.typeVersion}.`);
      }
      manifest.dependencies[name] = version;
    }
  }
  return JSON.stringify(manifest, null, 2);
}
