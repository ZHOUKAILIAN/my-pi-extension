import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AttemptDiagnostics } from "./runner.ts";

export const IDENTITY_VERSION = "subagent-v1";

export interface SessionIdentityInput {
  parentSessionId: string;
  cwd: string;
  agentName: string;
  handle: string;
}

export interface SessionIdentity {
  key: string;
  parentSessionId: string;
  cwd: string;
  agentName: string;
  handle: string;
}

export interface SessionRegistry {
  version: 1;
  key: string;
  parentSessionId: string;
  agentName: string;
  handle: string;
  childSessionId: string;
  status: "creating" | "running" | "settled" | "recoverable_failed" | "failed" | "cancelled" | "quarantined";
  createdAt: string;
  lastActivityAt: string;
  attempts: Array<{
    requestedModel: string;
    actualModel: string;
    attempt: number;
    source: "initial" | "retry" | "fallback" | "user_override";
    kind?: string;
    reason?: string;
    diagnostics?: AttemptDiagnostics;
  }>;
}

export function normalizeHandle(handle: string): string {
  const value = handle.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("Invalid session handle");
  }
  return value;
}

export function newLogicalHandle(): string {
  return randomUUID();
}

export function makeSessionIdentity(input: SessionIdentityInput): SessionIdentity {
  const cwd = path.resolve(input.cwd);
  const handle = normalizeHandle(input.handle);
  const identityText = JSON.stringify([IDENTITY_VERSION, input.parentSessionId, cwd, input.agentName, handle]);
  const key = createHash("sha256").update(identityText).digest("hex");
  return { key, parentSessionId: input.parentSessionId, cwd, agentName: input.agentName, handle };
}

const REGISTRY_STATUSES = new Set<SessionRegistry["status"]>([
  "creating",
  "running",
  "settled",
  "recoverable_failed",
  "failed",
  "cancelled",
  "quarantined",
]);
const ATTEMPT_SOURCES = new Set<SessionRegistry["attempts"][number]["source"]>([
  "initial",
  "retry",
  "fallback",
  "user_override",
]);
const ATTEMPT_KINDS = new Set(["success", "incomplete", "transient_provider", "non_transient_provider", "task_failure", "cancelled", "unknown_transport"]);
const ATTEMPT_REASONS = new Set(["fetch failed", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "timeout", "HTTP 429", "HTTP 502", "HTTP 503", "HTTP 504", "provider request failed", "task failure", "cancelled", "output truncated", "child process failed"]);
const REGISTRY_KEYS = new Set(["version", "key", "parentSessionId", "agentName", "handle", "childSessionId", "status", "createdAt", "lastActivityAt", "attempts"]);
const ATTEMPT_KEYS = new Set(["requestedModel", "actualModel", "attempt", "source", "kind", "reason", "diagnostics"]);

function isDiagnostics(value: unknown): value is AttemptDiagnostics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const diagnostics = value as Record<string, unknown>;
  return Object.keys(diagnostics).every((key) => key === "toolErrorCount" || key === "providerErrorCount") &&
    Number.isSafeInteger(diagnostics.toolErrorCount) && (diagnostics.toolErrorCount as number) >= 0 &&
    Number.isSafeInteger(diagnostics.providerErrorCount) && (diagnostics.providerErrorCount as number) >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Validate persisted metadata before any path or identity field is consumed. */
export function isValidSessionRegistry(value: unknown): value is SessionRegistry {
  if (typeof value !== "object" || value === null) return false;
  const registry = value as Record<string, unknown>;
  if (Object.keys(registry).some((key) => !REGISTRY_KEYS.has(key)) ||
      registry.version !== 1 || !isString(registry.key) || !/^[a-f0-9]{64}$/.test(registry.key) ||
      !isString(registry.parentSessionId) || !isString(registry.agentName) || !isString(registry.handle) || !isString(registry.childSessionId) ||
      !REGISTRY_STATUSES.has(registry.status as SessionRegistry["status"]) ||
      !isString(registry.createdAt) || !isString(registry.lastActivityAt) ||
      !Number.isFinite(Date.parse(registry.createdAt)) || !Number.isFinite(Date.parse(registry.lastActivityAt)) ||
      !Array.isArray(registry.attempts)) return false;
  try { normalizeHandle(registry.handle); } catch { return false; }
  return registry.attempts.every((attempt) => {
    if (typeof attempt !== "object" || attempt === null) return false;
    const item = attempt as Record<string, unknown>;
    return Object.keys(item).every((key) => ATTEMPT_KEYS.has(key)) &&
      Number.isInteger(item.attempt) && (item.attempt as number) > 0 &&
      ATTEMPT_SOURCES.has(item.source as SessionRegistry["attempts"][number]["source"]) &&
      isString(item.requestedModel) && isString(item.actualModel) &&
      (item.kind === undefined || ATTEMPT_KINDS.has(item.kind as string)) &&
      (item.reason === undefined || ATTEMPT_REASONS.has(item.reason as string)) &&
      (item.diagnostics === undefined || isDiagnostics(item.diagnostics));
  });
}

export function isMatchingRegistry(registry: SessionRegistry, identity: SessionIdentity): boolean {
  return isValidSessionRegistry(registry) && registry.key === identity.key &&
    registry.parentSessionId === identity.parentSessionId &&
    registry.agentName === identity.agentName && registry.handle === identity.handle;
}
