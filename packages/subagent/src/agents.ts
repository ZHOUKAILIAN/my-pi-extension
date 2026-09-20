import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readStableOwnerFileSync, trustedDirectorySync } from "./secure-fs.ts";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  fallbackModels?: string[];
  persistent?: boolean;
  codexFast?: string;
  aliases?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
  discoveryRootRealpath?: string;
  fileRealpath?: string;
  digest?: string;
}

export interface RawAgentCandidate {
  source: "user" | "project";
  discoveryRoot: string;
  declaredPath: string;
  frontmatter: Record<string, unknown>;
  body: string;
  invalidReason?: string;
  fileRealpath?: string;
  fileDigest?: string;
  fileIno?: number;
  fileDev?: number;
}

export interface RawAgentCollection {
  candidates: RawAgentCandidate[];
  invalidReasons: string[];
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
}

type Frontmatter = Record<string, unknown>;

function list(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const result = values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return result.length > 0 ? result : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Frontmatter>(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: list(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      fallbackModels: list(frontmatter["fallback-models"]),
      persistent: boolean(frontmatter.persistent),
      codexFast: typeof frontmatter.codexFast === "string" ? frontmatter.codexFast : undefined,
      aliases: list(frontmatter.aliases),
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return agents;
}

function isDirectory(candidate: string): boolean {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const user = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const project = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
  const map = new Map<string, AgentConfig>();
  for (const agent of user) map.set(agent.name, agent);
  for (const agent of project) map.set(agent.name, agent);
  return { agents: Array.from(map.values()) };
}

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}


function rawCandidatesFromDir(root: string, source: "user" | "project", projectTrusted: boolean, invalidReasons: string[], expectedSnapshotDigest?: string, suppliedSnapshot?: AgentDiscoverySnapshot): RawAgentCandidate[] {
  let rootRealpath: string;
  try { const trusted = trustedDirectorySync(root); if (!trusted) throw new Error("agent discovery root trust cannot be proven"); rootRealpath = trusted.realpath; }
  catch { invalidReasons.push(source === "project" && !projectTrusted ? "project trust is unavailable" : `${source} agent root is unavailable or untrusted`); return []; }
  if (source === "project" && !projectTrusted) { invalidReasons.push("project agent root is not trusted"); return []; }
  const snapshotFailure = source === "project" && (!validAgentDiscoverySnapshot(suppliedSnapshot) || suppliedSnapshot.rootRealpath !== rootRealpath || (expectedSnapshotDigest !== undefined && suppliedSnapshot.digest !== expectedSnapshotDigest)) ? "project agent snapshot is missing, changed, or not trusted" : undefined;
  if (snapshotFailure) invalidReasons.push(snapshotFailure);
  type Entry = { name: string; isFile: boolean; isSymbolicLink: boolean; row?: AgentDiscoverySnapshotRow };
  let entries: Entry[];
  if (source === "project" && suppliedSnapshot && !snapshotFailure) entries = suppliedSnapshot.rows.map((row) => ({ name: row.name, isFile: true, isSymbolicLink: false, row }));
  else { try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".md")).map((entry) => ({ name: entry.name, isFile: entry.isFile(), isSymbolicLink: entry.isSymbolicLink() })); } catch { invalidReasons.push(`${source} agent root cannot be read`); return []; } }
  const candidates: RawAgentCandidate[] = [];
  for (const entry of entries) {
    const declaredPath = path.join(root, entry.name);
    const addInvalid = (reason: string, stable?: ReturnType<typeof readStableOwnerFileSync>, frontmatter: Record<string, unknown> = {}, body = "") => { invalidReasons.push(reason); candidates.push({ source, discoveryRoot: rootRealpath, declaredPath, frontmatter, body, invalidReason: reason, ...(stable ? { fileRealpath: stable.realpath, fileDigest: stable.digest, fileIno: stable.stat.ino, fileDev: stable.stat.dev } : {}) }); };
    if (!entry.isFile || entry.isSymbolicLink) { addInvalid(`${source} agent candidate is not a regular non-symlink file: ${entry.name}`); continue; }
    try {
      const stable = readStableOwnerFileSync(declaredPath);
      if (!stable || !inside(stable.realpath, rootRealpath)) { addInvalid(`${source} agent candidate trust failed: ${entry.name}`); continue; }
      if (entry.row && (stable.realpath !== entry.row.realpath || stable.digest !== entry.row.digest || stable.stat.ino !== entry.row.ino || stable.stat.dev !== entry.row.dev)) { addInvalid(`${source} agent candidate changed since snapshot: ${entry.name}`, stable); continue; }
      const { frontmatter, body } = parseFrontmatter<Frontmatter>(stable.content);
      const invalidReason = snapshotFailure ?? (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string" ? `${source} agent candidate has invalid frontmatter: ${entry.name}` : undefined);
      if (invalidReason) { addInvalid(invalidReason, stable, frontmatter, body); continue; }
      candidates.push({ source, discoveryRoot: rootRealpath, declaredPath, frontmatter, body, fileRealpath: stable.realpath, fileDigest: stable.digest, fileIno: stable.stat.ino, fileDev: stable.stat.dev });
    } catch { addInvalid(`${source} agent candidate cannot be trusted or parsed: ${entry.name}`); }
  }
  return candidates;
}

export interface AgentDiscoverySnapshotRow { name: string; realpath: string; digest: string; ino: number; dev: number; }
export interface AgentDiscoverySnapshot {
  rootRealpath: string;
  digest: string;
  rows: AgentDiscoverySnapshotRow[];
}

export function normalizeAgentDiscoverySnapshotRows(rows: readonly AgentDiscoverySnapshotRow[]): AgentDiscoverySnapshotRow[] { return [...rows].sort((a, b) => a.name.localeCompare(b.name)).map((row) => ({ name: row.name, realpath: row.realpath, digest: row.digest, ino: row.ino, dev: row.dev })); }
export function agentDiscoverySnapshotDigest(rows: readonly AgentDiscoverySnapshotRow[]): string { return createHash("sha256").update(JSON.stringify(normalizeAgentDiscoverySnapshotRows(rows))).digest("hex"); }
export function validAgentDiscoverySnapshot(value: unknown): value is AgentDiscoverySnapshot { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const snapshot = value as Record<string, unknown>; if (Object.keys(snapshot).some((key) => !["rootRealpath", "digest", "rows"].includes(key)) || typeof snapshot.rootRealpath !== "string" || !path.isAbsolute(snapshot.rootRealpath) || typeof snapshot.digest !== "string" || !/^[0-9a-f]{64}$/.test(snapshot.digest) || !Array.isArray(snapshot.rows)) return false; const rows = snapshot.rows as unknown[]; if (!rows.every((candidate) => { if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false; const row = candidate as Record<string, unknown>; return Object.keys(row).every((key) => ["name", "realpath", "digest", "ino", "dev"].includes(key)) && typeof row.name === "string" && row.name.length > 0 && typeof row.realpath === "string" && path.isAbsolute(row.realpath) && typeof row.digest === "string" && /^[0-9a-f]{64}$/.test(row.digest) && typeof row.ino === "number" && Number.isSafeInteger(row.ino) && row.ino >= 0 && typeof row.dev === "number" && Number.isSafeInteger(row.dev) && row.dev >= 0; })) return false; return snapshot.digest === agentDiscoverySnapshotDigest(rows as AgentDiscoverySnapshotRow[]); }

export interface RawAgentCollectionOptions {
  userRoot?: string;
  projectRoot?: string | null;
  projectTrusted?: boolean;
  projectSnapshotDigest?: string;
  projectSnapshot?: AgentDiscoverySnapshot;
}

function trustedRootRealpath(root: string): string | undefined { return trustedDirectorySync(root)?.realpath; }

/** Stable snapshot used by the parent trust confirmation; content is never exposed. */
export function getAgentDiscoverySnapshot(root: string): AgentDiscoverySnapshot | undefined {
  const rootRealpath = trustedRootRealpath(root);
  if (!rootRealpath) return undefined;
  try {
    const entries = fs.readdirSync(rootRealpath, { withFileTypes: true }).filter((entry) => entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
    const rows: AgentDiscoverySnapshotRow[] = [];
    for (const entry of entries) {
      const file = path.join(rootRealpath, entry.name);
      const stable = readStableOwnerFileSync(file);
      if (!stable || !inside(stable.realpath, rootRealpath)) return undefined;
      rows.push({ name: entry.name, realpath: stable.realpath, digest: stable.digest, ino: stable.stat.ino, dev: stable.stat.dev });
    }
    return { rootRealpath, digest: agentDiscoverySnapshotDigest(rows), rows };
  } catch { return undefined; }
}

/** Preserve raw candidates; resolver must not collapse by name before trust/shadow checks. */
export function collectRawAgentCandidates(cwd: string, scope: AgentScope, options: RawAgentCollectionOptions = {}): RawAgentCollection {
  const invalidReasons: string[] = [];
  const userRoot = options.userRoot ?? path.join(getAgentDir(), "agents");
  const projectRoot = options.projectRoot === undefined ? findNearestProjectAgentsDir(cwd) : options.projectRoot;
  const candidates: RawAgentCandidate[] = [];
  if (scope !== "project") candidates.push(...rawCandidatesFromDir(userRoot, "user", true, invalidReasons));
  if (scope !== "user" && projectRoot) {
    const snapshot = options.projectSnapshot ?? getAgentDiscoverySnapshot(projectRoot);
    candidates.push(...rawCandidatesFromDir(projectRoot, "project", options.projectTrusted === true, invalidReasons, options.projectSnapshotDigest, snapshot));
  }
  return { candidates, invalidReasons };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
  const listed = agents.slice(0, maxItems);
  return {
    text: listed.length === 0 ? "none" : listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
    remaining: Math.max(0, agents.length - listed.length),
  };
}
