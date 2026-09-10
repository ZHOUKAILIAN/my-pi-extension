import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

interface DurableRecord { type: string; runId: string; index: number; payload: Record<string, unknown>; checksum: string; }
const canonical = (value: unknown) => JSON.stringify(value);
const checksumFor = (record: Omit<DurableRecord, 'checksum'>) => createHash('sha256').update(canonical(record)).digest('hex');
const defaultRoot = () => process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.cwd(), '.pi', 'agent');
const alive = (host: unknown, pid: unknown) => {
  if (host !== hostname() || !Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
const syncDir = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

export interface GarbageCollectionOptions { now?: number; retentionMs?: number; orphanDeadlineMs?: number; }

/**
 * Run-level GC. It only removes a run after reading a complete, checksummed
 * WAL, proving terminal state/deadline, and acquiring the same operation lock
 * used by writers. Removal is tombstoned with rename + directory fsync.
 */
export class RunGarbageCollector {
  static collect(rootDir = defaultRoot(), options: GarbageCollectionOptions = {}): number {
    const now = options.now ?? Date.now();
    const retentionMs = options.retentionMs ?? 30 * 86400000;
    const orphanDeadlineMs = options.orphanDeadlineMs ?? 7 * 86400000;
    const workflowDir = join(rootDir, 'workflow-runs');
    if (!existsSync(workflowDir)) return 0;
    let removed = 0;
    for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'locks' || entry.name.startsWith('.trash-')) continue;
      const runDir = join(workflowDir, entry.name);
      if (this.collectOne(workflowDir, runDir, entry.name, now, retentionMs, orphanDeadlineMs)) removed += 1;
    }
    return removed;
  }

  private static collectOne(workflowDir: string, runDir: string, runId: string, now: number, retentionMs: number, orphanDeadlineMs: number): boolean {
    const walPath = join(runDir, 'control.wal');
    const leasePath = join(workflowDir, 'locks', `${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}.lease.json`);
    if (existsSync(leasePath)) {
      try {
        const lease = JSON.parse(readFileSync(leasePath, 'utf8')) as { host?: unknown; pid?: unknown };
        if (alive(lease.host, lease.pid) || lease.host !== hostname()) return false;
        // A same-host dead lease can be reclaimed only after the run lock is held.
      } catch { return false; }
    }
    const lockPath = join(workflowDir, 'locks', `${runId.replace(/[^a-zA-Z0-9._-]/g, '_')}.lock`);
    try { mkdirSync(lockPath, { mode: 0o700 }); } catch { return false; }
    try {
      const ownerPath = join(lockPath, 'owner.json');
      if (existsSync(ownerPath)) {
        try {
          const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { host?: unknown; pid?: unknown };
          if (owner.host !== hostname() || alive(owner.host, owner.pid)) return false;
        } catch { return false; }
      }
      if (existsSync(leasePath)) {
        try { unlinkSync(leasePath); syncDir(dirname(leasePath)); } catch { return false; }
      }
      const state = this.readRunState(walPath, runId);
      if (!state) return false;
      const terminal = state.stage === 'ACCEPTED' || state.tombstone === true;
      const deadline = state.deadline ?? statSync(runDir).mtimeMs + orphanDeadlineMs;
      if (!terminal || now < deadline + retentionMs) return false;
      const tombstone = join(workflowDir, `.trash-${runId}-${now}`);
      renameSync(runDir, tombstone);
      syncDir(workflowDir);
      rmSync(tombstone, { recursive: true, force: false });
      syncDir(workflowDir);
      return true;
    } catch { return false; }
    finally { try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* preserve a lock for a later safe retry */ } }
  }

  private static readRunState(path: string, runId: string): { stage?: string; deadline?: number; tombstone?: boolean } | undefined {
    if (!existsSync(path)) return undefined;
    let stage: string | undefined;
    let deadline: number | undefined;
    let tombstone = false;
    const lines = readFileSync(path, 'utf8').split('\n');
    let expected = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      if (index === lines.length - 1) return undefined; // no newline: not durable
      let record: DurableRecord;
      try { record = JSON.parse(line) as DurableRecord; } catch { return undefined; }
      const { checksum, ...body } = record;
      if (record.runId !== runId || record.index !== expected || checksum !== checksumFor(body)) return undefined;
      expected += 1;
      if (record.type === 'checkpoint' && record.payload.checkpoint && typeof record.payload.checkpoint === 'object') {
        const checkpoint = record.payload.checkpoint as { stage?: unknown; gcDeadline?: unknown };
        if (typeof checkpoint.stage === 'string') stage = checkpoint.stage;
        if (typeof checkpoint.gcDeadline === 'number') deadline = checkpoint.gcDeadline;
      }
      if (record.type === 'worker' && record.payload.kind === 'run_tombstone') tombstone = true;
    }
    return { stage, deadline, tombstone };
  }
}
