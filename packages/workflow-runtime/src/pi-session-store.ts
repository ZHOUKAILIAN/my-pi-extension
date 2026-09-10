import type { Checkpoint, RunStore } from '@pi/workflow-contracts';

const STAGES: ReadonlySet<string> = new Set(['INTAKE', 'INVESTIGATING', 'DISPOSITION', 'IMPLEMENTING', 'VERIFYING', 'BLOCKED', 'WAITING_FOR_USER', 'ACCEPTED']);

export class PiSessionRunStoreError extends Error {
  readonly code = 'ACTIVE_BRANCH_API_REQUIRED';
  constructor() { super('legacy checkpoint recovery requires SessionManager.getBranch(); refusing to scan sibling session branches'); }
}

/** Legacy compatibility store. New live Runs use RunControlWalStore instead. */
export class PiSessionRunStore implements RunStore {
  private readonly sessionManager: { getEntries(): readonly unknown[]; getBranch?: (fromId?: string) => readonly unknown[]; getLeafId?: () => string | null };
  private readonly append: (type: string, data: Checkpoint) => void;
  constructor(sessionManager: { getEntries(): readonly unknown[]; getBranch?: (fromId?: string) => readonly unknown[]; getLeafId?: () => string | null }, append: (type: string, data: Checkpoint) => void) { this.sessionManager = sessionManager; this.append = append; }
  saveCheckpoint(c: Checkpoint) { this.append('workflow-run', c); }
  private activeEntries(): readonly unknown[] {
    if (typeof this.sessionManager.getBranch === 'function') return this.sessionManager.getBranch(this.sessionManager.getLeafId?.() ?? undefined);
    // Older embedders expose only a single-session entry stream. Keep that
    // narrow compatibility path; real Pi SessionManager always takes the
    // active-branch path above, so sibling entries are never selected there.
    if (typeof this.sessionManager.getEntries === 'function') return this.sessionManager.getEntries();
    throw new PiSessionRunStoreError();
  }
  private parseCheckpoint(entry: unknown): Checkpoint | undefined {
    const e = entry as { customType?: string; data?: unknown };
    if (e.customType !== 'workflow-run' || !e.data || typeof e.data !== 'object') return undefined;
    const c = e.data as Partial<Checkpoint>;
    return typeof c.runId === 'string' && typeof c.id === 'string' && typeof c.at === 'number' && typeof c.stage === 'string' && STAGES.has(c.stage) ? c as Checkpoint : undefined;
  }
  loadLast(runId: string) { return this.activeEntries().map((entry) => this.parseCheckpoint(entry)).filter((checkpoint): checkpoint is Checkpoint => !!checkpoint && checkpoint.runId === runId).at(-1); }
  latestUncompleted(prefixes: readonly string[] = ['fix-', 'bugFix-']) {
    const lastByRun = new Map<string, { checkpoint: Checkpoint; position: number }>();
    this.activeEntries().forEach((entry, position) => { const checkpoint = this.parseCheckpoint(entry); if (checkpoint && prefixes.some((prefix) => checkpoint.runId.startsWith(prefix))) lastByRun.set(checkpoint.runId, { checkpoint, position }); });
    return [...lastByRun.values()].filter((item) => item.checkpoint.stage !== 'ACCEPTED').sort((a, b) => a.position - b.position).at(-1)?.checkpoint;
  }
}
