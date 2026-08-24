import type { Checkpoint, RunStore, Stage } from '@pi/workflow-contracts';

const STAGES: ReadonlySet<string> = new Set(['INVESTIGATING', 'IMPLEMENTING', 'VERIFYING', 'ACCEPTED', 'BLOCKED', 'WAITING_FOR_USER']);

/** 主 Pi session 的 entry 是持久化真相；内存只负责当前调用的轻量缓存。 */
export class PiSessionRunStore implements RunStore {
  private readonly sessionManager: { getEntries(): readonly unknown[] }; private readonly append: (type: string, data: Checkpoint) => void;
  constructor(sessionManager: { getEntries(): readonly unknown[] }, append: (type: string, data: Checkpoint) => void) { this.sessionManager=sessionManager; this.append=append; }
  saveCheckpoint(c: Checkpoint) { this.append('workflow-run', c); }
  private parseCheckpoint(entry: unknown): Checkpoint | undefined {
    const e = entry as { customType?: string; data?: unknown };
    if (e.customType !== 'workflow-run' || !e.data || typeof e.data !== 'object') return undefined;
    const c = e.data as Partial<Checkpoint>;
    return typeof c.runId === 'string' && typeof c.id === 'string' && typeof c.at === 'number' && typeof c.stage === 'string' && STAGES.has(c.stage) ? c as Checkpoint : undefined;
  }
  loadLast(runId: string) {
    return this.sessionManager.getEntries().map(e => this.parseCheckpoint(e)).filter((c): c is Checkpoint => !!c && c.runId === runId).at(-1);
  }
  latestUncompleted(prefixes: readonly string[] = ['fix-', 'bugFix-']) {
    const lastByRun = new Map<string, { checkpoint: Checkpoint; position: number }>();
    this.sessionManager.getEntries().forEach((entry, position) => {
      const c = this.parseCheckpoint(entry);
      if (c && prefixes.some((prefix) => c.runId.startsWith(prefix))) lastByRun.set(c.runId, { checkpoint: c, position });
    });
    return [...lastByRun.values()].filter(x => x.checkpoint.stage !== 'ACCEPTED').sort((a, b) => a.position - b.position).at(-1)?.checkpoint;
  }

}
