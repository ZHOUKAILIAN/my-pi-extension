import type { Checkpoint, RunStore, Stage } from '@pi/workflow-contracts';

const STAGES: ReadonlySet<string> = new Set(['INVESTIGATING', 'IMPLEMENTING', 'VERIFYING', 'ACCEPTED', 'BLOCKED', 'WAITING_FOR_USER']);

/** 主 Pi session 的 entry 是持久化真相；内存只负责当前调用的轻量缓存。 */
export class PiSessionRunStore implements RunStore {
  private readonly sessionManager: { getEntries(): readonly unknown[] }; private readonly append: (type: string, data: Checkpoint) => void;
  constructor(sessionManager: { getEntries(): readonly unknown[] }, append: (type: string, data: Checkpoint) => void) { this.sessionManager=sessionManager; this.append=append; }
  saveCheckpoint(c: Checkpoint) { this.append('workflow-run', c); }
  loadLast(runId: string) {
    const entries = this.sessionManager.getEntries();
    const found: Checkpoint[] = [];
    for (const entry of entries) {
      const e = entry as { type?: string; customType?: string; data?: unknown };
      const value = e.customType === 'workflow-run' ? e.data : undefined;
      if (!value || typeof value !== 'object') continue;
      const c = value as Partial<Checkpoint>;
      if (c.runId === runId && typeof c.id === 'string' && typeof c.at === 'number' && typeof c.stage === 'string' && STAGES.has(c.stage)) found.push(c as Checkpoint);
    }
    // Pi session 读取最后一个合法 entry；同一时间戳也按追加顺序，不按 at 排序。
    return found.at(-1);
  }
  latestRunId(prefix = 'bugFix-') {
    let latest: Checkpoint | undefined;
    for (const entry of this.sessionManager.getEntries()) {
      const e = entry as { customType?: string; data?: unknown };
      if (e.customType !== 'workflow-run' || !e.data || typeof e.data !== 'object') continue;
      const c = e.data as Partial<Checkpoint>;
      if (typeof c.runId !== 'string' || !c.runId.startsWith(prefix) || typeof c.id !== 'string' || typeof c.at !== 'number' || typeof c.stage !== 'string' || !STAGES.has(c.stage)) continue;
      // 不按时间排序：Pi entry 的追加顺序才是同 timestamp checkpoint 的确定顺序。
      latest = c as Checkpoint;
    }
    return latest?.runId;
  }
}
