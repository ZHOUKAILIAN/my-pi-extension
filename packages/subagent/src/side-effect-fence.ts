import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { actionIdFor, beginActionIntentInternal, canonicalArgsDigest, finishActionResultInternal, stableIdempotencyKeyFor } from "./action-ledger.ts";
import type { OwnerClaim } from "./execution-supervisor.ts";
import type { ActionPolicyClassification, DelegationFoundationDependencies } from "./delegation-types.ts";
import { appendWal, loadView, materialize, withCallLock } from "./delegation-context.ts";
import { hash, dirs } from "./delegation-context.ts";
import { atomicOwnerJson, ownerDirectorySync, ownerFileSync, ownerOwned, readStableOwnerFileSync, syncDirectory, OWNER_ONLY_DIR, OWNER_ONLY_FILE } from "./secure-fs.ts";

export const SIDE_EFFECT_FENCE_PROTOCOL = 1 as const;
export const SIDE_EFFECT_FENCE_EXTENSION_VERSION = "1.0.0" as const;
export const SIDE_EFFECT_FENCE_MAX_FRAME = 32 * 1024;
export const SIDE_EFFECT_FENCE_MAX_JSON = 16 * 1024;
export const SIDE_EFFECT_FENCE_TIMEOUT_MS = 5_000;
export const SIDE_EFFECT_FENCE_RUNNER_VERSION = "subagent-runner/1" as const;
const DEPLOYMENT_PROOF_BRAND = Symbol("side-effect-fence-deployment-proof");
const REATTACH_PROOF_BRAND = Symbol("side-effect-fence-reattach-proof");
const isSafeParameter = (value: string): boolean => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const ENV_SOCKET = "PI_SUBAGENT_FENCE_SOCKET";
const ENV_NONCE = "PI_SUBAGENT_FENCE_NONCE";
const ENV_PROTOCOL = "PI_SUBAGENT_FENCE_PROTOCOL";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_REF = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SideEffectFencePolicyDescriptor {
  toolName: string;
  classification: ActionPolicyClassification;
  /** Only this explicitly declared parameter may receive a stable key. */
  idempotencyParameter?: string;
  externalSystemSupportsKey?: boolean;
}
type PolicyDescriptor = SideEffectFencePolicyDescriptor;

export type SideEffectFencePackageEntryRole = "preprocessor" | "fence";

export interface SideEffectFenceExtensionSpec {
  /** The launch path must be inside the verified immutable snapshot. */
  path: string;
  /** Derived from the package manifest; caller-provided role is never trusted. */
  entryRole?: SideEffectFencePackageEntryRole;
  version: string;
  digest: string;
  toolNames: readonly string[];
  /** Only a verifier-approved preprocessor may be loaded before the fence. */
  preprocessor: true;
  snapshotRoot: string;
  snapshotManifestPath: string;
  snapshotManifestDigest: string;
  snapshotDigest: string;
  /** Required for admission-bound third-party entries. */
  packagePath?: string;
  packageName?: string;
  packageVersion?: string;
  entryRealpath?: string;
  entryDigest?: string;
  entryRelativePath?: string;
  toolSetDigest?: string;
  packageManifestDigest?: string;
}

export interface SideEffectFenceInterceptorSpec extends SideEffectFenceExtensionSpec {
  packagePath: string;
  packageName: string;
  packageVersion: string;
  entryRealpath: string;
  entryDigest: string;
  entryRelativePath: string;
  toolSetDigest: string;
  packageManifestDigest: string;
  fenceLast: true;
}

export interface SideEffectFencePolicySnapshot {
  version: string;
  source: "admission-bound" | "immutable-test-seam";
  tools: readonly PolicyDescriptor[];
}

export interface SideEffectFenceDeploymentProof {
  readonly [DEPLOYMENT_PROOF_BRAND]: true;
  readonly version: 1;
  readonly capability: "pi-0.84.4-side-effect-fence";
  readonly verified: true;
  readonly protocol: typeof SIDE_EFFECT_FENCE_PROTOCOL;
  readonly manifestDigest: string;
  readonly runnerVersion: typeof SIDE_EFFECT_FENCE_RUNNER_VERSION;
  readonly expiresAt: string;
  readonly nonce: string;
}
export interface SideEffectFenceReattachProof {
  readonly [REATTACH_PROOF_BRAND]: true;
  readonly version: 1;
  readonly deploymentProof: SideEffectFenceDeploymentProof;
  readonly delegationId: string;
  readonly spawnId: string;
  readonly ownerGeneration: number;
  readonly fencingGeneration: number;
  readonly channelDigest: string;
}
export interface SideEffectFenceClientDeploymentProof {
  readonly [DEPLOYMENT_PROOF_BRAND]: true;
  readonly version: 1;
  readonly protocol: typeof SIDE_EFFECT_FENCE_PROTOCOL;
  readonly manifestDigest: string;
  readonly runnerVersion: typeof SIDE_EFFECT_FENCE_RUNNER_VERSION;
  readonly expiresAt: string;
  readonly nonceDigest: string;
}

export interface SideEffectFenceConfig {
  /** This is an internal opt-in. It is never enabled by the package root. */
  enabled: true;
  required?: boolean;
  allowlist: readonly SideEffectFenceExtensionSpec[];
  policy: SideEffectFencePolicySnapshot;
  interceptorPath?: string;
  handshakeTimeoutMs?: number;
  /** Capability gate: absent/false never permits supervisor spawn. */
  deploymentVerification?: SideEffectFenceDeploymentProof;
}

export interface SideEffectFenceHandshakeBinding {
  dispatchCallId: string;
  delegationId: string;
  executionScope: string;
  reservationId: string;
  owner: string;
  ownerGeneration: number;
  fencingGeneration: number;
  childIdentityRef: string;
  allowlistManifestDigest: string;
  extensionOrderDigest: string;
  toolSetDigest: string;
  policyDigest: string;
  interceptorRealpath: string;
  interceptorDigest: string;
  interceptorVersion: string;
  fenceLastProof: string;
}

export interface SideEffectFenceClientConfig {
  socket: string;
  nonce: string;
  protocol: number;
  extensions: readonly string[];
  interceptor: string;
  handshake?: SideEffectFenceHandshakeBinding;
  deploymentProof?: SideEffectFenceClientDeploymentProof;
  /** Parent-only lifecycle owner; never serialized to the child. */
  bindChild?: (pid: number, childSessionId: string) => Promise<boolean | void>;
  /** Parent-only lifecycle owner; never serialized to the child. */
  awaitHandshake?: (timeoutMs?: number) => Promise<boolean>;
  /** Parent-only graceful close proof; never serialized to the child. */
  awaitGraceful?: (timeoutMs?: number) => Promise<boolean>;
  /** Parent-only idempotent cleanup; never serialized to the child. */
  close?: (reason?: string) => Promise<void>;
  /** Parent-only watchdog signal; never serialized to the child. */
  failure?: Promise<string>;
  /** Internal lifecycle timeout seam; never serialized to the child. */
  timeoutMs?: number;
}

export interface SideEffectFenceServerOptions {
  rootDir: string;
  dispatchCallId: string;
  delegationId: string;
  executionScope: string;
  reservationId: string;
  continuationEpoch: number;
  claim: OwnerClaim;
  config: SideEffectFenceConfig;
  deps?: DelegationFoundationDependencies;
}

export interface SideEffectFenceServer {
  readonly client: SideEffectFenceClientConfig;
  readonly directory: string;
  readonly socket: string;
  bindChild(childPid: number, childSessionId: string): Promise<boolean | void>;
  awaitHandshake(timeoutMs?: number): Promise<boolean>;
  awaitGraceful(timeoutMs?: number): Promise<boolean>;
  close(reason?: string): Promise<void>;
}

type Frame = Record<string, unknown>;

type HandledAction = {
  fingerprint: string;
  actionId?: string;
  response: Frame;
};

function exactKeys(value: Frame, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function string(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => jsonValue(item, depth + 1));
  if (typeof value === "object") return Object.keys(value as object).length <= 256 && Object.entries(value as Record<string, unknown>).every(([key, item]) => string(key, 128) && jsonValue(item, depth + 1));
  return false;
}
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite"); return value; }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  throw new Error("unsupported json value");
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function validExpiry(value: string): boolean { return Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now(); }
function nonceDigest(nonce: string): string { return digest(["side-effect-fence", nonce]); }

/** Explicitly test-only verifier seam. It is not exported from the package root. */
export function createSideEffectFenceTestDeploymentProof(input: { manifestDigest: string; expiresAt?: string; nonce?: string }): SideEffectFenceDeploymentProof {
  const nonce = input.nonce ?? randomUUID().replaceAll("-", "");
  if (!/^[0-9a-f]{64}$/.test(input.manifestDigest) || !validExpiry(input.expiresAt ?? new Date(Date.now() + 60_000).toISOString())) throw new Error("invalid deployment proof seam input");
  return Object.freeze({ [DEPLOYMENT_PROOF_BRAND]: true as const, version: 1 as const, capability: "pi-0.84.4-side-effect-fence" as const, verified: true as const, protocol: SIDE_EFFECT_FENCE_PROTOCOL, manifestDigest: input.manifestDigest, runnerVersion: SIDE_EFFECT_FENCE_RUNNER_VERSION, expiresAt: input.expiresAt ?? new Date(Date.now() + 60_000).toISOString(), nonce });
}
function validDeploymentProof(proof: SideEffectFenceDeploymentProof, manifestDigest?: string): boolean {
  return proof[DEPLOYMENT_PROOF_BRAND] === true && proof.version === 1 && proof.capability === "pi-0.84.4-side-effect-fence" && proof.verified === true && proof.protocol === SIDE_EFFECT_FENCE_PROTOCOL && (!manifestDigest || proof.manifestDigest === manifestDigest) && /^[0-9a-f]{64}$/.test(proof.manifestDigest) && proof.runnerVersion === SIDE_EFFECT_FENCE_RUNNER_VERSION && validExpiry(proof.expiresAt) && typeof proof.nonce === "string" && proof.nonce.length >= 16;
}
export function sideEffectFenceReattachChannelDigest(input: { deploymentProof: SideEffectFenceDeploymentProof; delegationId: string; spawnId: string; ownerGeneration: number; fencingGeneration: number }): string { return digest({ protocol: SIDE_EFFECT_FENCE_PROTOCOL, manifestDigest: input.deploymentProof.manifestDigest, delegationId: input.delegationId, spawnId: input.spawnId, ownerGeneration: input.ownerGeneration, fencingGeneration: input.fencingGeneration }); }
export function createSideEffectFenceTestReattachProof(input: { deploymentProof: SideEffectFenceDeploymentProof; delegationId: string; spawnId: string; ownerGeneration: number; fencingGeneration: number; channelDigest?: string }): SideEffectFenceReattachProof {
  const channelDigest = sideEffectFenceReattachChannelDigest(input);
  if (!validDeploymentProof(input.deploymentProof) || (input.channelDigest !== undefined && input.channelDigest !== channelDigest)) throw new Error("invalid reattach proof seam input");
  return Object.freeze({ [REATTACH_PROOF_BRAND]: true as const, version: 1 as const, deploymentProof: input.deploymentProof, delegationId: input.delegationId, spawnId: input.spawnId, ownerGeneration: input.ownerGeneration, fencingGeneration: input.fencingGeneration, channelDigest });
}
function issueClientDeploymentProof(proof: SideEffectFenceDeploymentProof, manifestDigest: string, nonce: string): SideEffectFenceClientDeploymentProof {
  if (!validDeploymentProof(proof, manifestDigest)) throw new Error("deployment proof is not bound to this manifest");
  return Object.freeze({ [DEPLOYMENT_PROOF_BRAND]: true as const, version: 1 as const, protocol: SIDE_EFFECT_FENCE_PROTOCOL, manifestDigest, runnerVersion: SIDE_EFFECT_FENCE_RUNNER_VERSION, expiresAt: proof.expiresAt, nonceDigest: nonceDigest(nonce) });
}
export function createSideEffectFenceTestClientProof(proof: SideEffectFenceDeploymentProof, manifestDigest: string, nonce: string): SideEffectFenceClientDeploymentProof { return issueClientDeploymentProof(proof, manifestDigest, nonce); }
export function sideEffectFenceClientProofValid(client: SideEffectFenceClientConfig): boolean {
  const proof = client.deploymentProof;
  const binding = client.handshake;
  const manifestDigest = binding?.allowlistManifestDigest;
  let interceptorMatches = false;
  try { const stable = binding && readStableOwnerFileSync(client.interceptor); interceptorMatches = !!stable && stable.realpath === binding.interceptorRealpath && stable.digest === binding.interceptorDigest && binding.interceptorVersion === SIDE_EFFECT_FENCE_EXTENSION_VERSION; } catch { interceptorMatches = false; }
  const extensionsAreSafe = new Set(client.extensions).size === client.extensions.length && !client.extensions.includes(client.interceptor);
  return !!proof && !!binding && typeof client.bindChild === "function" && typeof client.awaitHandshake === "function" && typeof client.awaitGraceful === "function" && typeof client.close === "function" && interceptorMatches && extensionsAreSafe && client.protocol === SIDE_EFFECT_FENCE_PROTOCOL && proof[DEPLOYMENT_PROOF_BRAND] === true && proof.version === 1 && proof.protocol === SIDE_EFFECT_FENCE_PROTOCOL && proof.runnerVersion === SIDE_EFFECT_FENCE_RUNNER_VERSION && typeof proof.manifestDigest === "string" && proof.manifestDigest === manifestDigest && validExpiry(proof.expiresAt) && proof.nonceDigest === nonceDigest(client.nonce);
}
export function sideEffectFenceDeploymentVerified(config: SideEffectFenceConfig, manifestDigest?: string): boolean {
  const proof = config.deploymentVerification;
  return !!proof && validDeploymentProof(proof, manifestDigest);
}
export function sideEffectFenceReattachProofValid(proof: unknown, expected: { deploymentProof: SideEffectFenceDeploymentProof; delegationId: string; spawnId: string; ownerGeneration: number; fencingGeneration: number }): proof is SideEffectFenceReattachProof {
  if (!proof || typeof proof !== "object") return false;
  const value = proof as SideEffectFenceReattachProof;
  return value[REATTACH_PROOF_BRAND] === true && value.version === 1 && validDeploymentProof(value.deploymentProof, expected.deploymentProof.manifestDigest) && value.delegationId === expected.delegationId && value.spawnId === expected.spawnId && value.ownerGeneration === expected.ownerGeneration && value.fencingGeneration === expected.fencingGeneration && value.channelDigest === sideEffectFenceReattachChannelDigest(expected);
}
export function sideEffectFenceToolSetDigest(toolNames: readonly string[]): string { return digest(toolNames); }
export function sideEffectFencePolicyDigest(policy: SideEffectFencePolicySnapshot): string { return digest({ version: policy.version, source: policy.source, tools: policy.tools }); }
export interface SideEffectFenceBinding {
  manifestDigest: string;
  protocol: typeof SIDE_EFFECT_FENCE_PROTOCOL;
  policyDigest: string;
  toolSetDigest: string;
  runnerVersion: typeof SIDE_EFFECT_FENCE_RUNNER_VERSION;
}
export function sideEffectFenceBinding(config: SideEffectFenceConfig): SideEffectFenceBinding {
  const built = buildSideEffectFenceExtensions(config);
  return { manifestDigest: built.manifestDigest, protocol: SIDE_EFFECT_FENCE_PROTOCOL, policyDigest: built.policyDigest, toolSetDigest: built.toolSetDigest, runnerVersion: SIDE_EFFECT_FENCE_RUNNER_VERSION };
}
export function sideEffectFenceBindingMatches(binding: SideEffectFenceBinding, config: SideEffectFenceConfig): boolean {
  try { const actual = sideEffectFenceBinding(config); return actual.manifestDigest === binding.manifestDigest && actual.protocol === binding.protocol && actual.policyDigest === binding.policyDigest && actual.toolSetDigest === binding.toolSetDigest && actual.runnerVersion === binding.runnerVersion; } catch { return false; }
}
export function sideEffectFencePackageManifestDigest(manifest: unknown): string { return digest(manifest); }
export function sideEffectFenceSnapshotDigest(entryDigest: string, manifestDigest: string): string { return digest({ entry: entryDigest, manifest: manifestDigest }); }
function safeHash(value: unknown): string { try { return `ref:${digest(value).slice(0, 32)}`; } catch { return "ref:invalid"; } }
function frameBytes(frame: Frame): Buffer {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, "utf8") > SIDE_EFFECT_FENCE_MAX_JSON) throw new Error("frame too large");
  return Buffer.from(`${text}\n`, "utf8");
}
function validSocket(socket: string): boolean {
  try {
    const stat = nodeFs.lstatSync(socket);
    return stat.isSocket() && !stat.isSymbolicLink() && ownerOwned(stat) && stat.nlink === 1 && (stat.mode & 0o777) === 0o600;
  } catch { return false; }
}
function strictSnapshotFile(file: string, snapshotRoot: string, expectedMode: number): ReturnType<typeof readStableOwnerFileSync> {
  if (!path.isAbsolute(file) || !path.isAbsolute(snapshotRoot)) return undefined;
  const root = path.resolve(snapshotRoot); const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    try { const stat = nodeFs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOwned(stat) || ![0o700, 0o500].includes(stat.mode & 0o777)) return undefined; } catch { return undefined; }
  }
  try { const rootStat = nodeFs.lstatSync(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !ownerOwned(rootStat) || ![0o700, 0o500].includes(rootStat.mode & 0o777)) return undefined; } catch { return undefined; }
  const stable = readStableOwnerFileSync(resolved);
  if (!stable || stable.realpath !== resolved || stable.stat.nlink !== 1 || ![expectedMode, expectedMode === 0o600 ? 0o400 : expectedMode].includes(stable.stat.mode & 0o777)) return undefined;
  return stable;
}
function relativeSnapshotPath(root: string, file: string): string | undefined {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part === ".." || part === ".")) return undefined;
  return relative;
}
function snapshotManifestFiles(manifest: ReturnType<typeof readStableOwnerFileSync>): Record<string, unknown> | undefined {
  if (!manifest) return undefined;
  try {
    const parsed = JSON.parse(manifest.content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const files = (parsed as Record<string, unknown>).files;
    return files && typeof files === "object" && !Array.isArray(files) ? files as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
interface PackageEntryDeclaration {
  extensions: string[];
  recoveryFenceExtensions: Array<{ path: string; role: "fence" }>;
}
function packageRelativePath(value: string): string | undefined {
  if (!value || value.includes("\\") || value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) return undefined;
  return value;
}
function parsePackageEntryDeclaration(manifestObject: Record<string, unknown>, files: Record<string, unknown>, packageRoot: string, snapshotRoot: string): PackageEntryDeclaration | undefined {
  const pi = manifestObject.pi;
  if (!pi || typeof pi !== "object" || Array.isArray(pi)) return undefined;
  const piObject = pi as Record<string, unknown>;
  if (Object.keys(piObject).some((key) => key !== "extensions" && key !== "recoveryFenceExtensions") || !Array.isArray(piObject.extensions) || !Array.isArray(piObject.recoveryFenceExtensions)) return undefined;
  const extensions = piObject.extensions.map((entry) => typeof entry === "string" ? packageRelativePath(entry) : undefined);
  if (extensions.some((entry) => !entry) || new Set(extensions).size !== extensions.length) return undefined;
  const recoveryFenceExtensions = piObject.recoveryFenceExtensions.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const value = entry as Record<string, unknown>;
    if (Object.keys(value).some((key) => key !== "path" && key !== "role") || typeof value.path !== "string" || value.role !== "fence") return undefined;
    const relative = packageRelativePath(value.path);
    return relative ? { path: relative, role: "fence" as const } : undefined;
  });
  if (recoveryFenceExtensions.some((entry) => !entry) || new Set(recoveryFenceExtensions.map((entry) => entry!.path)).size !== recoveryFenceExtensions.length) return undefined;
  if (extensions.some((entry) => recoveryFenceExtensions.some((fence) => fence!.path === entry))) return undefined;
  for (const entry of [...extensions, ...recoveryFenceExtensions.map((item) => item!.path)]) {
    const absolute = path.join(packageRoot, entry!);
    const relative = relativeSnapshotPath(snapshotRoot, absolute);
    if (!relative || files[relative] === undefined) return undefined;
  }
  return { extensions: extensions as string[], recoveryFenceExtensions: recoveryFenceExtensions as Array<{ path: string; role: "fence" }> };
}
function validatePackageProof(spec: SideEffectFenceExtensionSpec, stable: NonNullable<ReturnType<typeof readStableOwnerFileSync>>, snapshotRoot: string, expectedRole: SideEffectFencePackageEntryRole, manifest: ReturnType<typeof readStableOwnerFileSync>): { packageRealpath: string; entryRelativePath: string; packageEntries: PackageEntryDeclaration } | undefined {
  if (!spec.packagePath || path.basename(spec.packagePath) !== "package.json" || !spec.packageName || !spec.packageVersion || !spec.entryRealpath || !spec.entryDigest || !spec.toolSetDigest || !spec.packageManifestDigest) return undefined;
  const packageFile = strictSnapshotFile(spec.packagePath, snapshotRoot, 0o600);
  const entryRelativePath = relativeSnapshotPath(snapshotRoot, stable.realpath);
  const packageRelativePath = relativeSnapshotPath(snapshotRoot, spec.packagePath);
  const packageRoot = packageFile && path.dirname(packageFile.realpath);
  const expectedEntryRelativePath = packageRoot && path.relative(packageRoot, stable.realpath);
  if (!packageFile || !entryRelativePath || !packageRelativePath || !expectedEntryRelativePath || packageRelativePath !== path.relative(path.resolve(snapshotRoot), packageFile.realpath) || packageFile.realpath !== path.resolve(spec.packagePath) || spec.entryRealpath !== stable.realpath || spec.entryDigest !== stable.digest || (spec.entryRelativePath !== undefined && spec.entryRelativePath.replaceAll("\\", "/") !== expectedEntryRelativePath.replaceAll("\\", "/")) || path.isAbsolute(expectedEntryRelativePath) || expectedEntryRelativePath.split(path.sep).some((part) => part === ".." || part === ".") || !stable.realpath.startsWith(`${packageRoot}${path.sep}`)) return undefined;
  const files = snapshotManifestFiles(manifest);
  if (!files || files[entryRelativePath] !== stable.digest || files[packageRelativePath] !== packageFile.digest) return undefined;
  let manifestObject: Record<string, unknown>;
  try { const parsed = JSON.parse(packageFile.content) as unknown; if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined; manifestObject = parsed as Record<string, unknown>; } catch { return undefined; }
  if (manifestObject.name !== spec.packageName || manifestObject.version !== spec.packageVersion || !/^[@A-Za-z0-9._/-]+$/.test(spec.packageName) || !/^\d+\.\d+\.\d+$/.test(spec.packageVersion)) return undefined;
  const packageEntries = parsePackageEntryDeclaration(manifestObject, files, packageRoot, snapshotRoot);
  const normalizedEntry = expectedEntryRelativePath.replaceAll("\\", "/");
  const declared = expectedRole === "preprocessor" ? packageEntries?.extensions.includes(normalizedEntry) : packageEntries?.recoveryFenceExtensions.some((entry) => entry.path === normalizedEntry && entry.role === "fence");
  if (!packageEntries || !declared) return undefined;
  if (spec.packageManifestDigest !== digest(manifestObject) || spec.toolSetDigest !== digest(spec.toolNames)) return undefined;
  return { packageRealpath: packageFile.realpath, entryRelativePath: expectedEntryRelativePath, packageEntries };
}
function validExtension(spec: SideEffectFenceExtensionSpec): SideEffectFenceExtensionSpec & { realpath: string; packageRealpath: string; packageEntries: PackageEntryDeclaration } | undefined {
  if (typeof spec.snapshotRoot !== "string" || typeof spec.snapshotManifestPath !== "string" || !path.isAbsolute(spec.path) || !path.isAbsolute(spec.snapshotRoot) || !path.isAbsolute(spec.snapshotManifestPath) || spec.preprocessor !== true || !/^\d+\.\d+\.\d+$/.test(spec.version) || !/^[0-9a-f]{64}$/.test(spec.digest) || !/^[0-9a-f]{64}$/.test(spec.snapshotDigest) || !/^[0-9a-f]{64}$/.test(spec.snapshotManifestDigest) || spec.toolNames.length > 256) return undefined;
  const stable = strictSnapshotFile(spec.path, spec.snapshotRoot, 0o600);
  const manifest = strictSnapshotFile(spec.snapshotManifestPath, spec.snapshotRoot, 0o600);
  const entryRelativePath = stable && relativeSnapshotPath(spec.snapshotRoot, stable.realpath);
  const files = snapshotManifestFiles(manifest);
  if (!stable || !manifest || !entryRelativePath || stable.realpath !== path.resolve(spec.path) || stable.digest !== spec.digest || manifest.digest !== spec.snapshotManifestDigest || digest({ entry: stable.digest, manifest: manifest.digest }) !== spec.snapshotDigest || files?.[entryRelativePath] !== stable.digest || (spec.entryRealpath !== undefined && spec.entryRealpath !== stable.realpath) || (spec.entryDigest !== undefined && spec.entryDigest !== stable.digest) || (spec.entryRelativePath !== undefined && spec.entryRelativePath !== entryRelativePath)) return undefined;
  if (new Set(spec.toolNames).size !== spec.toolNames.length || spec.toolNames.some((name) => !SAFE_ID.test(name))) return undefined;
  const toolSetDigest = digest(spec.toolNames);
  if (spec.toolSetDigest !== undefined && spec.toolSetDigest !== toolSetDigest) return undefined;
  const packageProof = validatePackageProof(spec, stable, spec.snapshotRoot, "preprocessor", manifest);
  if (!packageProof) return undefined;
  return { ...spec, realpath: stable.realpath, entryRelativePath: packageProof.entryRelativePath, packageRealpath: packageProof.packageRealpath, packageEntries: packageProof.packageEntries };
}

export function sideEffectFenceExtensionPath(): string { return path.resolve(fileURLToPath(new URL("./side-effect-fence-extension.ts", import.meta.url))); }

export function sideEffectFenceExtensionDigest(): string {
  const file = sideEffectFenceExtensionPath(); const stat = nodeFs.lstatSync(file);
  if ((stat.mode & 0o777) !== 0o600) throw new Error("source extension is not an immutable launch snapshot");
  const stable = readStableOwnerFileSync(file);
  if (!stable) throw new Error("source extension is not an immutable launch snapshot");
  return stable.digest;
}

/** Test-only immutable launch snapshot builder. Production verification is intentionally not inferred from source files. */
export async function createSideEffectFenceTestSnapshot(rootDir: string, files: Readonly<Record<string, string>>): Promise<{ root: string; files: Record<string, string>; manifestPath: string; manifestDigest: string }> {
  const parent = path.resolve(rootDir); await fs.mkdir(parent, { recursive: true, mode: OWNER_ONLY_DIR });
  if (!ownerDirectorySync(parent)) throw new Error("snapshot parent is not owner-only");
  const temporary = await fs.mkdtemp(path.join(parent, ".snapshot-")); await fs.chmod(temporary, OWNER_ONLY_DIR);
  try {
    const output: Record<string, string> = {};
    const snapshotFiles: Record<string, string> = { ...files };
    if (snapshotFiles["package.json"] === undefined) {
      const extensionEntries = Object.keys(snapshotFiles).filter((relative) => relative !== "interceptor.ts");
      snapshotFiles["package.json"] = JSON.stringify({ name: "@pi/subagent-fence-test", version: "1.0.0", pi: { extensions: extensionEntries, recoveryFenceExtensions: Object.prototype.hasOwnProperty.call(snapshotFiles, "interceptor.ts") ? [{ path: "interceptor.ts", role: "fence" }] : [] } });
    }
    for (const [relative, content] of Object.entries(snapshotFiles)) {
      if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some((part) => part === ".." || part === ".")) throw new Error("invalid snapshot file");
      const target = path.join(temporary, relative); await fs.mkdir(path.dirname(target), { recursive: true, mode: OWNER_ONLY_DIR }); await fs.chmod(path.dirname(target), OWNER_ONLY_DIR); await fs.writeFile(target, content, { encoding: "utf8", mode: OWNER_ONLY_FILE }); await fs.chmod(target, OWNER_ONLY_FILE);
      const stable = readStableOwnerFileSync(target); if (!stable) throw new Error("snapshot file identity cannot be proven"); output[relative] = stable.digest;
    }
    const manifestRelative = ".launch-manifest.json"; const manifestPath = path.join(temporary, manifestRelative); const manifest = { version: 1, files: output }; await fs.writeFile(manifestPath, JSON.stringify(manifest), { encoding: "utf8", mode: OWNER_ONLY_FILE }); await fs.chmod(manifestPath, OWNER_ONLY_FILE); const manifestStable = readStableOwnerFileSync(manifestPath); if (!manifestStable) throw new Error("snapshot manifest identity cannot be proven"); await syncSnapshotTree(temporary); const finalRootPath = path.join(parent, `snapshot-${randomUUID().replaceAll("-", "")}`); await fs.rename(temporary, finalRootPath); await syncDirectory(parent); const finalRoot = await fs.realpath(finalRootPath); const finalFiles = Object.fromEntries(Object.entries(output).map(([relative]) => [relative, path.join(finalRoot, relative)])); return { root: finalRoot, files: finalFiles, manifestPath: path.join(finalRoot, manifestRelative), manifestDigest: manifestStable.digest };
  } catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
}
async function syncSnapshotTree(root: string): Promise<void> { const entries = await fs.readdir(root, { withFileTypes: true }); for (const entry of entries) { const candidate = path.join(root, entry.name); if (entry.isDirectory()) await syncSnapshotTree(candidate); else { const handle = await fs.open(candidate, nodeFs.constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } } } await syncDirectory(root); }
function sealSnapshotFiles(root: string): void { for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) { const candidate = path.join(root, entry.name); if (entry.isDirectory()) sealSnapshotFiles(candidate); else nodeFs.chmodSync(candidate, 0o400); } }
function sealSnapshotTree(root: string): void { sealSnapshotFiles(root); for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) { const candidate = path.join(root, entry.name); if (entry.isDirectory()) sealSnapshotTree(candidate); } nodeFs.chmodSync(root, 0o500); }
function unsealSnapshotTree(root: string): void { for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) { const candidate = path.join(root, entry.name); if (entry.isDirectory()) unsealSnapshotTree(candidate); else nodeFs.chmodSync(candidate, OWNER_ONLY_FILE); } nodeFs.chmodSync(root, OWNER_ONLY_DIR); }

/** Deterministic argv proof. It does not inspect settings or discover extensions. */
export function buildSideEffectFenceExtensions(config: SideEffectFenceConfig): { extensions: string[]; interceptor: string; digest: string; manifestDigest: string; allowlistDigest: string; extensionOrderDigest: string; toolSetDigest: string; policyDigest: string; interceptorSpec: SideEffectFenceInterceptorSpec } {
  if (config.enabled !== true || !Array.isArray(config.allowlist) || !config.policy || !Array.isArray(config.policy.tools)) throw new Error("side-effect fence opt-in is not explicit");
  if (config.policy.source !== "admission-bound" && config.policy.source !== "immutable-test-seam") throw new Error("untrusted action policy source");
  if (!/^\d+\.\d+\.\d+$/.test(config.policy.version) || config.policy.tools.length > 256 || (config.handshakeTimeoutMs !== undefined && (!Number.isSafeInteger(config.handshakeTimeoutMs) || config.handshakeTimeoutMs <= 0 || config.handshakeTimeoutMs > 60_000))) throw new Error("invalid policy version");
  const policyNames = new Set<string>();
  for (const policy of config.policy.tools) {
    if (!SAFE_ID.test(policy.toolName) || policyNames.has(policy.toolName) || (policy.classification !== "read_only" && policy.classification !== "fenced_mutating" && policy.classification !== "unsupported")) throw new Error("action policy mapping is not explicit");
    if (policy.idempotencyParameter !== undefined && (!isSafeParameter(policy.idempotencyParameter) || policy.externalSystemSupportsKey !== true || policy.classification !== "fenced_mutating")) throw new Error("idempotency injection is not policy-supported");
    policyNames.add(policy.toolName);
  }
  const specs = config.allowlist.map((spec) => validExtension(spec));
  if (specs.some((spec) => !spec)) throw new Error("extension allowlist identity cannot be proven");
  const valid = specs as Array<SideEffectFenceExtensionSpec & { realpath: string; packageRealpath: string; entryRelativePath: string; packageEntries: PackageEntryDeclaration }>;
  const seen = new Set<string>();
  for (const spec of valid) {
    if (seen.has(spec.realpath)) throw new Error("duplicate extension allowlist entry");
    seen.add(spec.realpath);
  }
  const packageAllowlist = new Map<string, { declared: PackageEntryDeclaration; paths: Set<string> }>();
  for (const spec of valid) {
    const existing = packageAllowlist.get(spec.packageRealpath) ?? { declared: spec.packageEntries, paths: new Set<string>() };
    existing.paths.add(spec.entryRelativePath.replaceAll("\\", "/"));
    packageAllowlist.set(spec.packageRealpath, existing);
  }
  for (const { declared, paths } of packageAllowlist.values()) {
    if (declared.extensions.length !== paths.size || declared.extensions.some((entry) => !paths.has(entry))) throw new Error("package pi.extensions is not the closed allowlist");
  }
  const interceptorPath = config.interceptorPath ? path.resolve(config.interceptorPath) : sideEffectFenceExtensionPath();
  const interceptorRoot = valid[0]?.snapshotRoot;
  const interceptor = interceptorRoot ? strictSnapshotFile(interceptorPath, interceptorRoot, 0o600) : undefined;
  if (!interceptor || interceptor.realpath !== interceptorPath) throw new Error("interceptor immutable snapshot cannot be proven");
  if (seen.has(interceptor.realpath)) throw new Error("interceptor is duplicated in allowlist");
  const declaredToolNames = new Set(valid.flatMap((spec) => spec.toolNames));
  if (declaredToolNames.size !== policyNames.size || [...declaredToolNames].some((name) => !policyNames.has(name))) throw new Error("action policy does not cover the allowlist tool set");
  const toolSetDigest = digest([...declaredToolNames].sort());
  const policyDigest = sideEffectFencePolicyDigest(config.policy);
  const interceptorRelativePath = relativeSnapshotPath(interceptorRoot!, interceptor.realpath);
  const interceptorEntryManifest = interceptorRoot ? strictSnapshotFile(path.join(interceptorRoot, ".launch-manifest.json"), interceptorRoot, 0o600) : undefined;
  let interceptorPackagePath: string | undefined;
  if (interceptorRoot) {
    let candidate = path.dirname(interceptor.realpath);
    while (candidate === path.resolve(interceptorRoot) || candidate.startsWith(`${path.resolve(interceptorRoot)}${path.sep}`)) {
      const packageCandidate = path.join(candidate, "package.json");
      if (strictSnapshotFile(packageCandidate, interceptorRoot, 0o600)) { interceptorPackagePath = packageCandidate; break; }
      const parent = path.dirname(candidate); if (parent === candidate) break; candidate = parent;
    }
  }
  const interceptorPackage = interceptorPackagePath && interceptorRoot ? strictSnapshotFile(interceptorPackagePath, interceptorRoot, 0o600) : undefined;
  let interceptorPackageObject: Record<string, unknown> | undefined;
  try { const parsed = interceptorPackage ? JSON.parse(interceptorPackage.content) as unknown : undefined; if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) interceptorPackageObject = parsed as Record<string, unknown>; } catch { /* fail below */ }
  if (!interceptorRelativePath || !interceptorEntryManifest || !interceptorPackage || path.basename(interceptorPackage.realpath) !== "package.json" || !interceptorPackageObject || typeof interceptorPackageObject.name !== "string" || typeof interceptorPackageObject.version !== "string") throw new Error("interceptor package proof cannot be proven");
  const interceptorFiles = snapshotManifestFiles(interceptorEntryManifest);
  const interceptorPackageRelativePath = relativeSnapshotPath(interceptorRoot!, interceptorPackage.realpath);
  if (!interceptorPackageRelativePath || interceptorFiles?.[interceptorRelativePath] !== interceptor.digest || interceptorFiles?.[interceptorPackageRelativePath] !== interceptorPackage.digest) throw new Error("interceptor snapshot manifest does not bind the package and entry");
  const interceptorPackageRoot = path.dirname(interceptorPackage.realpath);
  const interceptorPackageEntryPath = path.relative(interceptorPackageRoot, interceptor.realpath);
  const interceptorEntries = interceptorFiles && interceptorPackageObject ? parsePackageEntryDeclaration(interceptorPackageObject, interceptorFiles, interceptorPackageRoot, interceptorRoot!) : undefined;
  const normalizedInterceptorEntryPath = interceptorPackageEntryPath.replaceAll("\\", "/");
  const declaredFence = interceptorEntries?.recoveryFenceExtensions.filter((entry) => entry.path === normalizedInterceptorEntryPath && entry.role === "fence");
  if (!interceptorPackageEntryPath || path.isAbsolute(interceptorPackageEntryPath) || interceptorPackageEntryPath.split(path.sep).some((part) => part === ".." || part === ".") || !interceptor.realpath.startsWith(`${interceptorPackageRoot}${path.sep}`) || !/^[@A-Za-z0-9._/-]+$/.test(interceptorPackageObject.name) || !/^\d+\.\d+\.\d+$/.test(interceptorPackageObject.version) || !interceptorEntries || interceptorEntries.recoveryFenceExtensions.length !== 1 || declaredFence?.length !== 1 || interceptorEntries.extensions.includes(normalizedInterceptorEntryPath)) throw new Error("interceptor package ownership or role cannot be proven");
  const interceptorSpec: SideEffectFenceInterceptorSpec = { path: interceptor.realpath, entryRole: "fence", version: SIDE_EFFECT_FENCE_EXTENSION_VERSION, digest: interceptor.digest, toolNames: [...declaredToolNames].sort(), preprocessor: true, snapshotRoot: interceptorRoot!, snapshotManifestPath: interceptorEntryManifest.realpath, snapshotManifestDigest: interceptorEntryManifest.digest, snapshotDigest: sideEffectFenceSnapshotDigest(interceptor.digest, interceptorEntryManifest.digest), packagePath: interceptorPackage.realpath, packageName: interceptorPackageObject.name, packageVersion: interceptorPackageObject.version, entryRealpath: interceptor.realpath, entryDigest: interceptor.digest, entryRelativePath: interceptorPackageEntryPath, toolSetDigest, packageManifestDigest: digest(interceptorPackageObject), fenceLast: true };
  const fullEntries = valid.map(({ realpath, version, digest: entryDigest, toolNames, snapshotRoot, snapshotManifestPath, snapshotManifestDigest, snapshotDigest, packageRealpath, packageName, packageVersion, entryRealpath, entryDigest: declaredEntryDigest, entryRelativePath, toolSetDigest: entryToolSetDigest, packageManifestDigest }) => ({ path: realpath, entryRole: "preprocessor" as const, version, digest: entryDigest, toolNames, snapshotRoot, snapshotManifestPath, snapshotManifestDigest, snapshotDigest, packagePath: packageRealpath, packageName, packageVersion, entryRealpath, entryDigest: declaredEntryDigest, entryRelativePath, toolSetDigest: entryToolSetDigest, packageManifestDigest, fenceLast: false }));
  const extensionOrderDigest = digest([...valid.map((spec) => spec.realpath), interceptor.realpath]);
  const manifest = { version: 1, protocol: SIDE_EFFECT_FENCE_PROTOCOL, runnerVersion: SIDE_EFFECT_FENCE_RUNNER_VERSION, policyDigest, toolSetDigest, extensionOrderDigest, extensions: fullEntries, interceptor: interceptorSpec, fenceLastEntry: { path: interceptorSpec.path, digest: interceptorSpec.digest, unique: true } };
  const manifestDigest = digest(manifest);
  const snapshotRoots = new Set(valid.map((spec) => spec.snapshotRoot)); snapshotRoots.add(interceptorRoot!); for (const root of snapshotRoots) { try { sealSnapshotFiles(root); } catch { throw new Error("immutable launch snapshot cannot be sealed"); } }
  return { extensions: valid.map((spec) => spec.realpath), interceptor: interceptor.realpath, digest: interceptor.digest, manifestDigest, allowlistDigest: manifestDigest, extensionOrderDigest, toolSetDigest, policyDigest, interceptorSpec };
}

export interface SideEffectFenceLifecycleMetadata {
  version: 1;
  dispatchCallId: string;
  delegationId: string;
  ownerGeneration: number;
  fencingGeneration: number;
  childPid?: number;
  childIdentityRef?: string;
  state: "active" | "terminal";
  expiresAt: string;
}
export interface SideEffectFenceCleanupOptions {
  /** Proof must be obtained while the owning Call lock is held. */
  proof?: (metadata: SideEffectFenceLifecycleMetadata) => Promise<boolean> | boolean;
  /** Optional active object set; an active identity is always retained. */
  activeSet?: ReadonlySet<string>;
}
function validLifecycleMetadata(value: unknown): value is SideEffectFenceLifecycleMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((key) => ["version", "dispatchCallId", "delegationId", "ownerGeneration", "fencingGeneration", "childPid", "childIdentityRef", "state", "expiresAt"].includes(key)) && item.version === 1 && SAFE_ID.test(String(item.dispatchCallId)) && SAFE_ID.test(String(item.delegationId)) && integer(item.ownerGeneration) && integer(item.fencingGeneration) && (item.childPid === undefined || integer(item.childPid)) && (item.childIdentityRef === undefined || /^[0-9a-f]{64}$/.test(String(item.childIdentityRef))) && (item.state === "active" || item.state === "terminal") && typeof item.expiresAt === "string" && Number.isFinite(Date.parse(item.expiresAt));
}
export async function cleanupSideEffectFenceOrphans(rootDir: string, options: SideEffectFenceCleanupOptions = {}): Promise<{ cleaned: number; pausedIntegrity: number }> {
  const base = path.join(rootDir, "v2", "fences");
  if (!ownerDirectorySync(base)) {
    try { await fs.access(base); return { cleaned: 0, pausedIntegrity: 1 }; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { cleaned: 0, pausedIntegrity: 0 } : { cleaned: 0, pausedIntegrity: 1 }; }
  }
  let entries: nodeFs.Dirent[];
  try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { return { cleaned: 0, pausedIntegrity: 1 }; }
  let cleaned = 0; let pausedIntegrity = 0;
  for (const entry of entries) {
    const candidate = path.join(base, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink() || !ownerDirectorySync(candidate)) { pausedIntegrity += 1; continue; }
    const metadataFile = path.join(candidate, "lifecycle.json");
    const metadata = (() => { try { const stat = nodeFs.lstatSync(metadataFile); if (!ownerFileSync(metadataFile)) return undefined; return JSON.parse(nodeFs.readFileSync(metadataFile, "utf8")) as unknown; } catch { return undefined; } })();
    if (!validLifecycleMetadata(metadata) || !options.proof || options.activeSet?.has(`${metadata.dispatchCallId}:${metadata.delegationId}`)) { pausedIntegrity += 1; continue; }
    const expired = Date.parse(metadata.expiresAt) <= Date.now();
    if (metadata.state !== "terminal" || !expired) { pausedIntegrity += 1; continue; }
    let proven = false; try { proven = await options.proof(metadata); } catch { proven = false; }
    if (!proven) { pausedIntegrity += 1; continue; }
    try { await fs.rm(candidate, { recursive: true, force: true }); cleaned += 1; } catch { pausedIntegrity += 1; }
  }
  return { cleaned, pausedIntegrity };
}

function failureResponse(requestId: string, reason: string, state: "blocked" | "integrity" = "blocked"): Frame {
  return { version: SIDE_EFFECT_FENCE_PROTOCOL, type: "response", requestId, ok: false, handler: 0, block: true, terminate: true, state, reason: reason.slice(0, 128) };
}

export function sideEffectFenceEnvironment(client: SideEffectFenceClientConfig): NodeJS.ProcessEnv {
  // These are opaque protocol coordinates, not task/prompt/args. The nonce is
  // never projected into WAL/details; it exists only in the child environment.
  return {
    [ENV_SOCKET]: client.socket, [ENV_NONCE]: client.nonce, [ENV_PROTOCOL]: String(client.protocol),
    ...(client.handshake ? { PI_SUBAGENT_FENCE_HANDSHAKE: Buffer.from(JSON.stringify(client.handshake), "utf8").toString("base64url") } : {}),
  };
}
function ownerBinding(claim: OwnerClaim): string { return digest({ host: claim.owner.host, pid: claim.owner.pid, birth: claim.owner.birth, parentSessionId: claim.owner.parentSessionId, parentSessionPath: claim.owner.parentSessionPath, argvProof: claim.owner.argvProof }); }
function childBinding(sessionId: string, pid: number): string { return digest({ sessionId, pid }); }

export async function startSideEffectFenceServer(options: SideEffectFenceServerOptions): Promise<SideEffectFenceServer> {
  const proof = buildSideEffectFenceExtensions(options.config);
  if (!sideEffectFenceDeploymentVerified(options.config, proof.allowlistDigest)) throw new Error("deployment proof is missing or not bound to the immutable manifest");
  const snapshotRoots = new Set(options.config.allowlist.map((spec) => spec.snapshotRoot)); snapshotRoots.add(path.dirname(proof.interceptor)); for (const root of snapshotRoots) sealSnapshotTree(root);
  const base = path.join(options.rootDir, "v2", "fences");
  await fs.mkdir(base, { recursive: true, mode: OWNER_ONLY_DIR });
  if (!ownerDirectorySync(base)) throw new Error("fence parent is not owner-only");
  const directory = await fs.mkdtemp(path.join(base, "channel-"));
  try {
    if (!ownerDirectorySync(directory)) throw new Error("fence directory is not owner-only");
    const socket = path.join(directory, "ipc.sock");
    const lifecycleFile = path.join(directory, "lifecycle.json");
    const lifecycle: SideEffectFenceLifecycleMetadata = { version: 1, dispatchCallId: options.dispatchCallId, delegationId: options.delegationId, ownerGeneration: options.claim.ownerGeneration, fencingGeneration: options.claim.fencingGeneration, state: "active", expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() };
    await atomicOwnerJson(lifecycleFile, lifecycle);
    const nonce = randomUUID().replaceAll("-", "");
    const policyByName = new Map(options.config.policy.tools.map((policy) => [policy.toolName, policy]));
    const extensionOrderDigest = proof.extensionOrderDigest;
    const fenceLastProof = digest({ manifestDigest: proof.manifestDigest, order: extensionOrderDigest, interceptor: proof.interceptorSpec, fenceLastEntry: proof.interceptorSpec.path, last: true });
    const server = net.createServer();
    let socketRef: net.Socket | undefined;
    let childPid: number | undefined;
    let childSessionId: string | undefined;
    let bindingReadyResolve: (() => void) | undefined;
    let bindingReadyReject: ((error: Error) => void) | undefined;
    let bindingState: "pending" | "succeeded" | "failed" = "pending";
    let bindingReady = new Promise<void>((resolve, reject) => { bindingReadyResolve = resolve; bindingReadyReject = reject; });
    let handshakeResolve: ((value: boolean) => void) | undefined;
    const handshakePromise = new Promise<boolean>((resolve) => { handshakeResolve = resolve; });
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
    let handshakeState: "pending" | "succeeded" | "failed" = "pending";
    let failureResolve: ((reason: string) => void) | undefined;
    const failure = new Promise<string>((resolve) => { failureResolve = resolve; });
    let failureSignalled = false;
    const signalFailure = (reason: string) => { if (!failureSignalled) { failureSignalled = true; failureResolve?.(reason); } };
    let handshakeDone = false;
    let gracefulAccepted = false;
    let gracefulResolve: ((value: boolean) => void) | undefined;
    const gracefulPromise = new Promise<boolean>((resolve) => { gracefulResolve = resolve; });
    let closed = false;
    let expectedSequence = 1;
    const completedActionIds = new Set<string>();
    const blockedActionIds = new Set<string>();
    const allowedActionIds = new Set<string>();
    const handled = new Map<string, HandledAction>();
    const prepared = new Map<string, { fingerprint: string; actionId: string; logicalActionId: string; stableIdempotencyKey: string; preInjectionArgsDigest: string; policy: PolicyDescriptor; input: unknown }>();
    const pendingResults = new Map<string, HandledAction>();
    const rejectHandshake = (reason: string) => {
      if (handshakeState === "failed") return;
      handshakeState = "failed";
      handshakeDone = true;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeResolve?.(false);
      handshakeResolve = undefined;
      gracefulResolve?.(false);
      gracefulResolve = undefined;
      socketRef?.destroy(new Error(reason));
    };
    const pauseIntegrity = async (reason: string) => {
      signalFailure(reason);
      try {
        await withCallLock(options.rootDir, options.dispatchCallId, async () => {
          const view = await loadView(options.rootDir, options.dispatchCallId);
          const current = view.delegations.get(options.delegationId);
          if (!view.integrity && current && current.state !== "paused_integrity") {
            await appendWal(options.rootDir, options.dispatchCallId, "delegation_integrity_paused", { reasonCode: reason }, options.delegationId, options.deps);
            await materialize(options.rootDir, await loadView(options.rootDir, options.dispatchCallId));
          }
        });
      } catch { /* the absence of a pause proof remains fail-closed */ }
    };
    const send = (frame: Frame) => {
      if (!socketRef || socketRef.destroyed || handshakeState === "failed") return;
      try { socketRef.write(frameBytes(frame)); } catch { void pauseIntegrity("fence_channel_write_failed"); rejectHandshake("channel write failed"); }
    };
    const failChannel = async (reason: string) => { await pauseIntegrity(reason); rejectHandshake(reason); socketRef?.destroy(); };
    const handleFrame = async (frame: Frame) => {
      if (!exactKeys(frame, ["version", "type", "seq"], ["nonce", "dispatchCallId", "delegationId", "executionScope", "reservationId", "owner", "ownerGeneration", "fencingGeneration", "childSessionId", "childIdentityRef", "pid", "allowlistManifestDigest", "extensionOrderDigest", "toolSetDigest", "policyDigest", "interceptorRealpath", "interceptorDigest", "interceptorVersion", "fenceLastProof", "requestId", "toolCallId", "toolName", "input", "toolCallOrdinal", "logicalCheckpoint", "preInjectionArgsDigest", "stableIdempotencyKey", "resultDigest", "resultType", "status", "completedActionIds", "blockedActionIds", "inflight"]) || frame.version !== SIDE_EFFECT_FENCE_PROTOCOL || !integer(frame.seq)) { await failChannel("fence_frame_shape_invalid"); return; }
      if (frame.type === "hello") {
        // Pi may load the interceptor and send hello before the parent has
        // completed the durable child binding. Queue validation, rather than
        // treating a legal early hello as a permanent identity failure.
        if (childPid === undefined || childSessionId === undefined) {
          try { await bindingReady; } catch { await failChannel("fence_child_binding_failed"); return; }
        }
        const expectedManifest = proof.manifestDigest;
        const expectedOrder = proof.extensionOrderDigest;
        const expectedFenceProof = digest({ manifestDigest: proof.manifestDigest, order: expectedOrder, interceptor: proof.interceptorSpec, fenceLastEntry: proof.interceptorSpec.path, last: true });
        const valid = exactKeys(frame, ["version", "type", "seq", "nonce", "dispatchCallId", "delegationId", "executionScope", "reservationId", "owner", "ownerGeneration", "fencingGeneration", "childSessionId", "childIdentityRef", "pid", "allowlistManifestDigest", "extensionOrderDigest", "toolSetDigest", "policyDigest", "interceptorRealpath", "interceptorDigest", "interceptorVersion", "fenceLastProof"]) && frame.seq === 0 && frame.nonce === nonce && frame.dispatchCallId === options.dispatchCallId && frame.delegationId === options.delegationId && frame.executionScope === options.executionScope && frame.reservationId === options.reservationId && frame.owner === ownerBinding(options.claim) && frame.ownerGeneration === options.claim.ownerGeneration && frame.fencingGeneration === options.claim.fencingGeneration && string(frame.childSessionId) && integer(frame.pid) && frame.pid === childPid && frame.childSessionId === childSessionId && frame.childIdentityRef === childBinding(String(frame.childSessionId), Number(frame.pid)) && frame.allowlistManifestDigest === expectedManifest && frame.extensionOrderDigest === expectedOrder && frame.toolSetDigest === proof.toolSetDigest && frame.policyDigest === proof.policyDigest && frame.interceptorRealpath === proof.interceptorSpec.path && frame.interceptorDigest === proof.interceptorSpec.digest && frame.interceptorVersion === proof.interceptorSpec.version && frame.fenceLastProof === expectedFenceProof;
        if (!valid) { await failChannel("fence_handshake_invalid"); return; }
        handshakeState = "succeeded"; handshakeDone = true;
        if (handshakeTimer) clearTimeout(handshakeTimer);
        send({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "hello_ack", requestId: "hello", ok: true, handler: 1, dispatchCallId: options.dispatchCallId, delegationId: options.delegationId, executionScope: options.executionScope, reservationId: options.reservationId, owner: ownerBinding(options.claim), ownerGeneration: options.claim.ownerGeneration, fencingGeneration: options.claim.fencingGeneration, childSessionId, childIdentityRef: childBinding(String(childSessionId), Number(frame.pid)), pid: Number(frame.pid), allowlistManifestDigest: expectedManifest, extensionOrderDigest: expectedOrder, toolSetDigest: proof.toolSetDigest, policyDigest: proof.policyDigest, interceptorRealpath: proof.interceptorSpec.path, interceptorDigest: proof.interceptorSpec.digest, interceptorVersion: proof.interceptorSpec.version, fenceLastProof: expectedFenceProof, policyVersion: options.config.policy.version, policies: options.config.policy.tools.map((item) => ({ ...item })) });
        handshakeResolve?.(true); handshakeResolve = undefined;
        return;
      }
      if (handshakeState !== "succeeded" || !handshakeDone || frame.seq !== expectedSequence++) { await failChannel("fence_frame_order_invalid"); return; }
      const requestId = frame.requestId;
      if (frame.type === "goodbye") {
        const inflight = frame.inflight;
        const completed = frame.completedActionIds;
        const blocked = frame.blockedActionIds;
        const sameIds = (value: unknown, expected: Set<string>): boolean => Array.isArray(value) && new Set(value.filter((item): item is string => typeof item === "string")).size === value.length && value.every((item) => expected.has(item)) && expected.size === value.length;
        const validInflight = !!inflight && typeof inflight === "object" && !Array.isArray(inflight) && Object.keys(inflight).length === 3 && (inflight as Record<string, unknown>).prepare === 0 && (inflight as Record<string, unknown>).intent === 0 && (inflight as Record<string, unknown>).result === 0;
        const valid = exactKeys(frame, ["version", "type", "seq", "requestId", "nonce", "dispatchCallId", "delegationId", "executionScope", "reservationId", "owner", "ownerGeneration", "fencingGeneration", "childSessionId", "childIdentityRef", "pid", "completedActionIds", "blockedActionIds", "inflight"], []) && frame.requestId === "goodbye" && frame.nonce === nonce && frame.dispatchCallId === options.dispatchCallId && frame.delegationId === options.delegationId && frame.executionScope === options.executionScope && frame.reservationId === options.reservationId && frame.owner === ownerBinding(options.claim) && frame.ownerGeneration === options.claim.ownerGeneration && frame.fencingGeneration === options.claim.fencingGeneration && frame.childSessionId === childSessionId && integer(frame.pid) && frame.pid === childPid && frame.childIdentityRef === childBinding(String(childSessionId), Number(frame.pid)) && validInflight && prepared.size === 0 && allowedActionIds.size === 0 && sameIds(completed, completedActionIds) && sameIds(blocked, blockedActionIds);
        if (!valid) { await failChannel("fence_goodbye_invalid"); return; }
        gracefulAccepted = true;
        gracefulResolve?.(true); gracefulResolve = undefined;
        send({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "goodbye_ack", requestId: "goodbye", ok: true, handler: 1, seq: frame.seq, nonce, dispatchCallId: options.dispatchCallId, delegationId: options.delegationId, executionScope: options.executionScope, reservationId: options.reservationId, owner: ownerBinding(options.claim), ownerGeneration: options.claim.ownerGeneration, fencingGeneration: options.claim.fencingGeneration, childSessionId, childIdentityRef: childBinding(String(childSessionId), Number(frame.pid)), pid: Number(frame.pid), completedActionIds: [...completedActionIds], blockedActionIds: [...blockedActionIds] });
        return;
      }
      if (!string(requestId)) { await failChannel("fence_request_id_invalid"); return; }
      if (frame.type === "prepare") {
        if (!exactKeys(frame, ["version", "type", "seq", "requestId", "toolCallId", "toolName", "input", "toolCallOrdinal", "logicalCheckpoint"], []) || !string(frame.toolCallId) || !string(frame.toolName) || !jsonValue(frame.input) || !integer(frame.toolCallOrdinal) || !string(frame.logicalCheckpoint)) { await failChannel("fence_prepare_invalid"); return; }
        let preInjectionArgsDigest: string; try { preInjectionArgsDigest = canonicalArgsDigest(frame.input); } catch { await failChannel("fence_prepare_args_invalid"); return; }
        const policy = policyByName.get(frame.toolName) ?? { toolName: frame.toolName, classification: "unsupported" as const };
        const identity = { delegationId: options.delegationId, toolCallOrdinal: frame.toolCallOrdinal, logicalCheckpoint: frame.logicalCheckpoint, finalToolName: frame.toolName, canonicalArgsDigest: preInjectionArgsDigest, executionScope: options.executionScope, reservationId: options.reservationId, continuationEpoch: options.continuationEpoch, fencingGeneration: options.claim.fencingGeneration };
        const actionId = actionIdFor(identity); const stableIdempotencyKey = stableIdempotencyKeyFor(actionId); const fingerprint = digest({ toolCallId: frame.toolCallId, toolName: frame.toolName, input: frame.input, ordinal: frame.toolCallOrdinal, checkpoint: frame.logicalCheckpoint });
        const prior = prepared.get(frame.toolCallId);
        if (prior) { await failChannel(prior.fingerprint === fingerprint ? "fence_prepare_replay" : "fence_prepare_conflict"); return; }
        prepared.set(frame.toolCallId, { fingerprint, actionId, logicalActionId: actionId, stableIdempotencyKey, preInjectionArgsDigest, policy, input: frame.input });
        try { await appendWal(options.rootDir, options.dispatchCallId, "action_intent_prepared", { actionId, logicalActionId: actionId, delegationId: options.delegationId, logicalCheckpoint: frame.logicalCheckpoint, toolCallOrdinal: frame.toolCallOrdinal, finalToolNameHash: hash(frame.toolName), canonicalArgsDigest: preInjectionArgsDigest, stableIdempotencyKey, policy: policy.classification, idempotencyParameter: policy.idempotencyParameter ?? "" }, options.delegationId, options.deps); } catch { await failChannel("fence_prepare_durability_failed"); return; }
        send({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "response", requestId, ok: policy.classification !== "unsupported", handler: policy.classification === "unsupported" ? 0 : 1, actionId, logicalActionId: actionId, stableIdempotencyKey, preInjectionArgsDigest, policy: policy.classification, ...(policy.idempotencyParameter && policy.externalSystemSupportsKey === true ? { idempotencyParameter: policy.idempotencyParameter } : {}) });
        if (policy.classification === "unsupported") { prepared.delete(frame.toolCallId); blockedActionIds.add(actionId); signalFailure("unsupported side-effect tool"); }
        return;
      }
      if (frame.type === "intent") {
        if (!exactKeys(frame, ["version", "type", "seq", "requestId", "toolCallId", "toolName", "input", "toolCallOrdinal", "logicalCheckpoint", "preInjectionArgsDigest", "stableIdempotencyKey"], []) || !string(frame.toolCallId) || !string(frame.toolName) || !jsonValue(frame.input) || !integer(frame.toolCallOrdinal) || !string(frame.logicalCheckpoint) || !/^[0-9a-f]{64}$/.test(String(frame.preInjectionArgsDigest)) || !/^idempotency:[0-9a-f]{64}$/.test(String(frame.stableIdempotencyKey))) { await failChannel("fence_intent_invalid"); return; }
        const prep = prepared.get(frame.toolCallId);
        const expectedFinal = prep?.policy.idempotencyParameter && prep.policy.externalSystemSupportsKey === true && prep.input && typeof prep.input === "object" && !Array.isArray(prep.input) ? { ...(prep.input as Record<string, unknown>), [prep.policy.idempotencyParameter]: frame.stableIdempotencyKey } : prep?.input;
        if (!prep || stableIdempotencyKeyFor(prep.actionId) !== frame.stableIdempotencyKey || prep.preInjectionArgsDigest !== frame.preInjectionArgsDigest || prep.stableIdempotencyKey !== frame.stableIdempotencyKey || prep.policy.toolName !== frame.toolName || digest(frame.input) !== digest(expectedFinal)) { await failChannel("fence_intent_prepare_mismatch"); return; }
        const fingerprint = digest({ toolCallId: frame.toolCallId, toolName: frame.toolName, input: frame.input, ordinal: frame.toolCallOrdinal, checkpoint: frame.logicalCheckpoint, preInjectionArgsDigest: frame.preInjectionArgsDigest, stableIdempotencyKey: frame.stableIdempotencyKey });
        const prior = handled.get(frame.toolCallId);
        if (prior) { await failChannel(prior.fingerprint === fingerprint ? "fence_intent_replay" : "fence_duplicate_intent_conflict"); return; }
        const policy = prep.policy;
        const result = await beginActionIntentInternal(options.rootDir, options.dispatchCallId, options.delegationId, options.claim, { executionScope: options.executionScope, reservationId: options.reservationId, continuationEpoch: options.continuationEpoch, fencingGeneration: options.claim.fencingGeneration, toolCallOrdinal: frame.toolCallOrdinal, logicalCheckpoint: frame.logicalCheckpoint, finalToolName: frame.toolName, finalArgs: frame.input, canonicalArgsDigest: String(frame.preInjectionArgsDigest), preInjectionArgsDigest: String(frame.preInjectionArgsDigest), stableIdempotencyKey: String(frame.stableIdempotencyKey), idempotencyParameter: policy.idempotencyParameter, policy: policy.classification }, options.deps);
        const response: Frame = result.handler === 1 ? { version: SIDE_EFFECT_FENCE_PROTOCOL, type: "response", requestId, ok: true, handler: 1, actionId: result.actionId, logicalActionId: result.logicalActionId, policy: policy.classification } : failureResponse(requestId, result.reason ?? "intent blocked", result.state === "paused_integrity" ? "integrity" : "blocked");
        prepared.delete(frame.toolCallId);
        if (result.handler === 1 && result.actionId) allowedActionIds.add(result.actionId);
        else if (result.actionId) blockedActionIds.add(result.actionId);
        if (result.handler !== 1) signalFailure(String(result.reason ?? "intent blocked"));
        handled.set(frame.toolCallId, { fingerprint, actionId: result.actionId, response });
        send(response);
        return;
      }
      if (frame.type === "result") {
        if (!exactKeys(frame, ["version", "type", "seq", "requestId", "toolCallId", "resultDigest", "resultType", "status"], []) || !string(frame.toolCallId) || !/^[0-9a-f]{64}$/.test(String(frame.resultDigest)) || !SAFE_REF.test(String(frame.resultType)) || (frame.status !== "success" && frame.status !== "failure")) { await failChannel("fence_result_invalid"); return; }
        const priorIntent = handled.get(frame.toolCallId);
        if (!priorIntent?.actionId) { await failChannel("fence_result_without_intent"); return; }
        const resultFingerprint = digest({ toolCallId: frame.toolCallId, resultDigest: frame.resultDigest, resultType: frame.resultType, status: frame.status });
        const priorResult = pendingResults.get(frame.toolCallId);
        if (priorResult) { await failChannel(priorResult.fingerprint === resultFingerprint ? "fence_result_replay" : "fence_duplicate_result_conflict"); return; }
        const result = await finishActionResultInternal(options.rootDir, options.dispatchCallId, options.delegationId, options.claim, { actionId: priorIntent.actionId, logicalActionId: priorIntent.actionId, resultRef: `result:${digest([priorIntent.actionId, frame.toolCallId, frame.resultDigest, frame.resultType, frame.status])}`, resultType: String(frame.resultType), status: frame.status }, options.deps);
        const response: Frame = result.state === "result_acked" ? { version: SIDE_EFFECT_FENCE_PROTOCOL, type: "response", requestId, ok: true, handler: 1, actionId: priorIntent.actionId } : failureResponse(requestId, result.reason ?? "result ACK failed", result.state === "paused_integrity" ? "integrity" : "blocked");
        if (result.state === "result_acked") { allowedActionIds.delete(priorIntent.actionId); completedActionIds.add(priorIntent.actionId); }
        pendingResults.set(frame.toolCallId, { fingerprint: resultFingerprint, response });
        if (result.state !== "result_acked") signalFailure(String(result.reason ?? "result ACK failed"));
        send(response);
        return;
      }
      await failChannel("fence_unknown_frame");
    };
    server.on("connection", (socket) => {
      if (socketRef && !socketRef.destroyed) { socket.destroy(); return; }
      socketRef = socket;
      let buffer = "";
      let frameQueue = Promise.resolve();
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > SIDE_EFFECT_FENCE_MAX_FRAME) { void failChannel("fence_frame_oversize"); socket.destroy(); return; }
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          if (Buffer.byteLength(line, "utf8") > SIDE_EFFECT_FENCE_MAX_JSON) { void failChannel("fence_frame_oversize"); socket.destroy(); return; }
          let parsed: unknown; try { parsed = JSON.parse(line); } catch { void failChannel("fence_frame_invalid_json"); socket.destroy(); return; }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { void failChannel("fence_frame_invalid_json"); socket.destroy(); return; }
          frameQueue = frameQueue.then(() => handleFrame(parsed as Frame)).catch(() => failChannel("fence_frame_handler_failed"));
        }
      });
      socket.on("error", () => { if (!handshakeDone) void pauseIntegrity("fence_handshake_disconnect"); });
      socket.on("close", () => {
        if (!handshakeDone) { handshakeDone = true; handshakeResolve?.(false); handshakeResolve = undefined; gracefulResolve?.(false); gracefulResolve = undefined; void pauseIntegrity("fence_handshake_disconnect"); }
        else if (!gracefulAccepted) { gracefulResolve?.(false); gracefulResolve = undefined; signalFailure("fence_channel_disconnect"); }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { server.removeAllListeners("error"); resolve(); }); });
    await fs.chmod(socket, 0o600);
    if (!validSocket(socket)) throw new Error("fence socket identity cannot be proven");
    const close = async (reason = "child_exit") => {
      if (closed) return; closed = true; lifecycle.state = "terminal"; lifecycle.expiresAt = new Date(Date.now() - 1).toISOString(); try { await atomicOwnerJson(lifecycleFile, lifecycle); } catch { /* orphan proof remains fail closed */ } if (!gracefulAccepted && handshakeDone) signalFailure(reason === "child_exit" ? "fence_channel_closed_before_goodbye" : reason); socketRef?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try { if (validSocket(socket)) await fs.unlink(socket); } catch { /* cleanup remains fail closed */ }
      try { await fs.rm(directory, { recursive: true, force: true }); } catch { /* orphan scanner handles residue */ }
      for (const root of snapshotRoots) { try { unsealSnapshotTree(root); } catch { /* cleanup remains fail closed */ } }
      void reason;
    };
    const runtime: SideEffectFenceServer = {
      client: { socket, nonce, protocol: SIDE_EFFECT_FENCE_PROTOCOL, extensions: [...proof.extensions], interceptor: proof.interceptor, deploymentProof: issueClientDeploymentProof(options.config.deploymentVerification!, proof.allowlistDigest, nonce), timeoutMs: options.config.handshakeTimeoutMs, handshake: { dispatchCallId: options.dispatchCallId, delegationId: options.delegationId, executionScope: options.executionScope, reservationId: options.reservationId, owner: ownerBinding(options.claim), ownerGeneration: options.claim.ownerGeneration, fencingGeneration: options.claim.fencingGeneration, childIdentityRef: "self", allowlistManifestDigest: proof.allowlistDigest, extensionOrderDigest, toolSetDigest: proof.toolSetDigest, policyDigest: proof.policyDigest, interceptorRealpath: proof.interceptorSpec.path, interceptorDigest: proof.interceptorSpec.digest, interceptorVersion: proof.interceptorSpec.version, fenceLastProof }, bindChild: async (pid, session) => runtime.bindChild(pid, session), awaitHandshake: async (timeoutMs) => runtime.awaitHandshake(timeoutMs), awaitGraceful: async (timeoutMs) => runtime.awaitGraceful(timeoutMs), close: async (reason) => runtime.close(reason), failure },
      directory, socket,
      async bindChild(pid, session) {
        if (!integer(pid) || pid <= 0 || !SAFE_ID.test(session)) { const error = new Error("child identity is invalid"); bindingState = "failed"; bindingReadyReject?.(error); throw error; }
        if (bindingState === "succeeded") {
          if (childPid === pid && childSessionId === session) return true;
          throw new Error("child binding identity changed");
        }
        if (bindingState === "failed") throw new Error("child binding is failed");
        childPid = pid; childSessionId = session; lifecycle.childPid = pid; lifecycle.childIdentityRef = childBinding(session, pid);
        try { await atomicOwnerJson(lifecycleFile, lifecycle); bindingState = "succeeded"; bindingReadyResolve?.(); return true; }
        catch (error) { bindingState = "failed"; bindingReadyReject?.(error as Error); throw error; }
      },
      async awaitHandshake(timeoutMs = options.config.handshakeTimeoutMs ?? SIDE_EFFECT_FENCE_TIMEOUT_MS) {
        if (handshakeState === "succeeded") return true;
        if (handshakeState === "failed") return false;
        if (!handshakeTimer) { handshakeTimer = setTimeout(() => { if (handshakeState === "pending") void failChannel("fence_handshake_timeout"); }, timeoutMs); handshakeTimer.unref(); }
        return handshakePromise;
      },
      async awaitGraceful(timeoutMs = options.config.handshakeTimeoutMs ?? SIDE_EFFECT_FENCE_TIMEOUT_MS) {
        if (gracefulAccepted) return true;
        if (handshakeState === "failed" || failureSignalled) return false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => { void failChannel("fence_graceful_shutdown_timeout"); resolve(false); }, timeoutMs); timer.unref(); });
        const result = await Promise.race([gracefulPromise, timeout]);
        if (timer) clearTimeout(timer);
        return result;
      },
      close,
    };
    return runtime;
  } catch (error) {
    try { await fs.rm(directory, { recursive: true, force: true }); } catch { /* orphan scanner */ }
    for (const root of snapshotRoots) { try { unsealSnapshotTree(root); } catch { /* cleanup remains fail closed */ } }
    throw error;
  }
}
