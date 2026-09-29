import * as path from "node:path";
import { collectRawAgentCandidates, type AgentConfig, type AgentScope, type RawAgentCandidate, type RawAgentCollectionOptions } from "./agents.ts";

export interface CanonicalProvenance {
  source: "user" | "project";
  discoveryRootRealpath: string;
  fileRealpath: string;
  digest: string;
}

export interface ResolvedAgent extends AgentConfig {
  provenance: CanonicalProvenance;
}

export interface AgentResolution {
  state: "resolved" | "paused_configuration";
  requestedTarget: string;
  agent?: ResolvedAgent;
  reason?: string;
  rawCandidates: number;
  shadowedCandidates: number;
}

interface ResolutionAuditCandidate {
  status: "invalid" | "shadowed" | "effective" | "winner";
  source: "user" | "project";
  declaredPath: string;
  discoveryRootRealpath: string;
  name?: string;
  aliases?: string[];
  provenance?: CanonicalProvenance;
  invalidReason?: string;
}
interface InternalAgentResolution extends AgentResolution { audit: { candidates: ResolutionAuditCandidate[]; invalidReasons: string[]; effective: ResolutionAuditCandidate[]; winner?: ResolutionAuditCandidate }; }

function list(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function normalized(value: string): string { return value.toLocaleLowerCase("en-US"); }
function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function candidateToAgent(candidate: RawAgentCandidate): ResolvedAgent | undefined {
  if (candidate.invalidReason) return undefined;
  const frontmatter = candidate.frontmatter;
  if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") return undefined;
  const aliases = list(frontmatter.aliases);
  if (aliases.some((alias) => alias.length === 0)) return undefined;
  const fileRealpath = candidate.fileRealpath; const digest = candidate.fileDigest;
  if (!fileRealpath || !digest || !inside(fileRealpath, candidate.discoveryRoot)) return undefined;
  const base: AgentConfig = {
    name: frontmatter.name,
    description: frontmatter.description,
    tools: list(frontmatter.tools),
    model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
    fallbackModels: list(frontmatter["fallback-models"]),
    persistent: typeof frontmatter.persistent === "boolean" ? frontmatter.persistent : undefined,
    codexFast: typeof frontmatter.codexFast === "string" ? frontmatter.codexFast : undefined,
    aliases,
    systemPrompt: candidate.body,
    source: candidate.source,
    filePath: candidate.declaredPath,
    discoveryRootRealpath: candidate.discoveryRoot,
    fileRealpath,
    digest,
  };
  return { ...base, provenance: { source: candidate.source, discoveryRootRealpath: candidate.discoveryRoot, fileRealpath, digest } };
}

function duplicateReason(candidates: readonly ResolvedAgent[]): string | undefined {
  const canonical = new Map<string, ResolvedAgent>();
  const names = new Map<string, { owner: ResolvedAgent; kind: "canonical" | "alias" }>();
  for (const candidate of candidates) {
    const canonicalKey = normalized(candidate.name);
    const previousCanonical = canonical.get(canonicalKey);
    if (previousCanonical) return `duplicate canonical agent: ${candidate.name}`;
    canonical.set(canonicalKey, candidate);
    const entries = [{ value: candidate.name, kind: "canonical" as const }, ...(candidate.aliases ?? []).map((value) => ({ value, kind: "alias" as const }))];
    for (const entry of entries) {
      const key = normalized(entry.value);
      const previous = names.get(key);
      if (previous) return `agent name conflict: ${entry.value} (${previous.kind}/${entry.kind})`;
      names.set(key, { owner: candidate, kind: entry.kind });
    }
  }
  return undefined;
}

/** Resolve only after raw trust checks and project-over-user shadowing. */
export function resolveRawAgentCandidates(requestedTarget: string, rawCandidates: readonly RawAgentCandidate[], invalidReasons: readonly string[] = []): AgentResolution {
  if (typeof requestedTarget !== "string" || requestedTarget.length === 0) return { state: "paused_configuration", requestedTarget: String(requestedTarget), reason: "requested target is invalid", rawCandidates: rawCandidates.length, shadowedCandidates: 0 };
  const resolved = rawCandidates.map(candidateToAgent);
  if (resolved.some((candidate) => !candidate)) return { state: "paused_configuration", requestedTarget, reason: "raw agent candidate is invalid or trust cannot be proven", rawCandidates: rawCandidates.length, shadowedCandidates: 0 };
  if (invalidReasons.length > 0) return { state: "paused_configuration", requestedTarget, reason: invalidReasons[0], rawCandidates: rawCandidates.length, shadowedCandidates: 0 };
  const valid = resolved as ResolvedAgent[];
  const projectNames = new Set(valid.filter((candidate) => candidate.source === "project").map((candidate) => normalized(candidate.name)));
  const effective = valid.filter((candidate) => candidate.source === "project" || !projectNames.has(normalized(candidate.name)));
  const shadowedCandidates = valid.length - effective.length;
  const conflict = duplicateReason(effective);
  if (conflict) return { state: "paused_configuration", requestedTarget, reason: conflict, rawCandidates: rawCandidates.length, shadowedCandidates };
  const matches = effective.filter((candidate) => candidate.name === requestedTarget || (candidate.aliases ?? []).includes(requestedTarget));
  if (matches.length !== 1) return { state: "paused_configuration", requestedTarget, reason: matches.length === 0 ? "unknown agent target" : "agent target is ambiguous", rawCandidates: rawCandidates.length, shadowedCandidates };
  return { state: "resolved", requestedTarget, agent: matches[0], rawCandidates: rawCandidates.length, shadowedCandidates };
}

function buildAudit(requestedTarget: string, result: AgentResolution, candidates: readonly RawAgentCandidate[], invalidReasons: readonly string[]): InternalAgentResolution["audit"] {
  const valid = candidates.map((candidate) => ({ candidate, agent: candidateToAgent(candidate) }));
  const projectNames = new Set(valid.filter((item) => item.agent?.source === "project").map((item) => normalized(item.agent!.name)));
  const audit: ResolutionAuditCandidate[] = valid.map(({ candidate, agent }) => {
    if (!agent) return { status: "invalid" as const, source: candidate.source, declaredPath: candidate.declaredPath, discoveryRootRealpath: candidate.discoveryRoot, invalidReason: candidate.invalidReason ?? "candidate failed canonical trust or parse" , ...(candidate.fileRealpath && candidate.fileDigest ? { provenance: { source: candidate.source, discoveryRootRealpath: candidate.discoveryRoot, fileRealpath: candidate.fileRealpath, digest: candidate.fileDigest } } : {}) };
    const shadowed = agent.source === "user" && projectNames.has(normalized(agent.name));
    return { status: shadowed ? "shadowed" as const : "effective" as const, source: agent.source, declaredPath: candidate.declaredPath, discoveryRootRealpath: candidate.discoveryRoot, name: agent.name, aliases: agent.aliases ?? [], provenance: agent.provenance };
  });
  const effective = audit.filter((entry) => entry.status === "effective");
  if (result.agent) { const winner = audit.find((entry) => entry.name === result.agent!.name && entry.provenance?.digest === result.agent!.provenance.digest); if (winner) winner.status = "winner"; }
  return { candidates: audit, invalidReasons: [...invalidReasons], effective, winner: audit.find((entry) => entry.status === "winner") };
}

export function resolveAgentWithAudit(cwd: string, scope: AgentScope, requestedTarget: string, options: RawAgentCollectionOptions = {}): InternalAgentResolution {
  const collected = collectRawAgentCandidates(cwd, scope, options);
  const result = resolveRawAgentCandidates(requestedTarget, collected.candidates, collected.invalidReasons);
  return { ...result, audit: buildAudit(requestedTarget, result, collected.candidates, collected.invalidReasons) };
}

export function resolveAgent(cwd: string, scope: AgentScope, requestedTarget: string, options: RawAgentCollectionOptions = {}): AgentResolution {
  const result = resolveAgentWithAudit(cwd, scope, requestedTarget, options); const { audit: _audit, ...safe } = result; return safe;
}

/** Safe summary intentionally excludes task, cwd, prompt, file path and raw provenance paths. */
export function projectResolvedAgent(agent: ResolvedAgent): Record<string, unknown> {
  return { name: agent.name, source: agent.source, aliases: agent.aliases ?? [], digest: agent.provenance.digest.slice(0, 16) };
}
