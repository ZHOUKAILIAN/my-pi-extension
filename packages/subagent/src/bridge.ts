import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { withIdentityLock } from "./session-lock.ts";
import { ownerOwned as secureOwnerOwned, sameIdentity as secureSameIdentity, syncDirectory as secureSyncDirectory } from "./secure-fs.ts";

export const DEFAULT_ROLLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SOURCE_HASH = /^[a-f0-9]{64}$/;
const MARKER_VERSION = 1;
const MARKER_DIRECTORY = "preservation-pins";
const QUARANTINE_SUFFIX = /^\.json\.quarantine-[A-Za-z0-9-]+$/;
const O_NOFOLLOW = nodeFs.constants.O_NOFOLLOW;
const O_DIRECTORY = nodeFs.constants.O_DIRECTORY;
const BRIDGE_PRODUCTION_PROOF_BRAND = Symbol("bridge-v1-production-proof");
const BRIDGE_TEST_PROOF_BRAND = Symbol("bridge-v1-test-proof");
const productionProofs = new WeakSet<object>();
const testProofs = new WeakSet<object>();

type BridgeStoreErrorKind = "invalid" | "unavailable";
class BridgeStoreError extends Error {
  readonly kind: BridgeStoreErrorKind;
  constructor(kind: BridgeStoreErrorKind, message: string) { super(message); this.kind = kind; }
}

export interface BridgeCapability {
  capability: "bridge-v1";
  version: 1;
  markerVersion: 1;
  defaultRollbackWindowMs: number;
  explicitHandleOnly: true;
  verified: boolean;
  verificationEvidence: "not-run";
  adoptionAllowed: false;
}

/** Opaque output of a real installed bridge binary verification. There is no
 * public constructor: the current slice intentionally cannot produce one. */
export interface BridgeProductionProof {
  readonly [BRIDGE_PRODUCTION_PROOF_BRAND]: true;
  readonly capability: "bridge-v1";
  readonly bridgeVersion: string;
  readonly bridgeDigest: string;
  readonly markerVersion: 1;
  readonly gcPinSemantics: "verified";
  readonly rollbackSemantics: "verified";
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

export interface BridgeTestProof {
  readonly [BRIDGE_TEST_PROOF_BRAND]: true;
  readonly testOnly: true;
  readonly capability: "bridge-v1";
  readonly bridgeVersion: "test-fixture";
  readonly bridgeDigest: string;
  readonly markerVersion: 1;
  readonly gcPinSemantics: "verified";
  readonly rollbackSemantics: "verified";
  readonly verifiedAt: string;
  readonly expiresAt: string;
}

/** Internal test seam only. This proof is deliberately rejected by the
 * production adoption predicate and cannot be used to sign deployment proof. */
function strictProofShape(value: object, production: boolean): boolean {
  if (!Object.isFrozen(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== (production ? 8 : 9)) return false;
  const candidate = value as Record<PropertyKey, unknown>;
  const brand = production ? BRIDGE_PRODUCTION_PROOF_BRAND : BRIDGE_TEST_PROOF_BRAND;
  if (candidate[brand] !== true) return false;
  if (!production && candidate.testOnly !== true) return false;
  return candidate.capability === "bridge-v1" &&
    candidate.bridgeVersion === (production ? candidate.bridgeVersion : "test-fixture") &&
    typeof candidate.bridgeVersion === "string" && candidate.bridgeVersion.length > 0 &&
    typeof candidate.bridgeDigest === "string" && /^[a-f0-9]{64}$/.test(candidate.bridgeDigest) &&
    candidate.markerVersion === 1 && candidate.gcPinSemantics === "verified" &&
    candidate.rollbackSemantics === "verified" && typeof candidate.verifiedAt === "string" &&
    typeof candidate.expiresAt === "string" && Number.isFinite(Date.parse(candidate.verifiedAt)) &&
    Number.isFinite(Date.parse(candidate.expiresAt)) && Date.parse(candidate.expiresAt) > Date.parse(candidate.verifiedAt);
}

export function createBridgeTestProofInternal(now = new Date()): BridgeTestProof {
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const proof = Object.freeze({ [BRIDGE_TEST_PROOF_BRAND]: true as const, testOnly: true as const, capability: "bridge-v1" as const, bridgeVersion: "test-fixture" as const, bridgeDigest: "0".repeat(64), markerVersion: 1 as const, gcPinSemantics: "verified" as const, rollbackSemantics: "verified" as const, verifiedAt: now.toISOString(), expiresAt });
  testProofs.add(proof);
  return proof;
}

export function isBridgeTestProof(value: unknown): value is BridgeTestProof {
  return typeof value === "object" && value !== null && testProofs.has(value) && strictProofShape(value, false);
}

export function isBridgeProductionProof(value: unknown): value is BridgeProductionProof {
  // The identity check is deliberately first. Unregistered objects, including
  // Proxy objects with symbol/getter traps, never reach the structural check.
  return typeof value === "object" && value !== null && productionProofs.has(value) && strictProofShape(value, true);
}

/** Installed bridge contract only; deployment verification is intentionally not claimed here. */
export function probeBridgeV1Capability(): BridgeCapability {
  return Object.freeze({
    capability: "bridge-v1",
    version: 1,
    markerVersion: 1,
    defaultRollbackWindowMs: DEFAULT_ROLLBACK_WINDOW_MS,
    explicitHandleOnly: true,
    verified: false,
    verificationEvidence: "not-run",
    adoptionAllowed: false,
  });
}

export function isBridgeV1Capability(value: unknown): value is BridgeCapability {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 8 &&
    candidate.capability === "bridge-v1" && candidate.version === 1 && candidate.markerVersion === 1 &&
    candidate.defaultRollbackWindowMs === DEFAULT_ROLLBACK_WINDOW_MS && candidate.explicitHandleOnly === true &&
    candidate.verified === false && candidate.verificationEvidence === "not-run" && candidate.adoptionAllowed === false;
}

/** This slice never supplies the deployment evidence required for adoption. */
export function canAdoptExistingV1(value: unknown): boolean {
  return isBridgeProductionProof(value);
}

export interface PreservationPin {
  version: 1;
  sourceHash: string;
  pinUntil: string;
  createdAt: string;
  lastRefreshedAt: string;
  integrity: string;
}

export type PreservationPinState = "absent" | "valid" | "expired" | "invalid" | "unavailable" | "busy";
export interface PreservationPinInspection {
  state: PreservationPinState;
  pin?: PreservationPin;
}

export interface PreservationPinReadOptions {
  rootDir: string;
  sourceHash: string;
}
export interface PreservationPinCreateOptions extends PreservationPinReadOptions {
  pinUntil?: Date;
}
export interface PreservationPinRefreshOptions extends PreservationPinReadOptions {
  pinUntil: Date;
}
export type PreservationPinReleaseOptions = PreservationPinReadOptions;

/** Internal dependency seam; production callers use the system clock. */
export interface BridgeDependencies {
  now?: () => Date;
  /** Test-only race seam; production callers omit it. */
  beforePublish?: (paths: { directory: string; temporary: string; target: string }) => Promise<void>;
}

interface ResolvedPinOptions {
  rootDir: string;
  sourceHash: string;
  now: Date;
  pinUntil?: Date;
  dependencies?: BridgeDependencies;
}

export type PreservationPinMutationStatus = "created" | "already_exists" | "refreshed" | "conflict" | "expired" | "released" | "absent" | "busy" | "rejected";
export interface PreservationPinMutation {
  status: PreservationPinMutationStatus;
  pin?: PreservationPin;
}

function validDate(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function effectiveNow(dependencies?: BridgeDependencies): Date | undefined {
  const value = dependencies?.now ? dependencies.now() : new Date();
  return value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value.getTime()) : undefined;
}

function ownerCanProve(stat: { uid?: number }): boolean {
  return secureOwnerOwned(stat as nodeFs.Stats);
}

function assertSourceHash(sourceHash: string): void {
  if (!SOURCE_HASH.test(sourceHash)) throw new BridgeStoreError("invalid", "source hash must be a SHA-256 hex digest");
}

function sameIdentity(left: { dev?: number; ino?: number }, right: { dev?: number; ino?: number }): boolean { return secureSameIdentity(left as nodeFs.Stats, right as nodeFs.Stats); }

function secureFlags(required: number): number {
  if (typeof O_NOFOLLOW !== "number") throw new BridgeStoreError("invalid", "O_NOFOLLOW is unavailable");
  return nodeFs.constants.O_RDONLY | O_NOFOLLOW | required;
}

function secureFileStat(stat: nodeFs.Stats): boolean {
  return stat.isFile() && ownerCanProve(stat) && stat.nlink === 1 && (stat.mode & 0o077) === 0 &&
    typeof stat.dev === "number" && typeof stat.ino === "number";
}

function secureDirectoryStat(stat: nodeFs.Stats): boolean {
  return stat.isDirectory() && ownerCanProve(stat) && (stat.mode & 0o077) === 0 &&
    typeof stat.dev === "number" && typeof stat.ino === "number";
}

async function secureRoot(rootDir: string): Promise<{ resolved: string; real: string; stat: nodeFs.Stats }> {
  const resolved = path.resolve(rootDir);
  let stat: nodeFs.Stats;
  try { stat = await nodeFs.promises.lstat(resolved); } catch { throw new BridgeStoreError("unavailable", "bridge root is unavailable"); }
  if (stat.isSymbolicLink() || !secureDirectoryStat(stat) || (stat.mode & 0o022) !== 0) {
    throw new BridgeStoreError("invalid", "bridge root security cannot be proven");
  }
  let real: string;
  try { real = await fs.realpath(resolved); } catch { throw new BridgeStoreError("unavailable", "bridge root realpath is unavailable"); }
  return { resolved, real, stat };
}

async function syncDirectory(directory: string): Promise<void> { await secureSyncDirectory(directory); }

async function secureMarkerDirectory(rootDir: string, create: boolean): Promise<string | undefined> {
  const root = await secureRoot(rootDir);
  const directory = path.join(root.resolved, MARKER_DIRECTORY);
  let stat: nodeFs.Stats;
  let callerObservedCreateRace = false;
  try {
    stat = await nodeFs.promises.lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return undefined;
      throw new BridgeStoreError("unavailable", "preservation marker directory is unavailable");
    }
    try {
      await fs.mkdir(directory, { recursive: false, mode: 0o700 });
      callerObservedCreateRace = true;
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw new BridgeStoreError("unavailable", "preservation marker directory cannot be created");
      // EEXIST is also a successful observation of the publication race. This
      // caller must establish the root durability boundary itself; it cannot
      // rely on the process which won mkdir doing so.
      callerObservedCreateRace = true;
    }
    stat = await nodeFs.promises.lstat(directory);
  }
  if (!secureDirectoryStat(stat)) throw new BridgeStoreError("invalid", "preservation marker directory security cannot be proven");
  let real: string;
  try { real = await fs.realpath(directory); } catch { throw new BridgeStoreError("unavailable", "preservation marker directory realpath is unavailable"); }
  const relative = path.relative(root.real, real);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new BridgeStoreError("invalid", "preservation marker directory escapes the bridge root");
  if (callerObservedCreateRace) await syncDirectory(root.resolved);
  return directory;
}

interface MarkerDirectoryContext {
  directory: string;
  handle: fs.FileHandle;
  stat: nodeFs.Stats;
}

async function openMarkerDirectory(rootDir: string, create: boolean): Promise<MarkerDirectoryContext | undefined> {
  const directory = await secureMarkerDirectory(rootDir, create);
  if (!directory) return undefined;
  const handle = await fs.open(directory, secureFlags(typeof O_DIRECTORY === "number" ? O_DIRECTORY : 0));
  try {
    const opened = await handle.stat();
    const pathStat = await nodeFs.promises.lstat(directory);
    if (!secureDirectoryStat(opened) || !secureDirectoryStat(pathStat) || !sameIdentity(opened, pathStat)) throw new BridgeStoreError("invalid", "marker directory identity changed");
    return { directory, handle, stat: opened };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function markerPath(directory: string, sourceHash: string): string {
  assertSourceHash(sourceHash);
  return path.join(directory, `${sourceHash}.json`);
}

async function directoryStillSame(context: MarkerDirectoryContext): Promise<boolean> {
  const opened = await context.handle.stat();
  const pathStat = await nodeFs.promises.lstat(context.directory);
  return secureDirectoryStat(opened) && secureDirectoryStat(pathStat) && sameIdentity(context.stat, opened) && sameIdentity(opened, pathStat);
}

function payloadFor(pin: Pick<PreservationPin, "version" | "sourceHash" | "pinUntil" | "createdAt" | "lastRefreshedAt">): string {
  return JSON.stringify({ version: pin.version, sourceHash: pin.sourceHash, pinUntil: pin.pinUntil, createdAt: pin.createdAt, lastRefreshedAt: pin.lastRefreshedAt });
}

function integrityFor(pin: Pick<PreservationPin, "version" | "sourceHash" | "pinUntil" | "createdAt" | "lastRefreshedAt">): string {
  return createHash("sha256").update(payloadFor(pin)).digest("hex");
}

function validIntegrity(pin: PreservationPin): boolean {
  const expected = Buffer.from(integrityFor(pin), "hex");
  const actual = Buffer.from(pin.integrity, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function validPin(value: unknown, sourceHash: string): value is PreservationPin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join(",") !== "createdAt,integrity,lastRefreshedAt,pinUntil,sourceHash,version" ||
      candidate.version !== MARKER_VERSION || candidate.sourceHash !== sourceHash ||
      typeof candidate.pinUntil !== "string" || typeof candidate.createdAt !== "string" || typeof candidate.lastRefreshedAt !== "string" ||
      typeof candidate.integrity !== "string" || !/^[a-f0-9]{64}$/.test(candidate.integrity) ||
      !validDate(candidate.pinUntil) || !validDate(candidate.createdAt) || !validDate(candidate.lastRefreshedAt)) return false;
  return validIntegrity(candidate as unknown as PreservationPin);
}

async function hasQuarantineAt(context: MarkerDirectoryContext, sourceHash: string): Promise<boolean> {
  const prefix = `${sourceHash}`;
  const entries = await fs.readdir(context.directory, { withFileTypes: true });
  return entries.some((entry) => entry.isFile() && entry.name.startsWith(prefix) && QUARANTINE_SUFFIX.test(entry.name.slice(prefix.length)));
}

async function readMarkerAtLock(options: ResolvedPinOptions): Promise<PreservationPinInspection> {
  let context: MarkerDirectoryContext | undefined;
  try {
    context = await openMarkerDirectory(options.rootDir, false);
    if (!context) return { state: "absent" };
    const file = markerPath(context.directory, options.sourceHash);
    let handle: fs.FileHandle;
    try { handle = await fs.open(file, secureFlags(0)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: await hasQuarantineAt(context, options.sourceHash) ? "unavailable" : "absent" };
      return { state: "unavailable" };
    }
    try {
      const stat = await handle.stat();
      const pathStat = await nodeFs.promises.lstat(file);
      if (!secureFileStat(stat) || !secureFileStat(pathStat) || !sameIdentity(stat, pathStat) || !await directoryStillSame(context)) return { state: "invalid" };
      const value: unknown = JSON.parse(await handle.readFile("utf8"));
      if (!validPin(value, options.sourceHash)) return { state: "invalid" };
      if (!await directoryStillSame(context)) return { state: "invalid" };
      const finalPathStat = await nodeFs.promises.lstat(file);
      if (!secureFileStat(finalPathStat) || !sameIdentity(stat, finalPathStat)) return { state: "invalid" };
      const pin = value as PreservationPin;
      return { state: options.now.getTime() < Date.parse(pin.pinUntil) ? "valid" : "expired", pin };
    } finally { await handle.close(); }
  } catch (error) {
    return { state: error instanceof BridgeStoreError ? error.kind : "unavailable" };
  } finally {
    await context?.handle.close().catch(() => undefined);
  }
}

/** Internal GC/read path; not exported from the package root. */
export async function inspectPreservationPinAtLockInternal(options: PreservationPinReadOptions, dependencies?: BridgeDependencies): Promise<PreservationPinInspection> {
  const now = effectiveNow(dependencies);
  if (!now) return { state: "unavailable" };
  try { assertSourceHash(options.sourceHash); } catch { return { state: "invalid" }; }
  return readMarkerAtLock({ ...options, now });
}

async function securePathExists(context: MarkerDirectoryContext, file: string): Promise<boolean> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, secureFlags(0)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const fdStat = await handle.stat();
    const pathStat = await nodeFs.promises.lstat(file);
    if (!secureFileStat(fdStat) || !secureFileStat(pathStat) || !sameIdentity(fdStat, pathStat) || !await directoryStillSame(context)) throw new BridgeStoreError("invalid", "marker target identity changed");
    return true;
  } finally { await handle.close(); }
}

async function targetMarkerExistsSecurely(context: MarkerDirectoryContext, sourceHash: string): Promise<boolean> {
  return securePathExists(context, markerPath(context.directory, sourceHash));
}

async function atomicWriteMarker(context: MarkerDirectoryContext, sourceHash: string, pin: PreservationPin, now: Date, replaceExisting: boolean, contextDependencies?: BridgeDependencies): Promise<void> {
  const file = markerPath(context.directory, sourceHash);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryHandle: fs.FileHandle | undefined;
  let boundTarget: { handle: fs.FileHandle; stat: nodeFs.Stats } | undefined;
  try {
    temporaryHandle = await fs.open(temporary, "wx", 0o600);
    await temporaryHandle.writeFile(JSON.stringify(pin), "utf8");
    await temporaryHandle.chmod(0o600);
    await temporaryHandle.utimes(now, now);
    await temporaryHandle.sync();
    const temporaryStat = await temporaryHandle.stat();
    const temporaryPathStat = await nodeFs.promises.lstat(temporary);
    if (!secureFileStat(temporaryStat) || !secureFileStat(temporaryPathStat) || !sameIdentity(temporaryStat, temporaryPathStat)) {
      throw new BridgeStoreError("invalid", "temporary marker identity cannot be proven");
    }
    if (!await directoryStillSame(context)) throw new BridgeStoreError("invalid", "marker directory changed before rename");
    boundTarget = await openMarkerFile(context, sourceHash);
    if ((boundTarget !== undefined) !== replaceExisting) throw new BridgeStoreError("invalid", "marker target changed before rename");
    if (boundTarget && (!sameIdentity(boundTarget.stat, await boundTarget.handle.stat()) || !await directoryStillSame(context))) {
      throw new BridgeStoreError("invalid", "bound marker target changed before rename");
    }
    // Node does not expose renameat(2). The checked directory handle, checked
    // temp inode, and identity lock bind all supported participants; a same-
    // UID adversary racing path rename is outside that boundary and is checked
    // again below rather than being claimed as impossible.
    await contextDependencies?.beforePublish?.({ directory: context.directory, temporary, target: file });
    const temporaryBeforeRename = await temporaryHandle.stat();
    const temporaryPathBeforeRename = await nodeFs.promises.lstat(temporary);
    if (!secureFileStat(temporaryBeforeRename) || temporaryBeforeRename.nlink !== 1 || !sameIdentity(temporaryStat, temporaryBeforeRename) || !secureFileStat(temporaryPathBeforeRename) || !sameIdentity(temporaryBeforeRename, temporaryPathBeforeRename) || !await directoryStillSame(context)) {
      throw new BridgeStoreError("invalid", "temporary marker changed before rename");
    }
    if (boundTarget) {
      const targetBeforeRename = await boundTarget.handle.stat();
      const targetPathBeforeRename = await nodeFs.promises.lstat(file);
      if (!secureFileStat(targetBeforeRename) || targetBeforeRename.nlink !== 1 || !sameIdentity(boundTarget.stat, targetBeforeRename) || !secureFileStat(targetPathBeforeRename) || !sameIdentity(targetBeforeRename, targetPathBeforeRename)) {
        throw new BridgeStoreError("invalid", "bound marker target changed before rename");
      }
    }
    await fs.rename(temporary, file);
    const temporaryAfter = await temporaryHandle.stat();
    if (!secureFileStat(temporaryAfter) || temporaryAfter.nlink !== 1 || !sameIdentity(temporaryStat, temporaryAfter) || !await directoryStillSame(context)) {
      throw new BridgeStoreError("invalid", "published temporary identity cannot be proven");
    }
    const published = await openMarkerFile(context, sourceHash);
    if (!published) throw new BridgeStoreError("invalid", "published marker disappeared");
    try {
      const publishedAfter = await published.handle.stat();
      if (!secureFileStat(publishedAfter) || publishedAfter.nlink !== 1 || !sameIdentity(temporaryAfter, publishedAfter) || !await directoryStillSame(context)) {
        throw new BridgeStoreError("invalid", "published marker is not the bound temporary inode");
      }
    } finally { await published.handle.close(); }
    await context.handle.sync();
    if (!await directoryStillSame(context)) throw new BridgeStoreError("invalid", "marker directory changed after rename");
  } finally {
    if (boundTarget) await boundTarget.handle.close().catch(() => undefined);
    if (temporaryHandle) await temporaryHandle.close().catch(() => undefined);
    await removePathIfSame(temporary).catch(() => undefined);
  }
}

async function openMarkerFile(context: MarkerDirectoryContext, sourceHash: string): Promise<{ handle: fs.FileHandle; stat: nodeFs.Stats } | undefined> {
  const file = markerPath(context.directory, sourceHash);
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, secureFlags(0)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    const pathStat = await nodeFs.promises.lstat(file);
    if (!secureFileStat(stat) || !secureFileStat(pathStat) || !sameIdentity(stat, pathStat) || !await directoryStillSame(context)) {
      await handle.close();
      throw new BridgeStoreError("invalid", "marker file identity changed");
    }
    return { handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function removePathIfSame(file: string): Promise<void> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, secureFlags(0)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    const fdStat = await handle.stat();
    const pathStat = await nodeFs.promises.lstat(file);
    if (!secureFileStat(fdStat) || !secureFileStat(pathStat) || !sameIdentity(fdStat, pathStat)) throw new BridgeStoreError("invalid", "temporary marker identity changed");
    // Keep the checked fd open until the unlink path operation completes.
    await fs.unlink(file);
  } finally { await handle.close(); }
}

async function removeMarkerAtLock(options: ResolvedPinOptions, allowValid = false): Promise<boolean> {
  let context: MarkerDirectoryContext | undefined;
  let opened: { handle: fs.FileHandle; stat: nodeFs.Stats } | undefined;
  let quarantineHandle: fs.FileHandle | undefined;
  let claimActive = false;
  let quarantine = "";
  try {
    context = await openMarkerDirectory(options.rootDir, false);
    if (!context) return true;
    opened = await openMarkerFile(context, options.sourceHash);
    if (!opened) return true;
    const marker = markerPath(context.directory, options.sourceHash);
    quarantine = `${marker}.quarantine-${process.pid}-${randomUUID()}`;
    if (!await directoryStillSame(context)) return false;
    if (await securePathExists(context, quarantine)) return false;
    // Claim the exact checked inode under the identity lock. Node has no
    // renameat/unlinkat binding; 0700 storage plus this identity lock define
    // the supported-participant boundary. A same-UID adversary racing the
    // pathname is outside that boundary and is never claimed impossible.
    // A failed claim leaves the artifact in place; GC must not infer that it
    // is safe to delete.
    await fs.rename(marker, quarantine); claimActive = true;
    const claimedStat = await opened.handle.stat();
    if (!secureFileStat(claimedStat) || claimedStat.nlink !== 1 || !sameIdentity(opened.stat, claimedStat) || !await directoryStillSame(context)) return false;
    quarantineHandle = await fs.open(quarantine, secureFlags(0));
    const quarantineStat = await quarantineHandle.stat();
    const quarantinePathStat = await nodeFs.promises.lstat(quarantine);
    if (!secureFileStat(quarantineStat) || quarantineStat.nlink !== 1 || !sameIdentity(claimedStat, quarantineStat) || !secureFileStat(quarantinePathStat) || !sameIdentity(quarantineStat, quarantinePathStat) || !await directoryStillSame(context)) return false;
    const value: unknown = JSON.parse(await quarantineHandle.readFile("utf8"));
    if (!validPin(value, options.sourceHash) || (!allowValid && options.now.getTime() < Date.parse((value as PreservationPin).pinUntil))) return false;
    const latestClaimed = await quarantineHandle.stat();
    const latestPath = await nodeFs.promises.lstat(quarantine);
    if (!secureFileStat(latestClaimed) || !sameIdentity(quarantineStat, latestClaimed) || !secureFileStat(latestPath) || !sameIdentity(latestClaimed, latestPath) || !await directoryStillSame(context)) return false;
    await fs.unlink(quarantine); claimActive = false;
    await context.handle.sync();
    if (!await directoryStillSame(context)) return false;
    return true;
  } catch { return false; }
  finally {
    await quarantineHandle?.close().catch(() => undefined);
    await opened?.handle.close().catch(() => undefined);
    if (claimActive && context && opened && quarantine) {
      try {
        const restored = await nodeFs.promises.lstat(quarantine); const marker = markerPath(context.directory, options.sourceHash);
        if (secureFileStat(restored) && sameIdentity(restored, opened.stat) && !(await securePathExists(context, marker))) { await fs.rename(quarantine, marker); await context.handle.sync(); }
      } catch { /* retain only the original inode; never replace an unknown marker */ }
    }
    await context?.handle.close().catch(() => undefined);
  }
}

function desiredPin(options: ResolvedPinOptions): PreservationPin | undefined {
  const pinUntil = options.pinUntil ?? new Date(options.now.getTime() + DEFAULT_ROLLBACK_WINDOW_MS);
  if (!(pinUntil instanceof Date) || !Number.isFinite(pinUntil.getTime()) || pinUntil.getTime() <= options.now.getTime()) return undefined;
  const timestamp = options.now.toISOString();
  const base = { version: MARKER_VERSION as 1, sourceHash: options.sourceHash, pinUntil: pinUntil.toISOString(), createdAt: timestamp, lastRefreshedAt: timestamp };
  return { ...base, integrity: integrityFor(base) };
}

function resolvedOptions<T extends PreservationPinReadOptions>(options: T, dependencies?: BridgeDependencies): ResolvedPinOptions | undefined {
  const now = effectiveNow(dependencies);
  if (!now) return undefined;
  try { assertSourceHash(options.sourceHash); } catch { return undefined; }
  return { ...options, now, dependencies };
}

export async function inspectPreservationPinInternal(options: PreservationPinReadOptions, dependencies?: BridgeDependencies): Promise<PreservationPinInspection> {
  const resolved = resolvedOptions(options, dependencies);
  if (!resolved) return { state: "unavailable" };
  try { await secureRoot(resolved.rootDir); } catch (error) {
    return { state: error instanceof BridgeStoreError ? error.kind : "unavailable" };
  }
  const locked = await withIdentityLock({ rootDir: resolved.rootDir, key: resolved.sourceHash }, async () => readMarkerAtLock(resolved));
  return locked ?? { state: "busy" };
}

/** Lock-scoped mutations used by adoption/rollback. The caller owns the
 * source identity lock; these functions deliberately do not reacquire it. */
export async function createPreservationPinAtLockInternal(options: PreservationPinCreateOptions, dependencies?: BridgeDependencies): Promise<PreservationPinMutation> {
  const resolved = resolvedOptions(options, dependencies); if (!resolved) return { status: "rejected" };
  const requested = desiredPin(resolved); if (!requested) return { status: "rejected" };
  try { await secureMarkerDirectory(resolved.rootDir, true); } catch { return { status: "rejected" }; }
  const current = await readMarkerAtLock(resolved);
  if (current.state === "valid") return current.pin?.pinUntil === requested.pinUntil ? { status: "already_exists", pin: current.pin } : { status: "conflict", pin: current.pin };
  if (current.state === "invalid" || current.state === "unavailable") return { status: "rejected" };
  const context = await openMarkerDirectory(resolved.rootDir, true); if (!context) return { status: "rejected" };
  try { await atomicWriteMarker(context, resolved.sourceHash, requested, resolved.now, false, resolved.dependencies); return { status: "created", pin: requested }; }
  catch { return { status: "rejected" }; } finally { await context.handle.close().catch(() => undefined); }
}

export async function refreshPreservationPinAtLockInternal(options: PreservationPinRefreshOptions, dependencies?: BridgeDependencies): Promise<PreservationPinMutation> {
  const resolved = resolvedOptions(options, dependencies); if (!resolved || !(options.pinUntil instanceof Date) || !Number.isFinite(options.pinUntil.getTime())) return { status: "rejected" };
  resolved.pinUntil = new Date(options.pinUntil.getTime()); const current = await readMarkerAtLock(resolved);
  if (current.state === "expired") return { status: "expired", pin: current.pin };
  if (current.state !== "valid" || !current.pin) return { status: "rejected" };
  if (resolved.pinUntil.getTime() < Date.parse(current.pin.pinUntil)) return { status: "conflict", pin: current.pin };
  if (resolved.pinUntil.getTime() === Date.parse(current.pin.pinUntil)) return { status: "already_exists", pin: current.pin };
  const base = { version: MARKER_VERSION as 1, sourceHash: resolved.sourceHash, pinUntil: resolved.pinUntil.toISOString(), createdAt: current.pin.createdAt, lastRefreshedAt: resolved.now.toISOString() };
  const next = { ...base, integrity: integrityFor(base) }; const context = await openMarkerDirectory(resolved.rootDir, false); if (!context) return { status: "rejected" };
  try { await atomicWriteMarker(context, resolved.sourceHash, next, resolved.now, true, resolved.dependencies); return { status: "refreshed", pin: next }; }
  catch { return { status: "rejected" }; } finally { await context.handle.close().catch(() => undefined); }
}

export async function releasePreservationPinAtLockInternal(options: PreservationPinReleaseOptions, dependencies?: BridgeDependencies): Promise<PreservationPinMutation> {
  const resolved = resolvedOptions(options, dependencies); if (!resolved) return { status: "rejected" };
  const current = await readMarkerAtLock(resolved); if (current.state === "absent") return { status: "absent" };
  if ((current.state !== "valid" && current.state !== "expired") || !current.pin) return { status: "rejected" };
  return await removeMarkerAtLock(resolved, true) ? { status: "released", pin: current.pin } : { status: "rejected" };
}

export async function createPreservationPinInternal(options: PreservationPinCreateOptions, dependencies?: BridgeDependencies): Promise<PreservationPinMutation> {
  const resolved = resolvedOptions(options, dependencies);
  if (!resolved) return { status: "rejected" };
  const requested = desiredPin(resolved);
  if (!requested) return { status: "rejected" };
  try { await secureMarkerDirectory(resolved.rootDir, true); } catch { return { status: "rejected" }; }
  const locked = await withIdentityLock({ rootDir: resolved.rootDir, key: resolved.sourceHash }, async () => {
    const current = await readMarkerAtLock(resolved);
    if (current.state === "valid") {
      if (current.pin?.pinUntil === requested.pinUntil) return { status: "already_exists", pin: current.pin } satisfies PreservationPinMutation;
      return { status: "conflict", pin: current.pin } satisfies PreservationPinMutation;
    }
    if (current.state === "invalid" || current.state === "unavailable") return { status: "rejected" } satisfies PreservationPinMutation;
    const context = await openMarkerDirectory(resolved.rootDir, true);
    if (!context) return { status: "rejected" } satisfies PreservationPinMutation;
    try {
      await atomicWriteMarker(context, resolved.sourceHash, requested, resolved.now, false, resolved.dependencies);
      return { status: "created", pin: requested } satisfies PreservationPinMutation;
    } catch { return { status: "rejected" } satisfies PreservationPinMutation; }
    finally { await context.handle.close().catch(() => undefined); }
  });
  return locked ?? { status: "busy" };
}

export async function refreshPreservationPinInternal(options: PreservationPinRefreshOptions, dependencies?: BridgeDependencies): Promise<PreservationPinMutation> {
  const resolved = resolvedOptions(options, dependencies);
  if (!resolved || !(options.pinUntil instanceof Date) || !Number.isFinite(options.pinUntil.getTime())) return { status: "rejected" };
  resolved.pinUntil = new Date(options.pinUntil.getTime());
  try { await secureRoot(resolved.rootDir); } catch { return { status: "rejected" }; }
  const locked = await withIdentityLock({ rootDir: resolved.rootDir, key: resolved.sourceHash }, async () => {
    const current = await readMarkerAtLock(resolved);
    if (current.state === "expired") return { status: "expired", pin: current.pin } satisfies PreservationPinMutation;
    if (current.state !== "valid" || !current.pin) return { status: "rejected" } satisfies PreservationPinMutation;
    const nextUntil = resolved.pinUntil!.getTime();
    if (nextUntil < Date.parse(current.pin.pinUntil)) return { status: "conflict", pin: current.pin } satisfies PreservationPinMutation;
    if (nextUntil === Date.parse(current.pin.pinUntil)) return { status: "already_exists", pin: current.pin } satisfies PreservationPinMutation;
    const base = { version: MARKER_VERSION as 1, sourceHash: resolved.sourceHash, pinUntil: resolved.pinUntil!.toISOString(), createdAt: current.pin.createdAt, lastRefreshedAt: resolved.now.toISOString() };
    const next = { ...base, integrity: integrityFor(base) };
    const context = await openMarkerDirectory(resolved.rootDir, false);
    if (!context) return { status: "rejected" } satisfies PreservationPinMutation;
    try {
      await atomicWriteMarker(context, resolved.sourceHash, next, resolved.now, true, resolved.dependencies);
      return { status: "refreshed", pin: next } satisfies PreservationPinMutation;
    } catch { return { status: "rejected" } satisfies PreservationPinMutation; }
    finally { await context.handle.close().catch(() => undefined); }
  });
  return locked ?? { status: "busy" };
}

export async function releasePreservationPinInternal(options: PreservationPinReleaseOptions, dependencies?: BridgeDependencies): Promise<PreservationPinMutation> {
  const resolved = resolvedOptions(options, dependencies);
  if (!resolved) return { status: "rejected" };
  try { await secureRoot(resolved.rootDir); } catch { return { status: "rejected" }; }
  const locked = await withIdentityLock({ rootDir: resolved.rootDir, key: resolved.sourceHash }, async () => {
    const current = await readMarkerAtLock(resolved);
    if (current.state === "absent") return { status: "absent" } satisfies PreservationPinMutation;
    if ((current.state !== "valid" && current.state !== "expired") || !current.pin) return { status: "rejected" } satisfies PreservationPinMutation;
    return await removeMarkerAtLock(resolved, true) ? { status: "released", pin: current.pin } satisfies PreservationPinMutation : { status: "rejected" } satisfies PreservationPinMutation;
  });
  return locked ?? { status: "busy" };
}

/** Internal GC path; not exported from the package root. */
export async function removePreservationPinAtLockInternal(options: PreservationPinReadOptions, dependencies?: BridgeDependencies): Promise<boolean> {
  const resolved = resolvedOptions(options, dependencies);
  return resolved ? removeMarkerAtLock(resolved) : false;
}

/** Production package API: clock and race seams are intentionally unreachable. */
export async function inspectPreservationPin(options: PreservationPinReadOptions): Promise<PreservationPinInspection> {
  return inspectPreservationPinInternal(options);
}

export async function createPreservationPin(options: PreservationPinCreateOptions): Promise<PreservationPinMutation> {
  return createPreservationPinInternal(options);
}

export async function refreshPreservationPin(options: PreservationPinRefreshOptions): Promise<PreservationPinMutation> {
  return refreshPreservationPinInternal(options);
}

export async function releasePreservationPin(options: PreservationPinReleaseOptions): Promise<PreservationPinMutation> {
  return releasePreservationPinInternal(options);
}
