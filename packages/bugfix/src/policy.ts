import fs from 'node:fs';

export type ModelRef = 'inherit' | `${string}/${string}`;
export interface NodePolicy { configuredRef: ModelRef; source: 'runtime-default' | 'project-file'; }
export interface ModelPolicy { version: 1; defaultRef: ModelRef; nodes: Record<'investigate'|'implement'|'verify', NodePolicy>; path?: string; }
const NODES = ['investigate', 'implement', 'verify'] as const;

function validRef(value: unknown): value is ModelRef {
  return value === 'inherit' || (typeof value === 'string' && /^[^/]+\/[^/]+$/.test(value));
}
export function loadModelPolicy(path: string): ModelPolicy {
  const defaults = { investigate: 'smartingredients/gpt-5.6-sol', implement: 'inherit', verify: 'inherit' } as Record<typeof NODES[number], ModelRef>;
  if (!fs.existsSync(path)) return { version: 1, defaultRef: 'inherit', nodes: Object.fromEntries(NODES.map(n => [n, { configuredRef: defaults[n], source: 'runtime-default' }])) as ModelPolicy['nodes'] };
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { throw Error(`invalid workflow model policy JSON: ${path}`); }
  if (!raw || raw.version !== 1 || (raw.default !== undefined && !validRef(raw.default)) || (raw.nodes !== undefined && (typeof raw.nodes !== 'object' || raw.nodes === null || Array.isArray(raw.nodes)))) throw Error(`invalid workflow model policy schema/version: ${path}`);
  const defaultRef: ModelRef = raw.default ?? 'inherit';
  if (raw.nodes) {
    for (const key of Object.keys(raw.nodes)) {
      if (!(NODES as readonly string[]).includes(key)) throw Error(`unknown workflow model node ${key}: ${path}`);
    }
  }
  for (const node of NODES) if (raw.nodes?.[node] !== undefined && !validRef(raw.nodes[node])) throw Error(`invalid workflow model ref for ${node}: ${path}`);
  return { version: 1, defaultRef, path, nodes: Object.fromEntries(NODES.map(n => [n, { configuredRef: raw.nodes?.[n] ?? defaultRef, source: raw.nodes?.[n] !== undefined || raw.default !== undefined ? 'project-file' : 'runtime-default' }])) as ModelPolicy['nodes'] };
}
export function parseBugFixCommand(args: string): { valid: boolean; problem?: string; usage?: string } {
  const text = args.trim();
  const usage = 'usage: /bugFix <问题描述>';
  if (!text || /^(?:start|resume|decision)(?:\s|$)/.test(text)) return { valid: false, usage };
  return { valid: true, problem: text };
}
export function resolveModelRef(ref: ModelRef, inherited: any, registry: any): any {
  if (ref === 'inherit') { if (!inherited) throw Error('model policy inherit requires ctx.model'); return inherited; }
  const [provider, id] = ref.split('/');
  const model = registry?.find?.(provider, id);
  if (!model) throw Error(`model not found: ${ref}`);
  return model;
}
