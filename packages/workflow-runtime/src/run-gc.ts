import { closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const gcObservationPath = (runDir: string) => join(runDir, '.gc-observation.json');
const millis = (iso: unknown, fallback: number) => {
  const value = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

export interface GarbageCollectionOptions { now?: number; retentionMs?: number; orphanDeadlineMs?: number; }

/**
 * Run-level GC. WAL parsing, the per-run operation lock, and lease semantics
 * are shared with RunControlWal; GC never constructs a WAL (and therefore
 * cannot recreate a deleted run).
 */
export class RunGarbageCollector {
  static collect(rootDir = defaultRoot(), options: GarbageCollectionOptions = {}): number {
    const now = options.now ?? Date.now();
    const retentionMs = options.retentionMs ?? 30 * 86400000;
    const orphanDeadlineMs = options.orphanDeadlineMs ?? 7 * 86400000;
    const workflowDir = join(rootDir, 'workflow-runs');
    if (!existsSync(workflowDir)) return 0;
    // A failed async delete leaves the root tombstone and a .trash directory;
    // retry those directories on every later scan instead of abandoning them.
    this.retryTrash(workflowDir);
    let removed = 0;
    for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'locks' || entry.name.startsWith('.trash-')) continue;
      const runDir = join(workflowDir, entry.name);
      if (this.collectOne(rootDir, workflowDir, runDir, entry.name, now, retentionMs, orphanDeadlineMs)) removed += 1;
    }
    return removed;
  }

  private static retryTrash(workflowDir: string) {
    for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.trash-')) continue;
      try { rmSync(join(workflowDir, entry.name), { recursive: true, force: false }); syncDir(workflowDir); } catch { /* next scan retries */ }
    }
  }

  private static collectOne(rootDir: string, workflowDir: string, runDir: string, runId: string, now: number, retentionMs: number, orphanDeadlineMs: number): boolean {
    const marker = runTombstonePath(rootDir, runId);
    if (existsSync(marker) || !existsSync(join(runDir, 'control.wal'))) return false;
    try {
      return withRunOperationLock(rootDir, runId, `gc:${process.pid}:${randomUUID()}`, () => now, () => {
        // Every candidate is re-read after taking the same lock used by WAL
        // writers. A live or uncertain lease, malformed WAL, or changed stage
        // therefore fails closed.
        if (existsSync(marker) || !existsSync(runDir)) return false;
        const leasePath = join(workflowDir, 'locks', `${safeRunPart(runId)}.lease.json`);
        let lease: { host?: unknown; pid?: unknown; epoch?: unknown } | undefined;
        if (existsSync(leasePath)) {
          try { lease = JSON.parse(readFileSync(leasePath, 'utf8')) as typeof lease; } catch { return false; }
          if (!lease || lease.host !== hostname() || alive(lease.host, lease.pid)) return false;
        }
        const records = readRunControlRecords(join(runDir, 'control.wal'), runId);
        const header = records.find((record) => record.type === 'header')?.payload ?? {};
        if (!records.some((record) => record.type === 'header')) return false;
        const maxEpoch = records.reduce((max, record) => Math.max(max, record.epoch), 0);
        if (lease && (typeof lease.epoch !== 'number' || lease.epoch < maxEpoch)) return false;

        const lastDurableEvent = records.reduce((latest, record) => Math.max(latest, millis(record.occurredAt, latest)), 0);
        let terminal = false;
        let terminalAt: number | undefined;
        for (const record of records) {
          if (record.type === 'checkpoint' && record.payload.checkpoint && typeof record.payload.checkpoint === 'object') {
            const checkpoint = record.payload.checkpoint as { stage?: unknown };
            if (checkpoint.stage === 'ACCEPTED') { terminal = true; terminalAt = millis(record.occurredAt, terminalAt ?? lastDurableEvent); }
          }
          if (record.type === 'worker' && record.payload.kind === 'run_tombstone') {
            terminal = true; terminalAt = millis(record.occurredAt, terminalAt ?? lastDurableEvent);
          }
        }
        const settledAt = terminalAt ?? lastDurableEvent;
        let deadline = (terminal ? settledAt : lastDurableEvent) + retentionMs;

        // Only a settled run with an original parent file in its header can be
        // classified as an orphan. Record first observation durably and use the
        // earlier of normal settled retention and the seven-day orphan window.
        if (terminal && typeof header.parentSessionFile === 'string' && header.parentSessionFile.length > 0 && !existsSync(header.parentSessionFile)) {
          let observedAt: number | undefined;
          const observation = gcObservationPath(runDir);
          if (existsSync(observation)) {
            try {
              const value = JSON.parse(readFileSync(observation, 'utf8')) as { parentMissingObservedAt?: unknown };
              if (typeof value.parentMissingObservedAt === 'number' && Number.isFinite(value.parentMissingObservedAt)) observedAt = value.parentMissingObservedAt;
            } catch { return false; }
          }
          if (observedAt === undefined) {
            observedAt = now;
            try {
              writeFileSync(observation, JSON.stringify({ runId, parentMissingObservedAt: observedAt }) + '\n', { encoding: 'utf8', mode: 0o600 });
              syncFile(observation); syncDir(runDir);
            } catch { return false; }
          }
          deadline = Math.min(deadline, observedAt + orphanDeadlineMs);
        }
        // Unfinished runs expire from their last durable event, not from an
        // orphan grace period. They are only eligible when no live lease exists.
        if (now < deadline) return false;
        if (lease) { try { unlinkSync(leasePath); syncDir(workflowDir + '/locks'); } catch { return false; } }

        writeFileSync(marker, JSON.stringify({ runId, epoch: maxEpoch, tombstonedAt: now }) + '\n', { encoding: 'utf8', mode: 0o600 });
        syncFile(marker); syncDir(workflowDir);
        const trash = join(workflowDir, `.trash-${safeRunPart(runId)}-${randomUUID()}`);
        renameSync(runDir, trash);
        syncDir(workflowDir);
        setImmediate(() => {
          try { rmSync(trash, { recursive: true, force: false }); syncDir(workflowDir); } catch { /* next scan retries */ }
        });
        return true;
      });
    } catch { return false; }
  }
}
