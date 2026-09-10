import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, chmodSync, writeFileSync, unlinkSync, rmdirSync, truncateSync, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { RunGarbageCollector } from './run-gc.ts';
import type { Checkpoint, RunStore } from '@pi/workflow-contracts';

export type WalRecordType = 'header' | 'supplement' | 'delivery' | 'close_fence' | 'checkpoint' | 'worker' | 'legacy_migrated' | 'shutdown';

export interface RunControlRecord {
  type: WalRecordType;
  recordId: string;
  runId: string;
  epoch: number;
  index: number;
  occurredAt: string;
  payload: Record<string, unknown>;
  checksum: string;
}

interface Lease { runId: string; host: string; pid: number; instanceNonce: string; epoch: number; acquiredAt: string; }

export interface RunControlWalOptions {
  /** Protected Pi agent directory. Defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  rootDir?: string;
  /** A stable identity for this extension instance. */
  instanceNonce?: string;
  /** Only used by tests; production uses Date.now(). */
  now?: () => number;
  /** Explicit UI-confirmed takeover of an active/uncertain writer lease. */
  takeOverConfirmed?: boolean;
  /** New runs bind their control log to this parent session context. */
  parentSessionId?: string;
  parentLeafId?: string;
  cwd?: string;
}

export class RunControlWalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'RunControlWalError'; this.code = code; }
}

const defaultRoot = () => process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.cwd(), '.pi', 'agent');
const safePart = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');
const canonical = (value: unknown) => JSON.stringify(value);
const checksumFor = (record: Omit<RunControlRecord, 'checksum'>) => createHash('sha256').update(canonical(record)).digest('hex');
const fsyncFile = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const fsyncDirectory = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const writeJsonDurably = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 }); chmodSync(path, 0o600); fsyncFile(path); };
const currentHost = () => hostname();
const pidIsAlive = (host: string, pid: number) => {
  if (host !== currentHost() || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Durable Run Control log. Every replay, truncation and append is performed
 * while holding the per-run operation lock and after validating the writer
 * lease. A malformed record is never silently shortened: only an incomplete
 * JSON tail without a newline is recoverable.
 */
export class RunControlWal {
  readonly runId: string;
  readonly rootDir: string;
  readonly runDir: string;
  readonly walPath: string;
  readonly lockPath: string;
  readonly leasePath: string;
  readonly instanceNonce: string;
  private readonly now: () => number;
  private readonly headerBinding: { parentSessionId?: string; parentLeafId?: string; cwd?: string };
  private epoch = 0;
  private nextIndex = 0;
  private nextSupplementVersion = 1;
  private closed = false;

  private constructor(runId: string, options: RunControlWalOptions = {}) {
    this.runId = runId;
    this.rootDir = options.rootDir ?? defaultRoot();
    this.runDir = join(this.rootDir, 'workflow-runs', safePart(runId));
    this.walPath = join(this.runDir, 'control.wal');
    this.lockPath = join(this.rootDir, 'workflow-runs', 'locks', `${safePart(runId)}.lock`);
    this.leasePath = join(this.rootDir, 'workflow-runs', 'locks', `${safePart(runId)}.lease.json`);
    this.instanceNonce = options.instanceNonce ?? randomUUID();
    this.now = options.now ?? (() => Date.now());
    this.headerBinding = { parentSessionId: options.parentSessionId, parentLeafId: options.parentLeafId, cwd: options.cwd };
  }

  static open(runId: string, options: RunControlWalOptions = {}): RunControlWal {
    const wal = new RunControlWal(runId, options);
    wal.ensureLayout();
    wal.withOperationLock(() => {
      wal.replayLocked();
      if (existsSync(wal.walPath)) wal.validateHeaderBindingLocked();
      wal.acquireLeaseLocked(options.takeOverConfirmed === true);
      if (!existsSync(wal.walPath)) {
        wal.appendLocked('header', {
          schemaVersion: 1,
          runId,
          createdAt: new Date(wal.now()).toISOString(),
          ...(wal.headerBinding.parentSessionId !== undefined ? { parentSessionId: wal.headerBinding.parentSessionId } : {}),
          ...(wal.headerBinding.parentLeafId !== undefined ? { parentLeafId: wal.headerBinding.parentLeafId } : {}),
          ...(wal.headerBinding.cwd !== undefined ? { cwd: wal.headerBinding.cwd } : {}),
        });
      }
    });
    return wal;
  }

  static list(rootDir = defaultRoot()): string[] {
    const dir = join(rootDir, 'workflow-runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name !== 'locks' && !entry.name.startsWith('.trash-')).map((entry) => entry.name);
  }

  private ensureLayout() {
    const workflowDir = join(this.rootDir, 'workflow-runs');
    const locksDir = join(workflowDir, 'locks');
    for (const dir of [this.rootDir, workflowDir, locksDir, this.runDir]) { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); }
  }

  private withOperationLock<T>(fn: () => T): T {
    this.ensureLayout();
    let acquired = false;
    try {
      mkdirSync(this.lockPath, { mode: 0o700 });
      acquired = true;
      chmodSync(this.lockPath, 0o700);
      writeJsonDurably(join(this.lockPath, 'owner.json'), { pid: process.pid, host: hostname(), instanceNonce: this.instanceNonce, acquiredAt: new Date(this.now()).toISOString() });
      return fn();
    } catch (error) {
      if (error instanceof RunControlWalError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const ownerPath = join(this.lockPath, 'owner.json');
        let owner: { host?: string; pid?: number } | undefined;
        try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { host?: string; pid?: number }; } catch { /* publisher may not have finished */ }
        if (!owner || owner.host !== currentHost() || pidIsAlive(String(owner.host), Number(owner.pid))) throw new RunControlWalError('OPERATION_LOCK_BUSY', `run ${this.runId} operation lock is held or its owner is uncertain`);
        try { unlinkSync(ownerPath); rmdirSync(this.lockPath); } catch { throw new RunControlWalError('OPERATION_LOCK_BUSY', `run ${this.runId} operation lock could not be safely reclaimed`); }
        return this.withOperationLock(fn);
      }
      throw new RunControlWalError('WAL_IO_FAILED', `run ${this.runId} operation lock failed: ${String(error)}`);
    } finally {
      if (acquired && existsSync(this.lockPath)) { try { unlinkSync(join(this.lockPath, 'owner.json')); } catch { /* best effort */ } try { rmdirSync(this.lockPath); } catch { /* preserve uncertainty */ } }
    }
  }

  private readLease(): Lease | undefined {
    if (!existsSync(this.leasePath)) return undefined;
    try { return JSON.parse(readFileSync(this.leasePath, 'utf8')) as Lease; }
    catch { throw new RunControlWalError('LEASE_CORRUPT', `run ${this.runId} writer lease is corrupt`); }
  }

  private acquireLeaseLocked(force: boolean) {
    const existing = this.readLease();
    if (existing && existing.instanceNonce !== this.instanceNonce) {
      if (!force && (existing.host !== currentHost() || pidIsAlive(existing.host, existing.pid))) throw new RunControlWalError('WRITER_LEASE_ACTIVE', `run ${this.runId} has an active or uncertain writer lease`);
      if (!force && existing.host === currentHost() && !pidIsAlive(existing.host, existing.pid)) { /* a provably dead owner is safe to replace */ }
      else if (!force) throw new RunControlWalError('WRITER_OWNER_UNCERTAIN', `run ${this.runId} writer owner cannot be proven dead`);
    }
    // Never derive a new epoch from a replay after writing the takeover lease.
    this.epoch = Math.max(this.epoch, existing?.epoch ?? 0) + 1;
    writeJsonDurably(this.leasePath, { runId: this.runId, host: hostname(), pid: process.pid, instanceNonce: this.instanceNonce, epoch: this.epoch, acquiredAt: new Date(this.now()).toISOString() } satisfies Lease);
    fsyncDirectory(dirname(this.leasePath));
  }

  private validateHeaderBindingLocked() {
    const header = this.recordsUnlocked().find((record) => record.type === 'header');
    if (!header) throw new RunControlWalError('WAL_HEADER_MISSING', `run ${this.runId} control WAL has no header`);
    const rebinding = this.recordsUnlocked().filter((record) => record.type === 'worker' && record.payload.kind === 'parent_rebind').at(-1);
    const effective = rebinding?.payload.to && typeof rebinding.payload.to === 'object'
      ? rebinding.payload.to as Record<string, unknown>
      : header.payload;
    for (const field of ['parentSessionId', 'parentLeafId', 'cwd'] as const) {
      const expected = this.headerBinding[field];
      if (expected !== undefined && effective[field] !== expected) throw new RunControlWalError('WAL_HEADER_BINDING_MISMATCH', `run ${this.runId} binding ${field} does not match the current parent context`);
    }
  }

  private replayLocked() {
    const replayEpoch = this.epoch;
    this.nextIndex = 0;
    this.nextSupplementVersion = 1;
    this.closed = false;
    if (!existsSync(this.walPath)) { this.epoch = replayEpoch; return; }
    const contents = readFileSync(this.walPath, 'utf8');
    let validBytes = 0;
    const lines = contents.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      const hasNewline = lineIndex < lines.length - 1;
      const lineBytes = Buffer.byteLength(line, 'utf8') + (hasNewline ? 1 : 0);
      if (!line.trim()) { validBytes += lineBytes; continue; }
      let record: RunControlRecord;
      try { record = JSON.parse(line) as RunControlRecord; }
      catch {
        if (!hasNewline && lineIndex === lines.length - 1) {
          truncateSync(this.walPath, validBytes);
          fsyncFile(this.walPath);
          break;
        }
        throw new RunControlWalError('WAL_CORRUPT', `run ${this.runId} control WAL contains internal corruption`);
      }
      const { checksum, ...body } = record;
      if (!hasNewline) throw new RunControlWalError('WAL_CORRUPT', `run ${this.runId} control WAL ends without a commit newline`);
      if (checksum !== checksumFor(body) || record.runId !== this.runId || record.index !== this.nextIndex) throw new RunControlWalError('WAL_CORRUPT', `run ${this.runId} control WAL contains a corrupted committed record`);
      validBytes += lineBytes;
      this.nextIndex += 1;
      this.epoch = Math.max(this.epoch, record.epoch);
      if (record.type === 'supplement' && typeof record.payload.sequence === 'number') this.nextSupplementVersion = Math.max(this.nextSupplementVersion, Number(record.payload.sequence) + 1);
      if (record.type === 'close_fence') this.closed = true;
      if (record.type === 'worker' && record.payload.kind === 'session_started') this.closed = false;
    }
    // A valid JSON object without the commit newline is not a committed record.
    // It is not an incomplete JSON tail, so fail closed rather than truncating it.
    this.epoch = Math.max(this.epoch, replayEpoch);
  }

  private assertLease() {
    const lease = this.readLease();
    if (!lease || lease.instanceNonce !== this.instanceNonce || lease.epoch !== this.epoch) throw new RunControlWalError('STALE_WRITER_EPOCH', `run ${this.runId} writer lease was replaced`);
  }

  private appendLocked(type: WalRecordType, payload: Record<string, unknown>): RunControlRecord {
    this.assertLease();
    const body: Omit<RunControlRecord, 'checksum'> = { type, recordId: randomUUID(), runId: this.runId, epoch: this.epoch, index: this.nextIndex, occurredAt: new Date(this.now()).toISOString(), payload };
    const record = { ...body, checksum: checksumFor(body) };
    const wasPresent = existsSync(this.walPath);
    const fd = openSync(this.walPath, 'a', 0o600);
    try { fsyncSync(fd); writeFileSync(fd, `${JSON.stringify(record)}\n`, { encoding: 'utf8' }); fsyncSync(fd); }
    finally { closeSync(fd); }
    chmodSync(this.walPath, 0o600);
    if (!wasPresent) fsyncDirectory(dirname(this.walPath));
    this.nextIndex += 1;
    if (type === 'close_fence') this.closed = true;
    return record;
  }

  append(type: WalRecordType, payload: Record<string, unknown>) { return this.withOperationLock(() => this.appendLocked(type, payload)); }

  recordSupplement(input: { submissionAttemptId: string; nodeExecutionId: string; workerSessionId: string; text: string }) {
    return this.withOperationLock(() => {
      this.assertLease();
      if (this.closed) return this.appendLocked('delivery', { submissionAttemptId: input.submissionAttemptId, state: 'rejected_after_fence', nodeExecutionId: input.nodeExecutionId, workerSessionId: input.workerSessionId, text: input.text });
      const sequence = this.nextSupplementVersion;
      const record = this.appendLocked('supplement', { ...input, supplementId: randomUUID(), sequence, state: 'recorded' });
      this.nextSupplementVersion += 1;
      return record;
    });
  }

  recordDelivery(payload: Record<string, unknown>) { return this.append('delivery', payload); }
  beginWorker(payload: Record<string, unknown>) {
    return this.withOperationLock(() => {
      this.assertLease();
      const nodeExecutionId = payload.nodeExecutionId;
      if (typeof nodeExecutionId !== 'string' || !nodeExecutionId.trim()) throw new RunControlWalError('WORKER_IDENTITY_REQUIRED', 'worker startup requires a logical nodeExecutionId');
      const attempts = this.recordsUnlocked().filter((record) => record.type === 'worker' && record.payload.kind === 'session_started').length;
      if (attempts >= 20) throw new RunControlWalError('WORKER_ATTEMPT_LIMIT', `run ${this.runId} exceeded the 20 recovery-attempt limit`);
      this.closed = false;
      return this.appendLocked('worker', { ...payload, kind: 'session_started', recoveryAttempt: attempts + 1, runAttempt: attempts + 1 });
    });
  }
  recordWorker(payload: Record<string, unknown>) { return this.append('worker', payload); }
  recordCheckpoint(payload: Record<string, unknown>) { return this.append('checkpoint', payload); }
  closeFence(payload: Record<string, unknown> = {}) { return this.withOperationLock(() => this.closed ? this.recordsUnlocked().find((record) => record.type === 'close_fence') : this.appendLocked('close_fence', payload)); }
  markShutdown() { try { return this.append('shutdown', { status: 'interrupted_attempt' }); } catch { return undefined; } }

  /** Explicit, user-confirmed rebind to a new parent in the same cwd. The original header and runId remain intact. */
  rebindParent(input: { parentSessionId: string; parentLeafId: string; cwd: string; confirmed: boolean }) {
    if (!input.confirmed) throw new RunControlWalError('PARENT_REBIND_CONFIRMATION_REQUIRED', 'parent rebind requires explicit user confirmation');
    return this.withOperationLock(() => {
      this.assertLease();
      const header = this.recordsUnlocked().find((record) => record.type === 'header');
      if (!header || typeof header.payload.cwd !== 'string' || header.payload.cwd !== input.cwd) throw new RunControlWalError('PARENT_REBIND_CWD_MISMATCH', 'parent rebind is allowed only in the original cwd');
      const previous = this.recordsUnlocked().filter((record) => record.type === 'worker' && record.payload.kind === 'parent_rebind').at(-1)?.payload.to ?? header.payload;
      return this.appendLocked('worker', { kind: 'parent_rebind', from: previous, to: { parentSessionId: input.parentSessionId, parentLeafId: input.parentLeafId, cwd: input.cwd }, confirmedAt: new Date(this.now()).toISOString() });
    });
  }

  static rebindParent(runId: string, options: RunControlWalOptions & { parentSessionId: string; parentLeafId: string; cwd: string; confirmed: boolean }) {
    const wal = RunControlWal.open(runId, { ...options, parentSessionId: undefined, parentLeafId: undefined, cwd: undefined });
    try { return wal.rebindParent(options); } finally { try { wal.releaseLease(); } catch { /* preserve for explicit recovery */ } }
  }

  static gc(rootDir = defaultRoot(), now = Date.now(), retentionDays = 30, orphanDays = 7) {
    return RunGarbageCollector.collect(rootDir, { now, retentionMs: retentionDays * 86400000, orphanDeadlineMs: orphanDays * 86400000 });
  }

  private recordsUnlocked(): RunControlRecord[] {
    if (!existsSync(this.walPath)) return [];
    const records: RunControlRecord[] = [];
    let expectedIndex = 0;
    const lines = readFileSync(this.walPath, 'utf8').split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex]!;
      if (!line.trim()) continue;
      if (lineIndex === lines.length - 1) throw new RunControlWalError('WAL_CORRUPT', `run ${this.runId} control WAL ends without a commit newline`);
      let record: RunControlRecord;
      try { record = JSON.parse(line) as RunControlRecord; } catch { throw new RunControlWalError('WAL_CORRUPT', `run ${this.runId} control WAL contains internal corruption`); }
      const { checksum, ...body } = record;
      if (record.runId !== this.runId || record.index !== expectedIndex || checksum !== checksumFor(body)) throw new RunControlWalError('WAL_CORRUPT', `run ${this.runId} control WAL contains a corrupted committed record`);
      records.push(record); expectedIndex += 1;
    }
    return records;
  }

  records() { return this.withOperationLock(() => { this.assertLease(); return this.recordsUnlocked(); }); }
  isClosed() { return this.closed; }
  getSupplementVersion() { return this.nextSupplementVersion - 1; }
  getEpoch() { return this.epoch; }
  getLease(): Readonly<Record<string, unknown>> | undefined { return this.readLease() as Readonly<Record<string, unknown>> | undefined; }

  takeOverConfirmed() {
    this.withOperationLock(() => { this.replayLocked(); this.validateHeaderBindingLocked(); this.acquireLeaseLocked(true); });
  }

  releaseLease() {
    if (!existsSync(this.leasePath)) return;
    this.withOperationLock(() => { this.assertLease(); unlinkSync(this.leasePath); fsyncDirectory(dirname(this.leasePath)); });
  }

  /** Import one active-branch legacy checkpoint through a durable generation file. */
  migrateLegacyCheckpoint(input: { parentSessionId: string; sourceEntryId: string; sourceChecksum: string; checkpoint: unknown; generation?: number }) {
    return this.withOperationLock(() => {
      this.assertLease();
      const importKey = `${input.parentSessionId}:${input.sourceEntryId}:${this.runId}:${input.sourceChecksum}`;
      const prior = this.recordsUnlocked().find((record) => record.type === 'legacy_migrated' && record.payload.importKey === importKey);
      if (prior) return prior;
      const conflict = this.recordsUnlocked().find((record) => record.type === 'legacy_migrated' && record.payload.sourceEntryId === input.sourceEntryId && record.payload.parentSessionId === input.parentSessionId && record.payload.sourceChecksum !== input.sourceChecksum);
      if (conflict) throw new RunControlWalError('LEGACY_MIGRATION_CONFLICT', `legacy checkpoint ${input.sourceEntryId} changed after migration`);
      const generation = input.generation ?? 1;
      const target = join(this.runDir, `legacy-migration.${generation}.json`);
      const temporary = `${target}.tmp-${randomUUID()}`;
      writeJsonDurably(temporary, { generation, migrated_from: { parentSessionId: input.parentSessionId, sourceEntryId: input.sourceEntryId, sourceChecksum: input.sourceChecksum }, checkpoint: input.checkpoint });
      renameSync(temporary, target);
      chmodSync(target, 0o600);
      fsyncDirectory(this.runDir);
      return this.appendLocked('legacy_migrated', { importKey, generation, migrated_from: { parentSessionId: input.parentSessionId, sourceEntryId: input.sourceEntryId, sourceChecksum: input.sourceChecksum }, checkpoint: input.checkpoint, migrationFile: target });
    });
  }
}

/** RunStore adapter used by new live runs. The parent Pi session is not a checkpoint source. */
export class RunControlWalStore implements RunStore {
  readonly wal: RunControlWal;
  constructor(wal: RunControlWal) { this.wal = wal; }
  saveCheckpoint(checkpoint: Checkpoint) { this.wal.recordCheckpoint({ checkpoint }); }
  loadLast(runId: string) {
    if (runId !== this.wal.runId) return undefined;
    return this.wal.records().map((record) => record.type === 'checkpoint' ? record.payload.checkpoint : undefined).filter((value): value is Checkpoint => !!value && typeof value === 'object' && (value as Checkpoint).runId === runId).at(-1);
  }
}
