// Test helpers: sqlite-backed in-memory SqlDatabase (node:sqlite, zero deps), fixed clock and
// synthetic Fix funnel event builders. Synthetic data only — same guard as the src slice.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlRow, SqlValue, Statement } from '../src/store.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export const FIXED_NOW = new Date('2026-08-01T12:00:00.000Z');
export const FIXED_DEFINITION_VERSION = 'fix-funnel-v1';
export const FIXED_TOKEN = 'synthetic-test-token';

export function fixedNow(): Date {
  return new Date(FIXED_NOW);
}

// ---------------------------------------------------------------------------
// Config + AcceptedEvent factories
// ---------------------------------------------------------------------------

import { canonicalJson } from '../src/canonical.ts';
import { businessKey, canonicalHash, type AcceptedEvent, type FunnelEventType } from '../src/events.ts';
import type { RuntimeConfig } from '../src/config.ts';

export function testConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  return {
    syntheticOnly: true,
    ingestTokens: new Set([FIXED_TOKEN]),
    lateEventWindowMs: 24 * 60 * 60 * 1000,
    futureSkewWindowMs: 5 * 60 * 1000,
    lowSampleK: 5,
    ...overrides,
  };
}

// Storage-shaped accepted event (funnel-valid content, deterministic ids) for store/projection
// tests that bypass the HTTP path. Keys are assigned so duplicate/conflict semantics match what
// the validator would produce for the same wire event.
export async function makeAcceptedEvent(
  seed: string,
  type: FunnelEventType,
  extra?: Partial<AcceptedEvent>,
): Promise<AcceptedEvent> {
  const base: AcceptedEvent = {
    schemaVersion: 1,
    metricDefinitionVersion: FIXED_DEFINITION_VERSION,
    eventId: `evt-${seed}`,
    eventBusinessKey: '',
    eventCanonicalHash: '',
    eventType: type,
    occurredAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000).toISOString(),
    receivedAt: FIXED_NOW.toISOString(),
    runId: `run-${seed}`,
    workflowId: 'fix',
    workflowDefinitionVersion: 'fix-workflow-v1',
    policyDigest: 'policy-v1',
    factId: `fact-${seed}`,
    fixClassification: 'unclassified',
    bugCategory: 'application',
    riskLevel: 'low',
    stage: 'INTAKE',
    payloadJson: canonicalJson({}),
    ...extra,
  };
  base.eventBusinessKey = await businessKey(base);
  base.eventCanonicalHash = await canonicalHash(base);
  return base;
}

// ---------------------------------------------------------------------------
// In-memory SqlDatabase backed by node:sqlite
// ---------------------------------------------------------------------------

export function migratedInMemoryDb(): { sql: SqlDatabase; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const files = ['0001_initial.sql', '0002_publication_history.sql'];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // strip full-line comments first (the comment body may contain ';'), then one statement per
    // ';' — the migration authoring rule forbids embedded semicolons in statements
    const commentsStripped = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const statement of commentsStripped.split(';')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) raw.exec(trimmed);
    }
  }
  return { sql: sqliteAdapter(raw), raw };
}

function sqliteAdapter(raw: DatabaseSync): SqlDatabase {
  return {
    prepare(sql: string): Statement {
      const stmt = raw.prepare(sql);
      return {
        async run(...params: SqlValue[]) {
          const result = stmt.run(...(params as never[]));
          return { changes: Number(result.changes ?? 0) };
        },
        async first<T extends SqlRow>(...params: SqlValue[]) {
          return stmt.get(...(params as never[])) as T | undefined;
        },
        async all<T extends SqlRow>(...params: SqlValue[]) {
          return stmt.all(...(params as never[])) as T[];
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic Fix funnel run builder (all occurrences inside the August 2026 window,
// well within the 24h late window and the 5min future skew of FIXED_NOW).
// ---------------------------------------------------------------------------

export type SyntheticEventType =
  | 'run_started'
  | 'investigation_review_passed'
  | 'resolution_completed'
  | 'verification_passed'
  | 'run_accepted';

export interface SyntheticRunOptions {
  seed: string;
  /** how many of the 5 funnel nodes the run reaches (1..5); 5 = fully accepted */
  reached?: 1 | 2 | 3 | 4 | 5;
  resolutionType?: string;
  /** extra envelope overrides for ALL events of the run */
  overrides?: Record<string, unknown>;
}

const STEP_MINUTES: SyntheticEventType[] = [
  'run_started',
  'investigation_review_passed',
  'resolution_completed',
  'verification_passed',
  'run_accepted',
];

export function syntheticRunEvents(opts: SyntheticRunOptions): Record<string, unknown>[] {
  const reached = opts.reached ?? 5;
  const start = new Date(FIXED_NOW.getTime() - 60 * 60 * 1000); // run started 1h ago

  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < reached; i += 1) {
    const type = STEP_MINUTES[i] as SyntheticEventType;
    const occurredAt = new Date(start.getTime() + i * 10 * 60 * 1000).toISOString();
    const payload: Record<string, unknown> =
      type === 'resolution_completed' || type === 'verification_passed'
        ? { resolutionEvidenceRef: `rev-${opts.seed}` }
        : {};
    const stageByType: Record<SyntheticEventType, string> = {
      run_started: 'INTAKE', investigation_review_passed: 'INVESTIGATING', resolution_completed: 'IMPLEMENTING',
      verification_passed: 'VERIFYING', run_accepted: 'ACCEPTED',
    };
    const base: Record<string, unknown> = {
      schemaVersion: 1,
      metricDefinitionVersion: FIXED_DEFINITION_VERSION,
      eventId: `evt-${opts.seed}-${i + 1}`,
      factId: `fact-${opts.seed}`,
      eventType: type,
      occurredAt,
      runId: `run-${opts.seed}`,
      workflowId: 'fix',
      workflowDefinitionVersion: 'fix-workflow-v1',
      policyDigest: 'policy-v1',
      bugCategory: 'application',
      riskLevel: 'low',
      fixClassification: 'unclassified',
      stage: stageByType[type],
      payload,
      ...opts.overrides,
    };
    if (type === 'investigation_review_passed' || type === 'verification_passed') {
      base.outcome = 'passed';
    }
    if (type === 'investigation_review_passed') {
      base.reviewCycleId = `rc-${opts.seed}`;
    }
    if (type === 'resolution_completed') {
      base.resolutionType = opts.resolutionType ?? 'code_change';
      base.dispositionOutcome = 'actionable';
      base.resolutionCycleId = `rc-${opts.seed}`;
    }
    if (type === 'verification_passed') {
      base.resolutionCycleId = `rc-${opts.seed}`;
    }
    if (type === 'run_accepted') {
      base.terminalOutcome = 'accepted';
    }
    if (type === 'investigation_review_passed' || type === 'resolution_completed' || type === 'verification_passed' || type === 'run_accepted') {
      base.controlRef = `ctl-${opts.seed}`;
    }
    events.push(base);
  }
  return events;
}