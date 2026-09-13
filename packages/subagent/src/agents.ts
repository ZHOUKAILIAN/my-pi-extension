import * as fs from "node:fs";
import * as path from "node:path";
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
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
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

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
  const listed = agents.slice(0, maxItems);
  return {
    text: listed.length === 0 ? "none" : listed.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("; "),
    remaining: Math.max(0, agents.length - listed.length),
  };
}
