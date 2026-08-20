import fs from 'node:fs';

export type ModelRef = 'inherit' | `${string}/${string}`;
type NodeId = 'investigate' | 'implement' | 'verify';
type RawNodePolicy = ModelRef | { model: ModelRef; skills?: string[] };

export interface NodePolicy {
  configuredRef: ModelRef;
  skills: string[];
  source: 'runtime-default' | 'project-file';
}

export interface ModelPolicy {
  version: 1;
  defaultRef: ModelRef;
  nodes: Record<NodeId, NodePolicy>;
  path?: string;
}

const NODES = ['investigate', 'implement', 'verify'] as const;
const DEFAULTS: Record<NodeId, NodePolicy> = {
  investigate: { configuredRef: 'smartingredients/gpt-5.6-sol', skills: [], source: 'runtime-default' },
  implement: { configuredRef: 'inherit', skills: [], source: 'runtime-default' },
  verify: { configuredRef: 'inherit', skills: [], source: 'runtime-default' },
};

function validRef(value: unknown): value is ModelRef {
  return value === 'inherit' || (typeof value === 'string' && /^[^/]+\/[^/]+$/.test(value));
}

function validSkills(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((skill) => typeof skill === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(skill))
    && new Set(value).size === value.length;
}

function parseNodePolicy(value: unknown, fallback: ModelRef): { model: ModelRef; skills: string[] } | undefined {
  if (value === undefined) return { model: fallback, skills: [] };
  if (validRef(value)) return { model: value, skills: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const node = value as Record<string, unknown>;
  if (!validRef(node.model) || (node.skills !== undefined && !validSkills(node.skills))) return undefined;
  if (Object.keys(node).some((key) => key !== 'model' && key !== 'skills')) return undefined;
  return { model: node.model, skills: node.skills ?? [] };
}

export function loadModelPolicy(path: string): ModelPolicy {
  if (!fs.existsSync(path)) {
    return {
      version: 1,
      defaultRef: 'inherit',
      nodes: { ...DEFAULTS },
    };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    throw Error(`invalid workflow model policy JSON: ${path}`);
  }
  if (!raw || raw.version !== 1 || (raw.default !== undefined && !validRef(raw.default)) || (raw.nodes !== undefined && (typeof raw.nodes !== 'object' || raw.nodes === null || Array.isArray(raw.nodes)))) {
    throw Error(`invalid workflow model policy schema/version: ${path}`);
  }

  const rawNodes = (raw.nodes ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(rawNodes)) {
    if (!(NODES as readonly string[]).includes(key)) throw Error(`unknown workflow model node ${key}: ${path}`);
  }

  const defaultRef = (raw.default ?? 'inherit') as ModelRef;
  const nodes = Object.fromEntries(NODES.map((nodeId) => {
    const parsed = parseNodePolicy(rawNodes[nodeId], defaultRef);
    if (!parsed) throw Error(`invalid workflow node policy for ${nodeId}: ${path}`);
    const configured = rawNodes[nodeId] !== undefined || raw.default !== undefined;
    return [nodeId, {
      configuredRef: parsed.model,
      skills: parsed.skills,
      source: configured ? 'project-file' : 'runtime-default',
    }];
  })) as ModelPolicy['nodes'];

  return { version: 1, defaultRef, nodes, path };
}

export function parseBugFixCommand(args: string): { valid: boolean; problem?: string; usage?: string } {
  const text = args.trim();
  const usage = 'usage: /bugFix <问题描述>';
  if (!text || /^(?:start|resume|decision)(?:\s|$)/.test(text)) return { valid: false, usage };
  return { valid: true, problem: text };
}

export function resolveModelRef(ref: ModelRef, inherited: any, registry: any): any {
  if (ref === 'inherit') {
    if (!inherited) throw Error('model policy inherit requires ctx.model');
    return inherited;
  }
  const [provider, id] = ref.split('/');
  const model = registry?.find?.(provider, id);
  if (!model) throw Error(`model not found: ${ref}`);
  return model;
}
