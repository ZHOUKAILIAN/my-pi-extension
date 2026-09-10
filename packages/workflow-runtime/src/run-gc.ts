import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readRunControlRecords, runTombstonePath, safeRunPart, withRunOperationLock } from './run-control-wal.ts';

const defaultRoot = () => process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.cwd(), '.pi', 'agent');
const syncFile = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const syncDir = (path: string) => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };
const alive = (host: unknown, pid: unknown) => {
  if (host !== hostname() || !Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export interface GarbageCollectionOptions { now?: number; retentionMs?: number; orphanDeadlineMs?: number; }

/**
 * Run-level GC. WAL parsing and operation locking are shared with RunControlWal;
 * GC never constructs a WAL (and therefore cannot recreate a deleted run).
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
      if (this.collectOne(rootDir, workflowDir, runDir, entry.name, now, retentionMs, orphanDeadlineMs)) removed += 1;
    }
    return removed;
  }

  private static collectOne(rootDir: string, workflowDir: string, runDir: string, runId: string, now: number, retentionMs: number, orphanDeadlineMs: number): boolean {
    const marker = runTombstonePath(rootDir, runId);
    if (existsSync(marker) || !existsSync(join(runDir, 'control.wal'))) return false;
    try {
      return withRunOperationLock(rootDir, runId, `gc:${process.pid}:${randomUUID()}`, () => now, () => {
        // Re-read all control state after the external lock is held. A live or
        // uncertain lease, an epoch mismatch, or a malformed WAL is never GC'd.
        if (existsSync(marker) || !existsSync(runDir)) return false;
        const leasePath = join(workflowDir, 'locks', `${safeRunPart(runId)}.lease.json`);
        let lease: { host?: unknown; pid?: unknown; epoch?: unknown } | undefined;
        if (existsSync(leasePath)) {
          try { lease = JSON.parse(readFileSync(leasePath, 'utf8')) as typeof lease; } catch { return false; }
          if (!lease || lease.host !== hostname() || alive(lease.host, lease.pid)) return false;
        }
        const records = readRunControlRecords(join(runDir, 'control.wal'), runId);
        if (!records.some((record) => record.type === 'header')) return false;
        const maxEpoch = records.reduce((max, record) => Math.max(max, record.epoch), 0);
        if (lease && (typeof lease.epoch !== 'number' || lease.epoch < maxEpoch)) return false;
        let stage: string | undefined;
        let deadline: number | undefined;
        let explicitTombstone = false;
        for (const record of records) {
          if (record.type === 'checkpoint' && record.payload.checkpoint && typeof record.payload.checkpoint === 'object') {
            const checkpoint = record.payload.checkpoint as { stage?: unknown; gcDeadline?: unknown };
            if (typeof checkpoint.stage === 'string') stage = checkpoint.stage;
            if (typeof checkpoint.gcDeadline === 'number') deadline = checkpoint.gcDeadline;
          }
          if (record.type === 'worker' && record.payload.kind === 'run_tombstone') explicitTombstone = true;
        }
        const terminal = stage === 'ACCEPTED' || explicitTombstone;
        const effectiveDeadline = deadline ?? statSync(runDir).mtimeMs + orphanDeadlineMs;
        if (!terminal || now < effectiveDeadline + retentionMs) return false;
        if (lease) { try { unlinkSync(leasePath); syncDir(workflowDir + '/locks'); } catch { return false; } }

        // Persist a deterministic protected-root tombstone before renaming. An
        // open racing after this point fails closed and cannot ensureLayout().
        writeFileSync(marker, JSON.stringify({ runId, epoch: maxEpoch, tombstonedAt: now }) + '\n', { encoding: 'utf8', mode: 0o600 });
        syncFile(marker); syncDir(workflowDir);
        const trash = join(workflowDir, `.trash-${safeRunPart(runId)}-${randomUUID()}`);
        renameSync(runDir, trash);
        syncDir(workflowDir);
        // Deletion is deliberately asynchronous; the tombstone remains durable
        // while the old directory is being removed.
        setImmediate(() => {
          try { rmSync(trash, { recursive: true, force: false }); syncDir(workflowDir); } catch { /* retry/inspection can clean it later */ }
        });
        return true;
      });
    } catch { return false; }
  }
}
