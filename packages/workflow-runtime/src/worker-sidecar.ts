import { closeSync, chmodSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunGarbageCollector } from './run-gc.ts';

/** Display-only projection. It is never supplied to a Worker model context. */
export interface WorkerProjection {
  ref: string;
  runId: string;
  nodeId: string;
  eventKind: 'visible_text' | 'tool_start';
  text?: string;
  toolName?: string;
  args?: unknown;
  occurredAt: string;
}

/** Durable, append-only Worker display projection. */
export class WorkerSidecar {
  readonly path: string;
  readonly runDir: string;
  constructor(runDir: string) {
    this.runDir = runDir;
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);
    this.path = join(runDir, 'ui-sidecar.jsonl');
  }
  append(projection: WorkerProjection) {
    const fd = openSync(this.path, 'a', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(projection)}\n`, { encoding: 'utf8' });
      fsyncSync(fd);
    } finally { closeSync(fd); }
    chmodSync(this.path, 0o600);
  }
  get(ref: string): WorkerProjection | undefined {
    if (!existsSync(this.path)) return undefined;
    for (const line of readFileSync(this.path, 'utf8').split('\n').reverse()) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as WorkerProjection;
        if (value.ref === ref) return value;
      } catch {
        // A partial sidecar tail is not a control record. Do not expose it.
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * GC is deliberately explicit. Constructing a sidecar must never unlink a
   * run that may still be recoverable.
   */
  static gc(rootDir?: string, now = Date.now(), retentionDays = 30, orphanDays = 7) {
    return RunGarbageCollector.collect(rootDir, { now, retentionMs: retentionDays * 86400000, orphanDeadlineMs: orphanDays * 86400000 });
  }
}

export { RunGarbageCollector } from './run-gc.ts';
