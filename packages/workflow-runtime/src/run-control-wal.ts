import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, chmodSync, writeFileSync, unlinkSync, rmdirSync, truncateSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

export type WalRecordType =
  | 'header'
  | 'supplement'
  | 'delivery'
  | 'close_fence'
  | 'checkpoint'
  | 'worker'
  | 'legacy_migrated'
  | 'shutdown';

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

interface Lease {
  runId: string;
  host: string;
  pid: number;
  instanceNonce: string;
  epoch: number;
  acquiredAt: string;
}

export interface RunControlWalOptions {
  /** Protected Pi agent directory. Defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  rootDir?: string;
  /** A stable identity for this extension instance. */
  instanceNonce?: string;
  /** Only used by tests; production uses Date.now(). */
  now?: () => number;
  /** Explicit UI-confirmed takeover of an active/uncertain writer lease. */
  takeOverConfirmed?: boolean;
}

export class RunControlWalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RunControlWalError';
    this.code = code;
  }
}

const defaultRoot = () => process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.cwd(), '.pi', 'agent');
const safePart = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, '_');
const canonical = (value: unknown) => JSON.stringify(value);
const checksumFor = (record: Omit<RunControlRecord, 'checksum'>) => createHash('sha256').update(canonical(record)).digest('hex');
const fsyncFile = (path: string) => {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
const fsyncDirectory = (path: string) => {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};
const writeJsonDurably = (path: string, value: unknown) => {
  writeFileSync(path, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  fsyncFile(path);
};
const pidIsAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // EPERM means the owner exists but this process cannot inspect it. That is
    // deliberately treated as uncertain rather than safe to take over.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
};

/**
 * A small append-only, synchronous control WAL. Synchronous fs operations are
 * intentional: a caller is not told that a supplement is recorded until the
 * record and its directory metadata have crossed the fsync boundary.
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
  }

  static open(runId: string, options: RunControlWalOptions = {}): RunControlWal {
    const wal = new RunControlWal(runId, options);
    wal.ensureLayout();
    wal.replay();
    wal.acquireLease(options.takeOverConfirmed === true);
    if (!existsSync(wal.walPath)) {
      wal.append('header', { schemaVersion: 1, runId, createdAt: new Date(wal.now()).toISOString() });
    }
    return wal;
  }

  /** List local runs without interpreting parent Session branches. */
  static list(rootDir = defaultRoot()): string[] {
    const dir = join(rootDir, 'workflow-runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'locks' && !entry.name.startsWith('.trash-'))
      .map((entry) => entry.name);
  }

  private ensureLayout() {
    const workflowDir = join(this.rootDir, 'workflow-runs');
    const locksDir = join(workflowDir, 'locks');
    for (const dir of [this.rootDir, workflowDir, locksDir, this.runDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    }
  }

  private withOperationLock<T>(fn: () => T): T {
    this.ensureLayout();
    let acquired = false;
    try {
      mkdirSync(this.lockPath, { mode: 0o700 });
      acquired = true;
      chmodSync(this.lockPath, 0o700);
      const ownerPath = join(this.lockPath, 'owner.json');
      writeJsonDurably(ownerPath, { pid: process.pid, host: hostname(), instanceNonce: this.instanceNonce, acquiredAt: new Date(this.now()).toISOString() });
      return fn();
    } catch (error) {
      if (error instanceof RunControlWalError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const ownerPath = join(this.lockPath, 'owner.json');
        let owner: { pid?: number } | undefined;
        try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: number }; } catch { /* owner may still be publishing */ }
        if (!owner || pidIsAlive(Number(owner.pid))) {
          throw new RunControlWalError('OPERATION_LOCK_BUSY', `run ${this.runId} operation lock is held or its owner is uncertain`);
        }
        try { unlinkSync(ownerPath); rmdirSync(this.lockPath); }
        catch { throw new RunControlWalError('OPERATION_LOCK_BUSY', `run ${this.runId} operation lock could not be safely reclaimed`); }
        return this.withOperationLock(fn);
      }
      throw new RunControlWalError('WAL_IO_FAILED', `run ${this.runId} operation lock failed: ${String(error)}`);
    } finally {
      if (acquired && existsSync(this.lockPath)) {
        try { unlinkSync(join(this.lockPath, 'owner.json')); } catch { /* best effort */ }
        try { rmdirSync(this.lockPath); } catch { /* do not claim ownership was released */ }
      }
    }
  }

  private readLease(): Lease | undefined {
    if (!existsSync(this.leasePath)) return undefined;
    try { return JSON.parse(readFileSync(this.leasePath, 'utf8')) as Lease; }
    catch { throw new RunControlWalError('LEASE_CORRUPT', `run ${this.runId} writer lease is corrupt`); }
  }

  private acquireLease(force: boolean) {
    this.withOperationLock(() => {
      const existing = this.readLease();
      if (existing && existing.instanceNonce !== this.instanceNonce) {
        if (!force && pidIsAlive(existing.pid)) {
          throw new RunControlWalError('WRITER_LEASE_ACTIVE', `run ${this.runId} has an active or uncertain writer lease`);
        }
        if (!force && !pidIsAlive(existing.pid)) {
          // A provably dead owner may be taken over automatically.
        } else if (!force) {
          throw new RunControlWalError('WRITER_OWNER_UNCERTAIN', `run ${this.runId} writer owner cannot be proven dead`);
        }
      }
      this.epoch = Math.max(this.epoch, existing?.epoch ?? 0) + 1;
      writeJsonDurably(this.leasePath, {
        runId: this.runId, host: hostname(), pid: process.pid, instanceNonce: this.instanceNonce,
        epoch: this.epoch, acquiredAt: new Date(this.now()).toISOString(),
      } satisfies Lease);
      fsyncDirectory(dirname(this.leasePath));
    });
  }

  /** Explicit UI-confirmed takeover for an owner that cannot be proven dead. */
  takeOverConfirmed() {
    this.acquireLease(true);
    this.replay();
  }

  private replay() {
    this.nextIndex = 0;
    this.nextSupplementVersion = 1;
    this.closed = false;
    if (!existsSync(this.walPath)) return;
    const contents = readFileSync(this.walPath, 'utf8');
    let validBytes = 0;
    let corruptTail = false;
    for (const line of contents.split('\n')) {
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) { validBytes += lineBytes; continue; }
      let record: RunControlRecord;
      try { record = JSON.parse(line) as RunControlRecord; }
      catch { corruptTail = true; break; } // incomplete tail is not a committed record
      const { checksum, ...body } = record;
      if (checksum !== checksumFor(body) || record.runId !== this.runId || record.index !== this.nextIndex) { corruptTail = true; break; }
      validBytes += lineBytes;
      this.nextIndex += 1;
      this.epoch = Math.max(this.epoch, record.epoch);
      if (record.type === 'supplement' && typeof record.payload.sequence === 'number') {
        this.nextSupplementVersion = Math.max(this.nextSupplementVersion, Number(record.payload.sequence) + 1);
      }
      if (record.type === 'close_fence') this.closed = true;
      if (record.type === 'worker' && record.payload.kind === 'session_started') this.closed = false;
    }
    if (corruptTail) {
      truncateSync(this.walPath, Math.min(validBytes, Buffer.byteLength(contents, 'utf8')));
      fsyncFile(this.walPath);
    }
  }

  private assertLease() {
    const lease = this.readLease();
    if (!lease || lease.instanceNonce !== this.instanceNonce || lease.epoch !== this.epoch) {
      throw new RunControlWalError('STALE_WRITER_EPOCH', `run ${this.runId} writer lease was replaced`);
    }
  }

  append(type: WalRecordType, payload: Record<string, unknown>): RunControlRecord {
    return this.withOperationLock(() => {
      this.assertLease();
      // A close fence closes only the current Worker target. The next Node may
      // publish a new Worker; only a new supplement is rejected until that
      // publication opens the next target.
      const body: Omit<RunControlRecord, 'checksum'> = {
        type, recordId: randomUUID(), runId: this.runId, epoch: this.epoch,
        index: this.nextIndex, occurredAt: new Date(this.now()).toISOString(), payload,
      };
      const record = { ...body, checksum: checksumFor(body) };
      const wasPresent = existsSync(this.walPath);
      const fd = openSync(this.walPath, 'a', 0o600);
      try {
        fsyncSync(fd); // make an existing file durable before extending it
        writeFileSync(fd, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
        fsyncSync(fd);
      } finally { closeSync(fd); }
      chmodSync(this.walPath, 0o600);
      if (!wasPresent) fsyncDirectory(dirname(this.walPath));
      this.nextIndex += 1;
      if (type === 'close_fence') this.closed = true;
      return record;
    });
  }

  recordSupplement(input: { submissionAttemptId: string; nodeExecutionId: string; workerSessionId: string; text: string }) {
    if (this.closed) {
      return this.append('delivery', { submissionAttemptId: input.submissionAttemptId, state: 'rejected_after_fence', nodeExecutionId: input.nodeExecutionId, workerSessionId: input.workerSessionId, text: input.text });
    }
    const sequence = this.nextSupplementVersion;
    const record = this.append('supplement', { ...input, supplementId: randomUUID(), sequence, state: 'recorded' });
    this.nextSupplementVersion += 1;
    return record;
  }

  recordDelivery(payload: Record<string, unknown>) { return this.append('delivery', payload); }
  beginWorker(payload: Record<string, unknown>) { this.closed = false; return this.append('worker', { kind: 'session_started', ...payload }); }
  recordWorker(payload: Record<string, unknown>) { return this.append('worker', payload); }
  recordCheckpoint(payload: Record<string, unknown>) { return this.append('checkpoint', payload); }

  closeFence(payload: Record<string, unknown> = {}) {
    if (this.closed) return this.records().find((record) => record.type === 'close_fence');
    return this.append('close_fence', payload);
  }

  markShutdown() {
    try { return this.append('shutdown', { status: 'interrupted_attempt' }); } catch { return undefined; }
  }

  records(): RunControlRecord[] {
    if (!existsSync(this.walPath)) return [];
    const records: RunControlRecord[] = [];
    let expectedIndex = 0;
    for (const line of readFileSync(this.walPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as RunControlRecord;
        const { checksum, ...body } = record;
        if (record.runId !== this.runId || record.index !== expectedIndex || checksum !== checksumFor(body)) break;
        records.push(record);
        expectedIndex += 1;
      } catch { break; }
    }
    return records;
  }

  isClosed() { return this.closed; }
  getSupplementVersion() { return this.nextSupplementVersion - 1; }
  getEpoch() { return this.epoch; }
  getLease(): Readonly<Record<string, unknown>> | undefined { return this.readLease() as Readonly<Record<string, unknown>> | undefined; }

  releaseLease() {
    if (!existsSync(this.leasePath)) return;
    this.withOperationLock(() => {
      this.assertLease();
      unlinkSync(this.leasePath);
      fsyncDirectory(dirname(this.leasePath));
    });
  }

  /** Import exactly one legacy checkpoint. Repeated imports with the same source are idempotent. */
  migrateLegacyCheckpoint(input: { parentSessionId: string; sourceEntryId: string; sourceChecksum: string; checkpoint: unknown }) {
    const key = `${input.parentSessionId}:${input.sourceEntryId}:${this.runId}:${input.sourceChecksum}`;
    const prior = this.records().find((record) => record.type === 'legacy_migrated' && record.payload.importKey === key);
    if (prior) return prior;
    return this.append('legacy_migrated', { importKey: key, parentSessionId: input.parentSessionId, sourceEntryId: input.sourceEntryId, sourceChecksum: input.sourceChecksum, checkpoint: input.checkpoint });
  }
}
