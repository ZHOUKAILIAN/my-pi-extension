import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { canAdoptExistingV1, isBridgeProductionProof, isBridgeTestProof, inspectPreservationPinAtLockInternal as inspectPreservationPinAtLock, createPreservationPinAtLockInternal as createPreservationPinAtLock, refreshPreservationPinAtLockInternal as refreshPreservationPinAtLock, releasePreservationPinAtLockInternal as releasePreservationPinAtLock, DEFAULT_ROLLBACK_WINDOW_MS, type BridgeProductionProof } from "./bridge.ts";
import { acquireIdentityLock, withIdentityLock, type LockHandle } from "./session-lock.ts";
import { admitDispatchCallInternal } from "./delegation-control.ts";
import { appendWal, callPayload, delegationIdForCallSlot, dispatchCallIdForRequest, hashPath, loadViewReadOnly, readDelegationPayload, withCallLock } from "./delegation-context.ts";
import { atomicOwnerJson, ownerDirectorySync, ownerFileSync, sameIdentity, syncDirectory } from "./secure-fs.ts";
import { makeSessionIdentity, isValidSessionRegistry, type SessionRegistry } from "./session-identity.ts";
import type { ActiveLineage } from "./lineage.ts";
import { getAgentDiscoverySnapshot, type AgentScope } from "./agents.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ADOPTION_VERSION = 1;
const ADOPTIONS = "adoptions";
const ADOPTED_SESSIONS = "adopted-sessions";

type AdoptionPhase = "prepared" | "pin_created" | "copying" | "adopted" | "rollback_frozen" | "rollback_quarantine_planned" | "rolled_back" | "rollback_failed";
export type AdoptionStatus = "adopted" | "already_adopted" | "rejected" | "busy" | "paused_integrity";
export type RollbackStatus = "rolled_back" | "already_rolled_back" | "frozen" | "rejected" | "busy" | "paused_integrity";

export interface AdoptionActor {
  parentSessionId: string;
  activeLineageId: string;
  activeBranchAnchor: string;
}

export interface V1AdoptionRequest {
  adoptionKey: string;
  task: string;
  cwd: string;
  target: string;
  discoveryScope: AgentScope;
  actor: AdoptionActor;
  lineage?: ActiveLineage;
  v1Handle: string;
  v1Session: string;
  bridgeProof: unknown;
  /** Optional Call/Delegation owner used by slice6 live-reference blocking. */
  dispatchCallId?: string;
  delegationId?: string;
}

export interface V1SourceLiveness {
  lock: "absent" | "live" | "unknown";
  writer: "absent" | "live" | "unknown";
  child: "dead" | "live" | "unknown";
}

export interface V2RollbackLiveness {
  owner: "dead" | "live" | "unknown";
  child: "dead" | "live" | "unknown";
  action: "zero" | "outstanding" | "unknown";
  outbox: "idle" | "inflight" | "unknown";
  cleanup: "idle" | "active" | "unknown";
}

export interface AdoptionDependencies {
  now?: () => Date;
  /** Internal verification seam. It can only report facts; it cannot mint a production proof. */
  inspectSource?: (source: { rootDir: string; sourceKey: string; registryFile: string; sessionDir: string }) => Promise<V1SourceLiveness>;
  inspectV2?: (record: AdoptionRecord) => Promise<V2RollbackLiveness>;
  delayBetweenProofsMs?: number;
  fault?: (point: string) => void | Promise<void>;
  /** Internal-only fixture route; never accepted by the production predicate. */
  allowTestProof?: boolean;
}

export interface AdoptionRecord {
  version: 1;
  adoptionKey: string;
  sourceKey: string;
  /** Source facts are deliberately absent from a prepared marker. */
  sourceDigest?: string;
  sourceMtimeMs?: number;
  pinUntil?: string;
  adoptedAt?: string;
  deadline?: string;
  parentSessionId: string;
  activeLineageId: string;
  activeBranchAnchor: string;
  taskDigest: string;
  cwd: string;
  target: string;
  discoveryScope: AgentScope;
  v1Handle: string;
  v1Session: string;
  v2Namespace: string;
  phase: AdoptionPhase;
  createdAt: string;
  updatedAt: string;
  dispatchCallId: string;
  delegationId: string;
  lineage: ActiveLineage;
  rollbackSourceNamespaceIdentity?: string;
  rollbackSourceNamespaceDigest?: string;
  rollbackDestinationRelative?: string;
  rollbackDestinationPathHash?: string;
  rollbackDisposition?: "legacy_v1_explicit_handle_only";
  failureReason?: string;
}

export interface AdoptionResult {
  status: AdoptionStatus;
  adoptionKey: string;
  v2Namespace?: string;
  sourceDigest?: string;
  deadline?: string;
  reason?: string;
}

export interface RollbackResult {
  status: RollbackStatus;
  adoptionKey: string;
  reason?: string;
  disposition?: "legacy_v1_explicit_handle_only";
}

function now(deps?: AdoptionDependencies): Date {
  const value = deps?.now?.() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("invalid adoption clock");
  return new Date(value.getTime());
}
function digest(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function proofIsCurrent(value: unknown, clock: Date): boolean {
  if (isBridgeProductionProof(value)) return Date.parse(value.expiresAt) > clock.getTime();
  return isBridgeTestProof(value) && Date.parse(value.expiresAt) > clock.getTime();
}
function adoptionRoot(rootDir: string): string { return path.join(rootDir, "v2", ADOPTIONS); }
function sessionRoot(rootDir: string): string { return path.join(rootDir, "v2", ADOPTED_SESSIONS); }
function recordPath(rootDir: string, key: string): string { return path.join(adoptionRoot(rootDir), `${key}.json`); }
function adoptionLockRoot(rootDir: string): string { return path.join(rootDir, "v2"); }
function validLineage(value: unknown, parentSessionId: string): value is ActiveLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.parentSessionId === parentSessionId && typeof item.activeLineageId === "string" && item.activeLineageId.length > 0 &&
    typeof item.activeBranchAnchor === "string" && item.activeBranchAnchor.length > 0 && typeof item.currentLeafId === "string" && item.currentLeafId.length > 0 &&
    Array.isArray(item.branchIds) && item.branchIds.length > 0 && item.branchIds.every((id) => typeof id === "string" && id.length > 0) &&
    item.branchIds.includes(item.activeBranchAnchor) && item.branchIds.at(-1) === item.currentLeafId && ["restart-durable", "in_process_only"].includes(String(item.persistence)) &&
    (item.parentSessionFile === undefined || (typeof item.parentSessionFile === "string" && path.isAbsolute(item.parentSessionFile)));
}
function requestLineage(input: V1AdoptionRequest): ActiveLineage {
  return input.lineage ?? { parentSessionId: input.actor.parentSessionId, activeLineageId: input.actor.activeLineageId, activeBranchAnchor: input.actor.activeBranchAnchor, currentLeafId: input.actor.activeBranchAnchor, branchIds: [input.actor.activeBranchAnchor], persistence: "in_process_only" };
}
function validActor(value: unknown): value is AdoptionActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 3 && Object.values(record).every((item) => typeof item === "string" && item.length > 0);
}
function sameActor(a: AdoptionActor, b: AdoptionActor): boolean {
  return a.parentSessionId === b.parentSessionId && a.activeLineageId === b.activeLineageId && a.activeBranchAnchor === b.activeBranchAnchor;
}
function validInput(input: V1AdoptionRequest): boolean {
  return SAFE_ID.test(input.adoptionKey) && typeof input.task === "string" && input.task.length > 0 &&
    path.isAbsolute(input.cwd) && SAFE_ID.test(input.target) && ["user", "project", "both"].includes(input.discoveryScope) &&
    validActor(input.actor) && (input.lineage === undefined || validLineage(input.lineage, input.actor.parentSessionId)) && typeof input.v1Handle === "string" && SAFE_ID.test(input.v1Handle) &&
    typeof input.v1Session === "string" && SAFE_ID.test(input.v1Session) &&
    (input.dispatchCallId === undefined || SAFE_ID.test(input.dispatchCallId)) &&
    (input.delegationId === undefined || SAFE_ID.test(input.delegationId));
}
function validRecord(value: unknown): value is AdoptionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const required = ["version", "adoptionKey", "sourceKey", "parentSessionId", "activeLineageId", "activeBranchAnchor", "taskDigest", "cwd", "target", "discoveryScope", "v1Handle", "v1Session", "v2Namespace", "phase", "createdAt", "updatedAt", "dispatchCallId", "delegationId", "lineage"];
  const optional = ["sourceDigest", "sourceMtimeMs", "pinUntil", "adoptedAt", "deadline", "rollbackSourceNamespaceIdentity", "rollbackSourceNamespaceDigest", "rollbackDestinationRelative", "rollbackDestinationPathHash", "rollbackDisposition", "failureReason"];
  const strings = ["adoptionKey", "sourceKey", "parentSessionId", "activeLineageId", "activeBranchAnchor", "taskDigest", "cwd", "target", "discoveryScope", "v1Handle", "v1Session", "v2Namespace", "phase", "createdAt", "updatedAt", "dispatchCallId", "delegationId"];
  const phase = item.phase;
  const sourceFacts = typeof item.sourceDigest === "string" && SHA256.test(item.sourceDigest) && typeof item.sourceMtimeMs === "number" && Number.isFinite(item.sourceMtimeMs) && typeof item.pinUntil === "string" && Number.isFinite(Date.parse(item.pinUntil));
  const adoptedFacts = typeof item.adoptedAt === "string" && Number.isFinite(Date.parse(item.adoptedAt)) && typeof item.deadline === "string" && Number.isFinite(Date.parse(item.deadline)) && Date.parse(item.deadline) >= Date.parse(item.adoptedAt) + DEFAULT_ROLLBACK_WINDOW_MS && typeof item.pinUntil === "string" && Date.parse(item.pinUntil) >= Date.parse(item.deadline);
  const rollbackFacts = typeof item.rollbackSourceNamespaceIdentity === "string" && /^[0-9a-f]{32}$/.test(item.rollbackSourceNamespaceIdentity) && typeof item.rollbackSourceNamespaceDigest === "string" && SHA256.test(item.rollbackSourceNamespaceDigest) && typeof item.rollbackDestinationRelative === "string" && safeRelative(item.rollbackDestinationRelative) && typeof item.rollbackDestinationPathHash === "string" && /^[0-9a-f]{32}$/.test(item.rollbackDestinationPathHash);
  const shapeOkay = phase === "prepared" ? item.sourceDigest === undefined && item.sourceMtimeMs === undefined && item.pinUntil === undefined && item.adoptedAt === undefined && item.deadline === undefined && !rollbackFacts :
    ["pin_created", "copying"].includes(String(phase)) ? sourceFacts && item.adoptedAt === undefined && item.deadline === undefined && !rollbackFacts :
    ["adopted", "rollback_frozen"].includes(String(phase)) ? sourceFacts && adoptedFacts && !rollbackFacts : phase === "rollback_failed" ? sourceFacts && adoptedFacts : phase === "rollback_quarantine_planned" || phase === "rolled_back" ? sourceFacts && adoptedFacts && rollbackFacts : false;
  if (Object.keys(item).some((key) => !required.includes(key) && !optional.includes(key)) || !required.every((key) => key in item) || item.version !== 1 || !strings.every((key) => typeof item[key] === "string") || !shapeOkay || !SAFE_ID.test(item.adoptionKey as string) || !SHA256.test(item.sourceKey as string) || !validActor({ parentSessionId: item.parentSessionId, activeLineageId: item.activeLineageId, activeBranchAnchor: item.activeBranchAnchor }) || !validLineage(item.lineage, item.parentSessionId as string) || !SHA256.test(item.taskDigest as string) || !path.isAbsolute(item.cwd as string) || !["user", "project", "both"].includes(item.discoveryScope as string) || !SAFE_ID.test(item.v1Handle as string) || !SAFE_ID.test(item.v1Session as string) || !path.isAbsolute(item.v2Namespace as string) || !["prepared", "pin_created", "copying", "adopted", "rollback_frozen", "rollback_quarantine_planned", "rolled_back", "rollback_failed"].includes(item.phase as string) || !Number.isFinite(Date.parse(item.createdAt as string)) || !Number.isFinite(Date.parse(item.updatedAt as string)) || !SAFE_ID.test(item.dispatchCallId as string) || !SAFE_ID.test(item.delegationId as string) || (item.rollbackDisposition !== undefined && item.rollbackDisposition !== "legacy_v1_explicit_handle_only") || (item.failureReason !== undefined && typeof item.failureReason !== "string")) return false;
  return true;
}
async function readRecord(rootDir: string, key: string): Promise<AdoptionRecord | undefined> {
  try {
    const file = recordPath(rootDir, key); const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(file)) return undefined;
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8")); return validRecord(value) && value.adoptionKey === key && value.v2Namespace === path.join(sessionRoot(rootDir), key) ? value : undefined;
  } catch { return undefined; }
}
async function writeRecord(rootDir: string, record: AdoptionRecord): Promise<void> { await atomicOwnerJson(recordPath(rootDir, record.adoptionKey), record); }
async function updateRecord(rootDir: string, record: AdoptionRecord, phase: AdoptionPhase, deps?: AdoptionDependencies, extra: Partial<AdoptionRecord> = {}): Promise<AdoptionRecord> {
  const next = { ...record, ...extra, phase, updatedAt: now(deps).toISOString() };
  if (!validRecord(next)) throw new Error("adoption record integrity cannot be proven");
  await deps?.fault?.(`before:adoption_${phase}`); await writeRecord(rootDir, next); await deps?.fault?.(`after:adoption_${phase}`); return next;
}
async function secureRoot(rootDir: string): Promise<void> {
  const stat = await fs.lstat(rootDir); if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerDirectorySync(rootDir)) throw new Error("v1 root identity cannot be proven");
  await fs.realpath(rootDir);
}
function safeRelative(value: string): boolean { return value !== "" && !path.isAbsolute(value) && value !== "." && !value.split(path.sep).includes("..") && path.normalize(value) === value; }
interface SourceSnapshot { key: string; digest: string; mtimeMs: number; registry: SessionRegistry; registryText: string; files: Array<{ relative: string; content: string; digest: string; mtimeMs: number }>; }
async function secureJsonlFile(file: string): Promise<{ content: string; digest: string; mtimeMs: number }> {
  const handle = await fs.open(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0));
  try {
    const fdStat = await handle.stat(); const pathStat = await fs.lstat(file);
    if (!fdStat.isFile() || fdStat.isSymbolicLink() || fdStat.nlink !== 1 || !ownerFileSync(file) || !sameIdentity(fdStat, pathStat)) throw new Error("v1 JSONL identity cannot be proven");
    const content = await handle.readFile("utf8");
    for (const line of content.split("\n")) if (line.trim() !== "") { const parsed: unknown = JSON.parse(line); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("v1 JSONL record is malformed"); }
    const after = await handle.stat(); const finalPath = await fs.lstat(file); if (!sameIdentity(fdStat, after) || !sameIdentity(after, finalPath)) throw new Error("v1 JSONL changed while reading");
    return { content, digest: digest(content), mtimeMs: fdStat.mtimeMs };
  } finally { await handle.close(); }
}
async function secureRegistryFile(file: string): Promise<{ text: string; value: SessionRegistry; mtimeMs: number }> {
  const handle = await fs.open(file, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0));
  try {
    const fdStat = await handle.stat(); const pathStat = await fs.lstat(file);
    if (!fdStat.isFile() || fdStat.isSymbolicLink() || fdStat.nlink !== 1 || !ownerFileSync(file) || !sameIdentity(fdStat, pathStat)) throw new Error("v1 registry identity cannot be proven");
    const text = await handle.readFile("utf8"); const value: unknown = JSON.parse(text); const after = await handle.stat(); const finalPath = await fs.lstat(file);
    if (!sameIdentity(fdStat, after) || !sameIdentity(after, finalPath) || !isValidSessionRegistry(value)) throw new Error("v1 registry identity cannot be proven");
    return { text, value, mtimeMs: fdStat.mtimeMs };
  } finally { await handle.close(); }
}
async function snapshotSource(rootDir: string, input: { parentSessionId: string; cwd: string; target: string; v1Handle: string; v1Session: string }): Promise<SourceSnapshot> {
  const identity = makeSessionIdentity({ parentSessionId: input.parentSessionId, cwd: input.cwd, agentName: input.target, handle: input.v1Handle });
  const registryFile = path.join(rootDir, "registry", `${identity.key}.json`); const sessionDir = path.join(rootDir, "sessions", identity.key);
  const registry = await secureRegistryFile(registryFile); const registryText = registry.text; const value = registry.value; if (value.key !== identity.key || value.parentSessionId !== input.parentSessionId || value.agentName !== input.target || value.handle !== input.v1Handle || (input.v1Session !== identity.key && input.v1Session !== value.childSessionId)) throw new Error("v1 registry identity cannot be proven");
  if (["creating", "running", "quarantined"].includes(value.status)) throw new Error("v1 source is live or quarantined");
  const dirStat = await fs.lstat(sessionDir); if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !ownerDirectorySync(sessionDir)) throw new Error("v1 session directory identity cannot be proven");
  const files: SourceSnapshot["files"] = [];
  const walk = async (directory: string, relative = ""): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name; if (!safeRelative(childRelative)) throw new Error("v1 session path is unsafe"); const child = path.join(directory, entry.name); const stat = await fs.lstat(child);
      if (entry.isSymbolicLink() || stat.isSymbolicLink() || !ownerDirectorySync(directory) || (entry.isFile() && stat.nlink !== 1)) throw new Error("v1 session contains an unsafe link");
      if (entry.isDirectory()) await walk(child, childRelative);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) { const parsed = await secureJsonlFile(child); files.push({ relative: childRelative, ...parsed }); }
      else throw new Error("v1 session contains a non-JSONL entry");
    }
  };
  await walk(sessionDir); if (files.length === 0) throw new Error("v1 session has no complete JSONL");
  const mtimeMs = Math.max(registry.mtimeMs, ...files.map((file) => file.mtimeMs));
  return { key: identity.key, digest: digest(JSON.stringify({ registry: registryText, files: files.map(({ relative, digest: fileDigest, content }) => ({ relative, digest: fileDigest, bytes: Buffer.byteLength(content) })) })), mtimeMs, registry: value, registryText, files };
}
async function defaultSourceLiveness(source: { rootDir: string; sourceKey: string; registryFile: string }, ownLock?: LockHandle): Promise<V1SourceLiveness> {
  try {
    const lock = path.join(source.rootDir, "locks", `${source.sourceKey}.lock`);
    if (await fs.lstat(lock).then(() => true).catch(() => false)) {
      let owned = false; try { const value = JSON.parse(await fs.readFile(lock, "utf8")) as { token?: unknown }; owned = value.token === ownLock?.token; } catch { /* unknown lock */ }
      if (!owned) return { lock: "unknown", writer: "unknown", child: "unknown" };
    }
    const registry = (await secureRegistryFile(source.registryFile)).value;
    return { lock: "absent", writer: "absent", child: ["creating", "running"].includes(registry.status) ? "live" : "dead" };
  } catch { return { lock: "unknown", writer: "unknown", child: "unknown" }; }
}
async function proveSourceAbsent(deps: AdoptionDependencies | undefined, source: { rootDir: string; sourceKey: string; registryFile: string; sessionDir: string }, ownLock?: LockHandle): Promise<boolean> {
  const inspect = deps?.inspectSource ? () => deps.inspectSource!(source) : () => defaultSourceLiveness(source, ownLock);
  const first = await inspect(); if (first.lock !== "absent") return false;
  if (first.writer !== "absent" || first.child !== "dead") return false;
  if (deps?.delayBetweenProofsMs) await new Promise((resolve) => setTimeout(resolve, deps.delayBetweenProofsMs));
  const second = await inspect(); return second.lock === "absent" && second.writer === "absent" && second.child === "dead";
}
async function stableSourceSnapshot(deps: AdoptionDependencies | undefined, source: { rootDir: string; sourceKey: string; registryFile: string; sessionDir: string }, input: { parentSessionId: string; cwd: string; target: string; v1Handle: string; v1Session: string }, ownLock: LockHandle): Promise<SourceSnapshot> {
  if (!await proveSourceAbsent(deps, source, ownLock)) throw new Error("v1 writer, child, or lock absence is not proven");
  const first = await snapshotSource(source.rootDir, input);
  if (deps?.delayBetweenProofsMs) await new Promise((resolve) => setTimeout(resolve, deps.delayBetweenProofsMs));
  if (!await proveSourceAbsent(deps, source, ownLock)) throw new Error("v1 source became live");
  const second = await snapshotSource(source.rootDir, input);
  if (first.digest !== second.digest || first.mtimeMs !== second.mtimeMs || first.registryText !== second.registryText || JSON.stringify(first.files.map((file) => [file.relative, file.digest, file.mtimeMs])) !== JSON.stringify(second.files.map((file) => [file.relative, file.digest, file.mtimeMs]))) throw new Error("v1 source changed while being adopted");
  return first;
}
async function withAdoptionLedgerLock<T>(rootDir: string, adoptionKey: string, fn: () => Promise<T>): Promise<T | undefined> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await withIdentityLock({ rootDir: adoptionLockRoot(rootDir), key: `adoption-${adoptionKey}` }, fn);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}
async function ensureDirs(rootDir: string): Promise<void> { await fs.mkdir(adoptionRoot(rootDir), { recursive: true, mode: 0o700 }); await fs.mkdir(sessionRoot(rootDir), { recursive: true, mode: 0o700 }); if (!ownerDirectorySync(adoptionRoot(rootDir)) || !ownerDirectorySync(sessionRoot(rootDir))) throw new Error("v2 adoption namespace cannot be proven"); }
async function copySnapshot(rootDir: string, record: AdoptionRecord, snapshot: SourceSnapshot, deps?: AdoptionDependencies): Promise<void> {
  const base = sessionRoot(rootDir); const final = path.join(base, record.adoptionKey); const temp = path.join(base, `.tmp-${record.adoptionKey}-${randomUUID()}`);
  if (await fs.lstat(final).then((stat) => !stat.isDirectory() || stat.isSymbolicLink() || !ownerDirectorySync(final)).catch(() => false)) throw new Error("v2 namespace identity cannot be proven");
  for (const entry of await fs.readdir(base, { withFileTypes: true })) if (entry.name.startsWith(`.tmp-${record.adoptionKey}-`)) { const stale = path.join(base, entry.name); const staleStat = await fs.lstat(stale); if (!staleStat.isDirectory() || staleStat.isSymbolicLink() || !ownerDirectorySync(stale)) throw new Error("stale v2 temp identity cannot be proven"); await fs.rm(stale, { recursive: true, force: true }); }
  await fs.mkdir(temp, { recursive: false, mode: 0o700 });
  try {
    const branch = path.join(temp, "branch"); await fs.mkdir(branch, { mode: 0o700 });
    for (const file of snapshot.files) {
      const target = path.join(branch, file.relative); await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await fs.open(target, "wx", 0o600); try { await handle.writeFile(file.content, "utf8"); await handle.sync(); } finally { await handle.close(); }
      if (!ownerFileSync(target)) throw new Error("v2 copy identity cannot be proven"); await syncDirectory(path.dirname(target));
    }
    const header = { version: 1, sourceKey: record.sourceKey, sourceDigest: record.sourceDigest, sourceMtimeMs: record.sourceMtimeMs, v1Handle: record.v1Handle, v1Session: record.v1Session, branchDigest: digest(JSON.stringify(snapshot.files.map((file) => ({ relative: file.relative, digest: file.digest, bytes: Buffer.byteLength(file.content) })))) };
    await atomicOwnerJson(path.join(temp, "header.json"), header); await syncDirectory(branch); await syncDirectory(temp); await deps?.fault?.("before:adoption_namespace_rename");
    if (await fs.lstat(final).then(() => true).catch(() => false)) { await fs.rm(temp, { recursive: true, force: true }); return; }
    await fs.rename(temp, final); await syncDirectory(base);
  } catch (error) { await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined); throw error; }
}
interface VerifiedNamespace { namespaceDigest: string; branchDigest: string; }
async function inspectCopiedNamespace(rootDir: string, record: AdoptionRecord, namespace: string): Promise<VerifiedNamespace | undefined> {
  try {
    const namespaceStat = await fs.lstat(namespace); if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink() || !ownerDirectorySync(namespace)) return undefined;
    const namespaceEntries = await fs.readdir(namespace, { withFileTypes: true }); if (namespaceEntries.length !== 2 || !namespaceEntries.some((entry) => entry.name === "header.json" && entry.isFile()) || !namespaceEntries.some((entry) => entry.name === "branch" && entry.isDirectory())) return undefined;
    const headerFile = path.join(namespace, "header.json"); const stat = await fs.lstat(headerFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(headerFile)) return undefined;
    const header = JSON.parse(await fs.readFile(headerFile, "utf8")) as Record<string, unknown>;
    if (header.version !== 1 || header.sourceKey !== record.sourceKey || header.sourceDigest !== record.sourceDigest || header.sourceMtimeMs !== record.sourceMtimeMs || header.v1Handle !== record.v1Handle || header.v1Session !== record.v1Session || !SHA256.test(String(header.branchDigest))) return undefined;
    const rows: Array<{ relative: string; digest: string; bytes: number }> = [];
    const walk = async (directory: string, relative = ""): Promise<void> => {
      const directoryStat = await fs.lstat(directory); if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !ownerDirectorySync(directory)) throw new Error("unsafe copied namespace");
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = path.join(directory, entry.name); const childRelative = relative ? path.join(relative, entry.name) : entry.name; const childStat = await fs.lstat(child);
        if (entry.isSymbolicLink() || childStat.isSymbolicLink() || (entry.isDirectory() && !ownerDirectorySync(child)) || (entry.isFile() && (childStat.nlink !== 1 || !ownerFileSync(child)))) throw new Error("unsafe copied namespace");
        if (entry.isDirectory()) await walk(child, childRelative);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) { const content = await fs.readFile(child, "utf8"); for (const line of content.split("\n")) if (line.trim() !== "") JSON.parse(line); rows.push({ relative: childRelative, digest: digest(content), bytes: Buffer.byteLength(content) }); }
        else throw new Error("copied namespace contains an unexpected file");
      }
    };
    await walk(path.join(namespace, "branch")); const branchDigest = digest(JSON.stringify(rows)); if (branchDigest !== header.branchDigest) return undefined;
    const namespaceDigest = digest(JSON.stringify({ sourceKey: header.sourceKey, sourceDigest: header.sourceDigest, sourceMtimeMs: header.sourceMtimeMs, v1Handle: header.v1Handle, v1Session: header.v1Session, branchDigest }));
    return { namespaceDigest, branchDigest };
  } catch { return undefined; }
}
async function verifyCopiedNamespace(rootDir: string, record: AdoptionRecord, namespace = path.join(sessionRoot(rootDir), record.adoptionKey)): Promise<boolean> {
  return (await inspectCopiedNamespace(rootDir, record, namespace)) !== undefined;
}
interface AdoptionIdentity { sourceKey: string; v2Namespace: string; dispatchCallId: string; delegationId: string; lineage: ActiveLineage; }
function adoptionIdentity(rootDir: string, input: V1AdoptionRequest): AdoptionIdentity {
  const lineage = requestLineage(input); const toolCallId = `adopt-v1:${input.adoptionKey}`; const dispatchCallId = dispatchCallIdForRequest(lineage.parentSessionId, lineage, toolCallId);
  return { sourceKey: makeSessionIdentity({ parentSessionId: input.actor.parentSessionId, cwd: input.cwd, agentName: input.target, handle: input.v1Handle }).key, v2Namespace: path.join(sessionRoot(rootDir), input.adoptionKey), dispatchCallId, delegationId: delegationIdForCallSlot(dispatchCallId, 0), lineage };
}
function recordMatchesRequest(rootDir: string, record: AdoptionRecord, input: V1AdoptionRequest, expected: AdoptionIdentity): boolean {
  return record.parentSessionId === input.actor.parentSessionId && record.activeLineageId === input.actor.activeLineageId && record.activeBranchAnchor === input.actor.activeBranchAnchor && JSON.stringify(record.lineage) === JSON.stringify(expected.lineage) && record.target === input.target && record.v1Handle === input.v1Handle && record.v1Session === input.v1Session && record.taskDigest === digest(input.task) && record.cwd === path.resolve(input.cwd) && record.sourceKey === expected.sourceKey && record.v2Namespace === expected.v2Namespace && record.dispatchCallId === expected.dispatchCallId && record.delegationId === expected.delegationId && record.v2Namespace === path.join(sessionRoot(rootDir), record.adoptionKey);
}
async function loadOrRejectExisting(rootDir: string, input: V1AdoptionRequest, expected: AdoptionIdentity): Promise<AdoptionResult | undefined> {
  const existing = await readRecord(rootDir, input.adoptionKey); if (!existing) {
    try { const stat = await fs.lstat(recordPath(rootDir, input.adoptionKey)); if (stat.isFile() || stat.isSymbolicLink()) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "adoption record integrity cannot be proven" }; } catch { /* absent */ }
    return undefined;
  }
  if (!recordMatchesRequest(rootDir, existing, input, expected)) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "adoption key conflicts with another request" };
  if (existing.phase === "adopted") return { status: "already_adopted", adoptionKey: input.adoptionKey, v2Namespace: existing.v2Namespace, sourceDigest: existing.sourceDigest, deadline: existing.deadline };
  if (existing.phase === "rolled_back") return { status: "rejected", adoptionKey: input.adoptionKey, reason: "adoption has already rolled back" };
  if (["rollback_frozen", "rollback_quarantine_planned", "rollback_failed"].includes(existing.phase)) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "adoption rollback is durably frozen" };
  return undefined;
}
async function writePreparedMarker(rootDir: string, input: V1AdoptionRequest, expected: AdoptionIdentity, deps: AdoptionDependencies): Promise<AdoptionResult | undefined> {
  return withAdoptionLedgerLock(rootDir, input.adoptionKey, async () => {
    const existing = await loadOrRejectExisting(rootDir, input, expected); if (existing) return existing;
    const timestamp = now(deps).toISOString();
    const prepared: AdoptionRecord = { version: 1, adoptionKey: input.adoptionKey, sourceKey: expected.sourceKey, parentSessionId: input.actor.parentSessionId, activeLineageId: input.actor.activeLineageId, activeBranchAnchor: input.actor.activeBranchAnchor, taskDigest: digest(input.task), cwd: path.resolve(input.cwd), target: input.target, discoveryScope: input.discoveryScope, v1Handle: input.v1Handle, v1Session: input.v1Session, v2Namespace: expected.v2Namespace, phase: "prepared", createdAt: timestamp, updatedAt: timestamp, dispatchCallId: expected.dispatchCallId, delegationId: expected.delegationId, lineage: expected.lineage };
    await deps.fault?.("before:adoption_prepared"); await writeRecord(rootDir, prepared); await deps.fault?.("after:adoption_prepared"); return undefined;
  });
}
async function adoptionSource(rootDir: string, record: AdoptionRecord): Promise<{ rootDir: string; sourceKey: string; registryFile: string; sessionDir: string }> {
  return { rootDir, sourceKey: record.sourceKey, registryFile: path.join(rootDir, "registry", `${record.sourceKey}.json`), sessionDir: path.join(rootDir, "sessions", record.sourceKey) };
}
async function ensureRollbackPin(rootDir: string, sourceKey: string, minimumUntil: Date, deps: AdoptionDependencies): Promise<import("./bridge.ts").PreservationPin | undefined> {
  const clock = now(deps); let inspected = await inspectPreservationPinAtLock({ rootDir, sourceHash: sourceKey }, { now: () => clock }); let mutation;
  if (inspected.state === "valid" && inspected.pin && Date.parse(inspected.pin.pinUntil) >= minimumUntil.getTime()) mutation = { status: "already_exists" as const, pin: inspected.pin };
  else if (inspected.state === "valid" && inspected.pin) mutation = await refreshPreservationPinAtLock({ rootDir, sourceHash: sourceKey, pinUntil: minimumUntil }, { now: () => clock });
  else if (inspected.state === "absent") mutation = await createPreservationPinAtLock({ rootDir, sourceHash: sourceKey, pinUntil: minimumUntil }, { now: () => clock });
  else return undefined;
  if (!["created", "already_exists", "refreshed"].includes(mutation.status) || !mutation.pin) return undefined;
  inspected = await inspectPreservationPinAtLock({ rootDir, sourceHash: sourceKey }, { now: () => clock }); return inspected.state === "valid" && inspected.pin && Date.parse(inspected.pin.pinUntil) >= minimumUntil.getTime() ? inspected.pin : undefined;
}

interface RollbackNamespaceBinding {
  rollbackSourceNamespaceIdentity: string;
  rollbackSourceNamespaceDigest: string;
  rollbackDestinationRelative: string;
  rollbackDestinationPathHash: string;
}
function rollbackDestination(rootDir: string, adoptionKey: string): string { return path.join(rootDir, "v2", "quarantine", adoptionKey); }
function rollbackRelative(rootDir: string, value: string): string {
  const relative = path.relative(rootDir, value); if (!safeRelative(relative)) throw new Error("rollback namespace path is not safely relative"); return relative;
}
function rollbackBinding(rootDir: string, record: AdoptionRecord, namespaceDigest: string): RollbackNamespaceBinding {
  const destination = rollbackDestination(rootDir, record.adoptionKey);
  return { rollbackSourceNamespaceIdentity: hashPath(record.v2Namespace), rollbackSourceNamespaceDigest: namespaceDigest, rollbackDestinationRelative: rollbackRelative(rootDir, destination), rollbackDestinationPathHash: hashPath(destination) };
}
function bindingMatches(rootDir: string, record: AdoptionRecord, binding: RollbackNamespaceBinding): boolean {
  return record.rollbackSourceNamespaceIdentity === binding.rollbackSourceNamespaceIdentity && record.rollbackSourceNamespaceDigest === binding.rollbackSourceNamespaceDigest && record.rollbackDestinationRelative === binding.rollbackDestinationRelative && record.rollbackDestinationPathHash === binding.rollbackDestinationPathHash;
}
function recordedBinding(rootDir: string, record: AdoptionRecord): RollbackNamespaceBinding | undefined {
  if (!record.rollbackSourceNamespaceIdentity || !record.rollbackSourceNamespaceDigest || !record.rollbackDestinationRelative || !record.rollbackDestinationPathHash) return undefined;
  const binding = { rollbackSourceNamespaceIdentity: record.rollbackSourceNamespaceIdentity, rollbackSourceNamespaceDigest: record.rollbackSourceNamespaceDigest, rollbackDestinationRelative: record.rollbackDestinationRelative, rollbackDestinationPathHash: record.rollbackDestinationPathHash };
  return binding.rollbackDestinationRelative === rollbackRelative(rootDir, rollbackDestination(rootDir, record.adoptionKey)) && binding.rollbackDestinationPathHash === hashPath(rollbackDestination(rootDir, record.adoptionKey)) ? binding : undefined;
}
async function appendRollbackPlanFact(rootDir: string, record: AdoptionRecord, deps: AdoptionDependencies): Promise<boolean> {
  const view = await loadViewReadOnly(rootDir, record.dispatchCallId); if (view.integrity || !view.call || !view.delegations.get(record.delegationId)) return false;
  const existing = view.events.find((event) => event.type === "adoption_rollback_quarantine_planned");
  const binding = recordedBinding(rootDir, record);
  if (!binding) return false;
  const matches = (event: typeof existing) => !!event && event.data.adoptionKey === record.adoptionKey && event.data.dispatchCallId === record.dispatchCallId && event.data.delegationId === record.delegationId && event.data.sourceKey === record.sourceKey && event.data.sourceNamespaceIdentity === binding.rollbackSourceNamespaceIdentity && event.data.sourceNamespaceDigest === binding.rollbackSourceNamespaceDigest && event.data.destinationRelative === binding.rollbackDestinationRelative && event.data.destinationPathHash === binding.rollbackDestinationPathHash && event.data.parentSessionId === record.parentSessionId && event.data.activeLineageId === record.activeLineageId && event.data.activeBranchAnchor === record.activeBranchAnchor;
  if (existing) return matches(existing);
  if (!view.events.some((event) => event.type === "adoption_rollback_frozen")) return false;
  await appendWal(rootDir, record.dispatchCallId, "adoption_rollback_quarantine_planned", { adoptionKey: record.adoptionKey, dispatchCallId: record.dispatchCallId, delegationId: record.delegationId, sourceKey: record.sourceKey, sourceNamespaceIdentity: binding.rollbackSourceNamespaceIdentity, sourceNamespaceDigest: binding.rollbackSourceNamespaceDigest, destinationRelative: binding.rollbackDestinationRelative, destinationPathHash: binding.rollbackDestinationPathHash, privatePayloadRef: view.call.privatePayloadRef, delegationPrivatePayloadRef: view.delegations.get(record.delegationId)!.privatePayloadRef, parentSessionId: record.parentSessionId, activeLineageId: record.activeLineageId, activeBranchAnchor: record.activeBranchAnchor, plannedAt: now(deps).toISOString() }, undefined, { ...deps, fault: undefined, lineage: record.lineage });
  return true;
}
async function namespacePresent(value: string): Promise<boolean> {
  try { await fs.lstat(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function ensureQuarantineIdempotent(rootDir: string, record: AdoptionRecord, deps: AdoptionDependencies): Promise<boolean> {
  const binding = recordedBinding(rootDir, record); if (!binding) return false;
  const source = record.v2Namespace; const destination = path.join(rootDir, binding.rollbackDestinationRelative);
  if (hashPath(destination) !== binding.rollbackDestinationPathHash) return false;
  const sourceExists = await namespacePresent(source); const destinationExists = await namespacePresent(destination);
  if (sourceExists === destinationExists) return false;
  const candidate = sourceExists ? source : destination; const verified = await inspectCopiedNamespace(rootDir, record, candidate);
  if (!verified || verified.namespaceDigest !== binding.rollbackSourceNamespaceDigest || hashPath(source) !== binding.rollbackSourceNamespaceIdentity) return false;
  if (!sourceExists) return true;
  await deps.fault?.("before:adoption_rollback_quarantine_rename"); await fs.rename(source, destination); await syncDirectory(path.dirname(source)); await syncDirectory(path.dirname(destination)); await deps.fault?.("after:adoption_rollback_quarantine_rename");
  return true;
}
export async function adoptExistingV1Internal(rootDir: string, input: V1AdoptionRequest, deps: AdoptionDependencies = {}): Promise<AdoptionResult> {
  if (!validInput(input) || (!canAdoptExistingV1(input.bridgeProof) && !(deps.allowTestProof === true && isBridgeTestProof(input.bridgeProof)))) return { status: "rejected", adoptionKey: input.adoptionKey ?? "invalid", reason: "verified bridge-v1 production proof is required" };
  try { await secureRoot(rootDir); await ensureDirs(rootDir); } catch (error) { return { status: "rejected", adoptionKey: input.adoptionKey, reason: error instanceof Error ? error.message : "store identity cannot be proven" }; }
  const expected = adoptionIdentity(rootDir, input);
  const prepared = await writePreparedMarker(rootDir, input, expected, deps); if (prepared) return prepared;
  if (!proofIsCurrent(input.bridgeProof, now(deps))) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "bridge production proof is expired" };
  // Admission is outside source and ledger locks. The prepared marker closes
  // the crash window before the Call lock is taken.
  const admission = await ensureAdoptionAdmission(rootDir, input, expected); if (!admission) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "v2 Call/Delegation admission cannot be proven" };
  const ledger = await withAdoptionLedgerLock(rootDir, input.adoptionKey, async (): Promise<AdoptionResult> => {
    const record = await readRecord(rootDir, input.adoptionKey);
    if (!record || !recordMatchesRequest(rootDir, record, input, expected)) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "prepared adoption marker cannot be proven" };
    if (record.phase === "adopted") return { status: "already_adopted", adoptionKey: input.adoptionKey, v2Namespace: record.v2Namespace, sourceDigest: record.sourceDigest, deadline: record.deadline };
    if (record.phase === "rolled_back") return { status: "rejected", adoptionKey: input.adoptionKey, reason: "adoption has already rolled back" };
    if (["rollback_frozen", "rollback_quarantine_planned", "rollback_failed"].includes(record.phase)) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "adoption rollback is durably frozen" };
    if (admission.dispatchCallId !== record.dispatchCallId || admission.delegationId !== record.delegationId) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "admission identity conflicts with prepared adoption" };
    const source = await adoptionSource(rootDir, record);
    const sourceResult = await withIdentityLock({ rootDir, key: record.sourceKey }, async (sourceLock) => {
      let snapshot: SourceSnapshot;
      try { snapshot = await stableSourceSnapshot(deps, source, { parentSessionId: record.parentSessionId, cwd: record.cwd, target: record.target, v1Handle: record.v1Handle, v1Session: record.v1Session }, sourceLock); } catch (error) { return { status: "rejected", adoptionKey: input.adoptionKey, reason: error instanceof Error ? error.message : "v1 source is invalid" } satisfies AdoptionResult; }
      const provisionalUntil = new Date(now(deps).getTime() + DEFAULT_ROLLBACK_WINDOW_MS); const pin = await ensureRollbackPin(rootDir, snapshot.key, provisionalUntil, deps);
      if (!pin) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "bridge GC pin could not be durably established" };
      if (!await proveSourceAbsent(deps, source, sourceLock)) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "v1 source changed or became live after pin" };
      const sourceAgain = await snapshotSource(rootDir, { parentSessionId: record.parentSessionId, cwd: record.cwd, target: record.target, v1Handle: record.v1Handle, v1Session: record.v1Session }); if (sourceAgain.digest !== snapshot.digest || sourceAgain.mtimeMs !== snapshot.mtimeMs) return { status: "rejected", adoptionKey: input.adoptionKey, reason: "v1 source identity changed after pin" };
      let current: AdoptionRecord = { ...record, sourceDigest: snapshot.digest, sourceMtimeMs: snapshot.mtimeMs, pinUntil: pin.pinUntil };
      current = await updateRecord(rootDir, current, "pin_created", deps); current = await updateRecord(rootDir, current, "copying", deps);
      await copySnapshot(rootDir, current, snapshot, deps); if (!await verifyCopiedNamespace(rootDir, current)) return { status: "paused_integrity", adoptionKey: input.adoptionKey, reason: "v2 copied namespace digest cannot be proven" };
      const finalSource = await stableSourceSnapshot(deps, source, { parentSessionId: current.parentSessionId, cwd: current.cwd, target: current.target, v1Handle: current.v1Handle, v1Session: current.v1Session }, sourceLock); if (finalSource.digest !== snapshot.digest || finalSource.mtimeMs !== snapshot.mtimeMs) return { status: "paused_integrity", adoptionKey: input.adoptionKey, reason: "v1 source changed before adoption terminal state" };
      const adoptedAt = now(deps); const deadline = new Date(adoptedAt.getTime() + DEFAULT_ROLLBACK_WINDOW_MS); const adoptedPin = await ensureRollbackPin(rootDir, current.sourceKey, deadline, deps);
      if (!adoptedPin) return { status: "paused_integrity", adoptionKey: input.adoptionKey, reason: "rollback pin does not cover the durable adoption window" };
      current = await updateRecord(rootDir, current, "adopted", deps, { pinUntil: adoptedPin.pinUntil, adoptedAt: adoptedAt.toISOString(), deadline: deadline.toISOString() });
      return { status: "adopted", adoptionKey: input.adoptionKey, v2Namespace: current.v2Namespace, sourceDigest: current.sourceDigest, deadline: current.deadline };
    });
    return (sourceResult ?? { status: "busy", adoptionKey: input.adoptionKey }) as AdoptionResult;
  });
  return ledger ?? { status: "busy", adoptionKey: input.adoptionKey };
}
export const adoptV1SessionInternal = adoptExistingV1Internal;

interface AdmissionBinding {
  dispatchCallId: string;
  delegationId: string;
  lineage: ActiveLineage;
}
async function ensureAdoptionAdmissionOnce(rootDir: string, input: V1AdoptionRequest, expected?: AdoptionIdentity): Promise<AdmissionBinding | undefined> {
  const lineage = requestLineage(input);
  const snapshot = input.discoveryScope === "user" ? undefined : getAgentDiscoverySnapshot(path.resolve(input.cwd));
  if (input.discoveryScope !== "user" && !snapshot) return undefined;
  const admission = await admitDispatchCallInternal({
    parentSessionId: lineage.parentSessionId,
    lineage,
    toolCallId: `adopt-v1:${input.adoptionKey}`,
    cwd: path.resolve(input.cwd),
    mode: "single",
    agentScope: input.discoveryScope,
    projectTrust: snapshot ? { parentSessionId: lineage.parentSessionId, discoveryRootRealpath: snapshot.rootRealpath, snapshotDigest: snapshot.digest } : undefined,
    single: { agent: input.target, task: input.task, cwd: path.resolve(input.cwd), persistent: true },
    persistent: true,
  }, rootDir, { lineage });
  if (!("dispatchCallId" in admission) || !["admitted", "repair_required"].includes(admission.state) || typeof admission.dispatchCallId !== "string") return undefined;
  const call = await loadViewReadOnly(rootDir, admission.dispatchCallId);
  if (call.integrity || !call.call || call.call.mode !== "single" || call.call.agentScope !== input.discoveryScope) return undefined;
  const delegationId = "delegationIds" in admission ? admission.delegationIds?.[0] : undefined; if (typeof delegationId !== "string") return undefined;
  const delegation = call.delegations.get(delegationId); if (!delegation || delegation.dispatchCallId !== admission.dispatchCallId || delegation.requestedTarget !== input.target || delegation.effectiveCwdHash !== hashPath(path.resolve(input.cwd))) return undefined;
  try {
    const payload = await callPayload(rootDir, call.call); const itemPayload = await readDelegationPayload(rootDir, call, delegation);
    if (payload.toolCallId !== `adopt-v1:${input.adoptionKey}` || payload.cwd !== path.resolve(input.cwd) || JSON.stringify(payload.lineage) !== JSON.stringify(lineage) || payload.items.length !== 1 || JSON.stringify(payload.items[0]) !== JSON.stringify({ agent: input.target, task: input.task, cwd: path.resolve(input.cwd), persistent: true }) || JSON.stringify(itemPayload.item) !== JSON.stringify(payload.items[0])) return undefined;
  } catch { return undefined; }
  if (expected && (admission.dispatchCallId !== expected.dispatchCallId || delegationId !== expected.delegationId)) return undefined;
  if (input.dispatchCallId !== undefined && input.dispatchCallId !== admission.dispatchCallId) return undefined;
  if (input.delegationId !== undefined && input.delegationId !== delegationId) return undefined;
  return { dispatchCallId: admission.dispatchCallId, delegationId, lineage };
}

async function ensureAdoptionAdmission(rootDir: string, input: V1AdoptionRequest, expected?: AdoptionIdentity): Promise<AdmissionBinding | undefined> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const result = await ensureAdoptionAdmissionOnce(rootDir, input, expected); if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}
async function verifyAdmissionBinding(rootDir: string, record: AdoptionRecord): Promise<boolean> {
  const view = loadViewReadOnly(rootDir, record.dispatchCallId); const loaded = await view;
  if (loaded.integrity || !loaded.call || loaded.call.dispatchCallId !== record.dispatchCallId || loaded.call.parentSessionId !== record.parentSessionId || loaded.call.activeLineageId !== record.activeLineageId || loaded.call.activeBranchAnchor !== record.activeBranchAnchor) return false;
  const delegation = loaded.delegations.get(record.delegationId); if (!delegation || delegation.dispatchCallId !== record.dispatchCallId || delegation.parentSessionId !== record.parentSessionId || delegation.activeLineageId !== record.activeLineageId || delegation.activeBranchAnchor !== record.activeBranchAnchor || delegation.requestedTarget !== record.target || delegation.effectiveCwdHash !== hashPath(record.cwd)) return false;
  try { const payload = await callPayload(rootDir, loaded.call); const item = await readDelegationPayload(rootDir, loaded, delegation); return payload.items.length === 1 && payload.cwd === record.cwd && payload.lineage.parentSessionId === record.parentSessionId && payload.lineage.activeLineageId === record.activeLineageId && payload.lineage.activeBranchAnchor === record.activeBranchAnchor && payload.items[0]?.agent === record.target && payload.items[0]?.task !== undefined && digest(String(payload.items[0]?.task)) === record.taskDigest && JSON.stringify(item.item) === JSON.stringify(payload.items[0]); } catch { return false; }
}
async function freezeAdmissionCall(rootDir: string, record: AdoptionRecord, deps: AdoptionDependencies): Promise<boolean> {
  if (!await verifyAdmissionBinding(rootDir, record)) return false;
  const result = await withCallLock(rootDir, record.dispatchCallId, async () => {
    const view = await loadViewReadOnly(rootDir, record.dispatchCallId); if (view.integrity || !view.call || !view.delegations.has(record.delegationId)) return false;
    const existing = view.events.find((event) => event.type === "adoption_rollback_frozen");
    if (existing) return existing.data.adoptionKey === record.adoptionKey && existing.data.delegationId === record.delegationId;
    await appendWal(rootDir, record.dispatchCallId, "adoption_rollback_frozen", { adoptionKey: record.adoptionKey, dispatchCallId: record.dispatchCallId, delegationId: record.delegationId, sourceKey: record.sourceKey, privatePayloadRef: view.call!.privatePayloadRef, delegationPrivatePayloadRef: view.delegations.get(record.delegationId)!.privatePayloadRef, parentSessionId: record.parentSessionId, activeLineageId: record.activeLineageId, activeBranchAnchor: record.activeBranchAnchor, frozenAt: now(deps).toISOString() }, undefined, { ...deps, fault: undefined, lineage: record.lineage });
    await deps.fault?.("after:adoption_rollback_call_frozen");
    return true;
  });
  return result === true;
}
async function markRollbackFailure(rootDir: string, record: AdoptionRecord, reason: string, deps: AdoptionDependencies): Promise<RollbackResult> {
  await updateRecord(rootDir, record, "rollback_failed", deps, { failureReason: reason }); return { status: "frozen", adoptionKey: record.adoptionKey, reason };
}
async function markRollbackIntegrity(rootDir: string, record: AdoptionRecord, reason: string, deps: AdoptionDependencies): Promise<RollbackResult> {
  await updateRecord(rootDir, record, "rollback_failed", deps, { failureReason: reason }); return { status: "paused_integrity", adoptionKey: record.adoptionKey, reason };
}
function validRollbackLiveness(value: V2RollbackLiveness): boolean { return value.owner === "dead" && value.child === "dead" && value.action === "zero" && value.outbox === "idle" && value.cleanup === "idle"; }
async function proveRollbackLiveness(record: AdoptionRecord, deps: AdoptionDependencies): Promise<boolean> {
  if (!deps.inspectV2) return false; const first = await deps.inspectV2(record); if (!validRollbackLiveness(first)) return false; if (deps.delayBetweenProofsMs) await new Promise((resolve) => setTimeout(resolve, deps.delayBetweenProofsMs)); return validRollbackLiveness(await deps.inspectV2(record));
}
export async function rollbackAdoptedV1Internal(rootDir: string, adoptionKey: string, actor: AdoptionActor, bridgeProof: unknown, deps: AdoptionDependencies = {}): Promise<RollbackResult> {
  if (!SAFE_ID.test(adoptionKey) || !validActor(actor) || (!canAdoptExistingV1(bridgeProof) && !(deps.allowTestProof === true && isBridgeTestProof(bridgeProof)))) return { status: "rejected", adoptionKey, reason: "verified bridge-v1 production proof is required" };
  try { await secureRoot(rootDir); await ensureDirs(rootDir); } catch (error) { return { status: "rejected", adoptionKey, reason: error instanceof Error ? error.message : "store identity cannot be proven" }; }
  const result = await withAdoptionLedgerLock(rootDir, adoptionKey, async (): Promise<RollbackResult> => {
    let record = await readRecord(rootDir, adoptionKey); if (!record) return { status: "rejected", adoptionKey, reason: "adoption record is unavailable" };
    if (!sameActor(actor, { parentSessionId: record.parentSessionId, activeLineageId: record.activeLineageId, activeBranchAnchor: record.activeBranchAnchor })) return { status: "rejected", adoptionKey, reason: "rollback actor does not own adoption" };
    if (record.phase === "rolled_back") {
      if (!verifiedQuarantineSync(rootDir, record)) return { status: "paused_integrity", adoptionKey, reason: "rolled_back quarantine namespace cannot be proven" };
      try {
        const released = await releasePreservationPinAtLock({ rootDir, sourceHash: record.sourceKey }, { now: () => now(deps) });
        return { status: "already_rolled_back", adoptionKey, disposition: "legacy_v1_explicit_handle_only", ...(released.status === "released" || released.status === "absent" ? {} : { reason: "rollback is complete; preservation pin release needs maintenance retry" }) };
      } catch { return { status: "already_rolled_back", adoptionKey, disposition: "legacy_v1_explicit_handle_only", reason: "rollback is complete; preservation pin release needs maintenance retry" }; }
    }
    if (record.phase === "rollback_failed") return { status: "frozen", adoptionKey, reason: record.failureReason ?? "rollback is frozen" };
    if (!["adopted", "rollback_frozen", "rollback_quarantine_planned"].includes(record.phase) || !record.deadline || !record.adoptedAt || !record.sourceDigest || record.sourceMtimeMs === undefined || !record.pinUntil) return { status: "rejected", adoptionKey, reason: "rollback is unavailable before durable adoption" };
    const rollbackDeadline = record.deadline; const clock = now(deps);
    if (!await freezeAdmissionCall(rootDir, record, deps)) return markRollbackFailure(rootDir, record, "associated Call/Delegation cannot be durably frozen", deps);
    if (!proofIsCurrent(bridgeProof, clock)) return markRollbackFailure(rootDir, record, "bridge production proof is expired", deps);
    if (clock.getTime() >= Date.parse(record.deadline)) return markRollbackFailure(rootDir, record, "rollback window has expired", deps);
    if (record.phase === "adopted") record = await updateRecord(rootDir, record, "rollback_frozen", deps);
    if (!await proveRollbackLiveness(record, deps)) return markRollbackFailure(rootDir, record, "v2 owner/child death, action, outbox, or cleanup proof is incomplete", deps);
    const sourceLock = await acquireIdentityLock({ rootDir, key: record.sourceKey }); if (!sourceLock) return { status: "busy", adoptionKey, reason: "v1 source identity lock is busy" };
    try {
      const source = await adoptionSource(rootDir, record);
      if (!await proveSourceAbsent(deps, source, sourceLock)) return markRollbackFailure(rootDir, record, "v1 writer, child, or lock absence is not proven", deps);
      let snapshot: SourceSnapshot; try { snapshot = await stableSourceSnapshot(deps, source, { parentSessionId: record.parentSessionId, cwd: record.cwd, target: record.target, v1Handle: record.v1Handle, v1Session: record.v1Session }, sourceLock); } catch (error) { return markRollbackFailure(rootDir, record, error instanceof Error ? error.message : "v1 source/header/handle cannot be proven", deps); }
      if (snapshot.key !== record.sourceKey || snapshot.digest !== record.sourceDigest || snapshot.mtimeMs !== record.sourceMtimeMs) return markRollbackFailure(rootDir, record, "v1 source digest or mtime changed", deps);
      const pin = await inspectPreservationPinAtLock({ rootDir, sourceHash: record.sourceKey }, { now: () => clock }); if (pin.state !== "valid" || !pin.pin || Date.parse(pin.pin.pinUntil) < Date.parse(rollbackDeadline)) return markRollbackFailure(rootDir, record, "bridge preservation pin is missing or invalid", deps);
      const namespace = record.v2Namespace; const quarantineRoot = path.join(rootDir, "v2", "quarantine"); await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 }); if (!ownerDirectorySync(quarantineRoot)) return markRollbackFailure(rootDir, record, "v2 quarantine identity cannot be proven", deps);
      if (record.phase === "rollback_frozen") {
        const inspected = await inspectCopiedNamespace(rootDir, record, namespace); if (!inspected) return markRollbackFailure(rootDir, record, "v2 namespace cannot be frozen safely", deps);
        const binding = rollbackBinding(rootDir, record, inspected.namespaceDigest); record = await updateRecord(rootDir, record, "rollback_quarantine_planned", deps, binding);
      }
      if (!recordedBinding(rootDir, record) || !await appendRollbackPlanFact(rootDir, record, deps)) return markRollbackFailure(rootDir, record, "durable rollback quarantine plan cannot be proven", deps);
      if (!await ensureQuarantineIdempotent(rootDir, record, deps)) return markRollbackIntegrity(rootDir, record, "rollback quarantine source and destination integrity cannot be proven", deps);
      record = await updateRecord(rootDir, record, "rolled_back", deps, { rollbackDisposition: "legacy_v1_explicit_handle_only" });
      try {
        const released = await releasePreservationPinAtLock({ rootDir, sourceHash: record.sourceKey }, { now: () => clock });
        if (!["released", "absent"].includes(released.status)) return { status: "rolled_back", adoptionKey, disposition: "legacy_v1_explicit_handle_only", reason: "rollback is complete; preservation pin release needs maintenance retry" };
      } catch { return { status: "rolled_back", adoptionKey, disposition: "legacy_v1_explicit_handle_only", reason: "rollback is complete; preservation pin release needs maintenance retry" }; }
      return { status: "rolled_back", adoptionKey, disposition: "legacy_v1_explicit_handle_only" };
    } finally { await sourceLock.release(); }
  });
  return result ?? { status: "busy", adoptionKey };
}
export const rollbackV1AdoptionInternal = rollbackAdoptedV1Internal;

/** Synchronous cleanup preflight. It is deliberately conservative: only a
 * verified rolled_back record can release a reference; expiry never releases it. */
function verifiedQuarantineSync(rootDir: string, record: AdoptionRecord): boolean {
  try {
    const binding = recordedBinding(rootDir, record); if (!binding) return false;
    const destination = path.join(rootDir, binding.rollbackDestinationRelative); const stat = nodeFs.lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerDirectorySync(destination) || hashPath(destination) !== binding.rollbackDestinationPathHash) return false;
    const namespaceEntries = nodeFs.readdirSync(destination, { withFileTypes: true }); if (namespaceEntries.length !== 2 || !namespaceEntries.some((entry) => entry.name === "header.json" && entry.isFile()) || !namespaceEntries.some((entry) => entry.name === "branch" && entry.isDirectory())) return false;
    const header = JSON.parse(nodeFs.readFileSync(path.join(destination, "header.json"), "utf8")) as Record<string, unknown>;
    if (header.version !== 1 || header.sourceKey !== record.sourceKey || header.sourceDigest !== record.sourceDigest || header.sourceMtimeMs !== record.sourceMtimeMs || header.v1Handle !== record.v1Handle || header.v1Session !== record.v1Session || !SHA256.test(String(header.branchDigest))) return false;
    const rows: Array<{ relative: string; digest: string; bytes: number }> = [];
    const walk = (directory: string, relative = ""): void => {
      const directoryStat = nodeFs.lstatSync(directory); if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !ownerDirectorySync(directory)) throw new Error("unsafe quarantine namespace");
      for (const entry of nodeFs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = path.join(directory, entry.name); const childRelative = relative ? path.join(relative, entry.name) : entry.name; const childStat = nodeFs.lstatSync(child);
        if (entry.isSymbolicLink() || childStat.isSymbolicLink() || (entry.isDirectory() && !ownerDirectorySync(child)) || (entry.isFile() && (childStat.nlink !== 1 || !ownerFileSync(child)))) throw new Error("unsafe quarantine entry");
        if (entry.isDirectory()) walk(child, childRelative);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) { const content = nodeFs.readFileSync(child, "utf8"); for (const line of content.split("\n")) if (line.trim() !== "") JSON.parse(line); rows.push({ relative: childRelative, digest: digest(content), bytes: Buffer.byteLength(content) }); }
        else throw new Error("unexpected quarantine entry");
      }
    };
    walk(path.join(destination, "branch"));
    const branchDigest = digest(JSON.stringify(rows)); if (branchDigest !== header.branchDigest) return false;
    const namespaceDigest = digest(JSON.stringify({ sourceKey: header.sourceKey, sourceDigest: header.sourceDigest, sourceMtimeMs: header.sourceMtimeMs, v1Handle: header.v1Handle, v1Session: header.v1Session, branchDigest }));
    return namespaceDigest === binding.rollbackSourceNamespaceDigest && hashPath(path.join(sessionRoot(rootDir), record.adoptionKey)) === binding.rollbackSourceNamespaceIdentity;
  } catch { return false; }
}
function verifiedAdmissionSync(rootDir: string, record: AdoptionRecord): boolean {
  try {
    const wal = path.join(rootDir, "v2", "wal", `${record.dispatchCallId}.jsonl`); const stat = nodeFs.lstatSync(wal);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !ownerFileSync(wal)) return false;
    const events = nodeFs.readFileSync(wal, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const admitted = events.find((event) => event.type === "call_admitted" && event.callId === record.dispatchCallId); const delegation = events.find((event) => event.type === "delegation_admitted" && event.delegationId === record.delegationId && event.callId === record.dispatchCallId);
    if (!admitted || !delegation || !verifiedQuarantineSync(rootDir, record)) return false;
    const callPrivate = path.join(rootDir, "v2", "private", `call-${record.dispatchCallId}.json`); const delegationPrivate = path.join(rootDir, "v2", "private", `${record.delegationId}.json`);
    try {
      const callPayload = JSON.parse(nodeFs.readFileSync(callPrivate, "utf8")) as Record<string, unknown>; const item = Array.isArray(callPayload.items) ? callPayload.items[0] as Record<string, unknown> : undefined; const delegationPayload = JSON.parse(nodeFs.readFileSync(delegationPrivate, "utf8")) as Record<string, unknown>;
      const data = delegation.data as Record<string, unknown>; return !!item && item.agent === record.target && item.task !== undefined && digest(String(item.task)) === record.taskDigest && item.cwd === record.cwd && callPayload.cwd === record.cwd && callPayload.parentSessionId === record.parentSessionId && JSON.stringify(callPayload.lineage) === JSON.stringify(record.lineage) && !!delegationPayload.item && JSON.stringify(delegationPayload.item) === JSON.stringify(item) && data.parentSessionId === record.parentSessionId && data.activeLineageId === record.activeLineageId && data.activeBranchAnchor === record.activeBranchAnchor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || record.phase !== "rolled_back") return false;
      return verifiedQuarantineSync(rootDir, record);
    }
  } catch { return false; }
}
export function hasLiveAdoptionReferenceSync(rootDir: string, objectId: string, _at = new Date()): boolean {
  try {
    const directory = adoptionRoot(rootDir); if (!nodeFs.existsSync(directory)) return false; const directoryStat = nodeFs.lstatSync(directory); if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !ownerDirectorySync(directory)) return true;
    for (const entry of nodeFs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) return true;
      const file = path.join(directory, entry.name); const stat = nodeFs.lstatSync(file); if (stat.nlink !== 1 || !ownerFileSync(file)) return true;
      const record = JSON.parse(nodeFs.readFileSync(file, "utf8")) as unknown;
      if (!validRecord(record) || record.v2Namespace !== path.join(sessionRoot(rootDir), record.adoptionKey)) return true;
      const associated = record.dispatchCallId === objectId || record.delegationId === objectId;
      if (!associated) continue;
      // Prepared and every in-flight/failed phase are permanent blockers. A
      // rolled_back record is releasable only after its quarantine/admission
      // proof is still durable; this path never acquires a source lock.
      if (record.phase !== "rolled_back" || !verifiedAdmissionSync(rootDir, record)) return true;
    }
    return false;
  } catch { return true; }
}

export function isAdoptionRecord(value: unknown): value is AdoptionRecord { return validRecord(value); }
export type { BridgeProductionProof };
