// Event / quarantine / snapshot storage for the Fix Metrics PoC slice.
//
// Two backends implement the narrow SqlDatabase interface:
//   - production: the Cloudflare D1 binding, adapted in src/d1-adapter.ts
//   - local/tests: a dependency-free in-memory SQLite adapter (node:sqlite) in test/helpers.ts
//
// Idempotency and conflict detection (approved design §6.7):
//   - event_id is the transport record primary key
//   - event_business_key is the business-fact unique key
//   - same id or same business key with the SAME canonical hash  -> duplicate (no-op, keep first)
//   - same id or same business key with a DIFFERENT canonical hash -> permanent_error, never overwrite
//
// The insert path does not depend on vendor-specific UPSERT/transaction semantics: it attempts the
// INSERT and, on a constraint violation, reads the surviving row to decide duplicate vs conflict.
// Under concurrency the unique constraints make exactly one writer win and every loser land in the
// same duplicate/conflict branch.

import type { AcceptedEvent } from './events.ts';
import { validateSnapshotRowShape, verifySnapshotLineage } from './snapshot-contract.ts';
import { verifyStoredSnapshot } from './projection.ts';

export type SqlValue = string | number | null | bigint | boolean | Uint8Array;

export interface SqlRow {
  [key: string]: SqlValue;
}

export interface Statement {
  run(...params: SqlValue[]): Promise<{ changes: number }>;
  first<T extends SqlRow>(...params: SqlValue[]): Promise<T | undefined>;
  all<T extends SqlRow>(...params: SqlValue[]): Promise<T[]>;
}

/** One statement of an atomic multi-statement write. */
export interface BatchStatement {
  sql: string;
  params: SqlValue[];
}

export interface SqlDatabase {
  prepare(sql: string): Statement;
  // Execute every statement as ONE atomic unit (D1 batch semantics: sequential execution inside
  // an implicit transaction; a failing statement rolls the whole unit back). Returns the
  // `changes` count of each statement in order. The publication pointer + published-revision
  // history writes depend on this guarantee (review P1.1): a partial failure must never leave a
  // pointer without its history row (or a history row without its pointer).
  transaction(statements: BatchStatement[]): Promise<number[]>;
}

export type InsertOutcome =
  | { status: 'accepted' }
  | { status: 'duplicate'; existingEventId: string }
  | { status: 'conflict'; existingEventId: string };

export interface AcceptedEventRow {
  eventId: string;
  eventBusinessKey: string;
  eventCanonicalHash: string;
  eventType: string;
  occurredAt: string;
  receivedAt: string;
  runId: string;
  factId: string;
  fixClassification: string;
  bugCategory: string;
  riskLevel: string;
  stage: string;
  workflowId: string;
  workflowDefinitionVersion: string;
  policyDigest: string;
  metricDefinitionVersion: string;
  stageFrom?: string;
  stageTo?: string;
  terminalOutcome?: string;
  nodeId?: string;
  nodeExecutionId?: string;
  artifactId?: string;
  candidateRevision?: string;
  reviewCycleId?: string;
  resolutionCycleId?: string;
  dispositionOutcome?: string;
  workerId?: string;
  role?: string;
  controlRef?: string;
  supersedesEventId?: string;
  resolutionType?: string;
  outcome?: string;
  decision?: string;
  reasonCode?: string;
  sourceVersion?: string;
  payloadJson: string;
}

export interface SnapshotRow {
  snapshotId: string;
  parentSnapshotId?: string;
  rebuildTaskId?: string;
  definitionVersion: string;
  windowStart: string;
  windowEnd: string;
  snapshotAt: string;
  maturityAt: string;
  status: string;
  responseJson: string;
  createdAt: string;
  revisionHash: string;
}

export interface PublicationRow {
  windowStart: string;
  windowEnd: string;
  snapshotAt: string;
  definitionVersion: string;
  publishedSnapshotId: string;
  publicationGeneration: number;
  publishedAt: string;
  updatedAt: string;
}

const EVENT_COLUMNS = [
  'event_id',
  'event_business_key',
  'event_canonical_hash',
  'schema_version',
  'event_type',
  'occurred_at',
  'received_at',
  'run_id',
  'workflow_id',
  'workflow_definition_version',
  'policy_digest',
  'metric_definition_version',
  'fact_id',
  'fix_classification',
  'bug_category',
  'risk_level',
  'source_version',
  'stage',
  'stage_from',
  'stage_to',
  'wait_reason',
  'terminal_outcome',
  'node_id',
  'node_execution_id',
  'artifact_id',
  'candidate_revision',
  'review_cycle_id',
  'resolution_cycle_id',
  'disposition_outcome',
  'worker_id',
  'source_key_id',
  'source_signature',
  'role',
  'control_ref',
  'supersedes_event_id',
  'resolution_type',
  'outcome',
  'decision',
  'reason_code',
  'payload_json',
] as const;

export class MetricStore {
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  // -------------------------------------------------------------------------
  // Ingest writes
  // -------------------------------------------------------------------------

  async insertAccepted(event: AcceptedEvent, receivedAt: string): Promise<InsertOutcome> {
    const params: SqlValue[] = [
      event.eventId,
      event.eventBusinessKey,
      event.eventCanonicalHash,
      1,
      event.eventType,
      event.occurredAt,
      receivedAt,
      event.runId,
      event.workflowId,
      event.workflowDefinitionVersion,
      event.policyDigest,
      event.metricDefinitionVersion,
      event.factId,
      event.fixClassification,
      event.bugCategory,
      event.riskLevel,
      nullIfUndefined(event.sourceVersion),
      event.stage,
      nullIfUndefined(event.stageFrom),
      nullIfUndefined(event.stageTo),
      null,
      nullIfUndefined(event.terminalOutcome),
      nullIfUndefined(event.nodeId),
      nullIfUndefined(event.nodeExecutionId),
      nullIfUndefined(event.artifactId),
      nullIfUndefined(event.candidateRevision),
      nullIfUndefined(event.reviewCycleId),
      nullIfUndefined(event.resolutionCycleId),
      nullIfUndefined(event.dispositionOutcome),
      nullIfUndefined(event.workerId),
      null,
      null,
      nullIfUndefined(event.role),
      nullIfUndefined(event.controlRef),
      nullIfUndefined(event.supersedesEventId),
      nullIfUndefined(event.resolutionType),
      nullIfUndefined(event.outcome),
      nullIfUndefined(event.decision),
      nullIfUndefined(event.reasonCode),
      event.payloadJson,
    ];
    try {
      await this.db.prepare(insertEventSql(EVENT_COLUMNS)).run(...params);
      return { status: 'accepted' };
    } catch (error) {
      const byId = await this.db
        .prepare('SELECT event_id, event_canonical_hash FROM fix_metric_events WHERE event_id = ?')
        .first<{ event_id: string; event_canonical_hash: string }>(event.eventId);
      if (byId) {
        return classifyConflict(byId.event_canonical_hash, event.eventCanonicalHash, byId.event_id);
      }
      const byKey = await this.db
        .prepare('SELECT event_id, event_canonical_hash FROM fix_metric_events WHERE event_business_key = ?')
        .first<{ event_id: string; event_canonical_hash: string }>(event.eventBusinessKey);
      if (byKey) {
        return classifyConflict(byKey.event_canonical_hash, event.eventCanonicalHash, byKey.event_id);
      }
      // No surviving row: the failure was not a duplicate/conflict, surface it (caller -> retryable).
      throw error;
    }
  }

  async insertQuarantine(record: QuarantineRecordInput): Promise<QuarantineInsertOutcome> {
    const insert = `INSERT OR IGNORE INTO fix_metric_quarantine (
      event_id, fact_id, run_id, event_business_key, event_canonical_hash, reason_code, received_at, event_json, status, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?)`;
    const result = await this.db
      .prepare(insert)
      .run(
        record.eventId,
        record.factId,
        nullIfUndefined(record.runId),
        record.eventBusinessKey,
        record.eventCanonicalHash,
        record.reasonCode,
        record.receivedAt,
        record.eventJson,
        record.occurredAt || record.receivedAt,
      );
    if (result.changes > 0) return { status: 'inserted' };

    // INSERT OR IGNORE swallowed the write: the row already exists. It is only a legitimate
    // duplicate if the surviving fact is byte-identical to the incoming record; otherwise the
    // incoming content was NOT persisted and must not be ACKed as quarantined.
    const existing =
      (await this.db
        .prepare(
          `SELECT event_id AS eventId, event_business_key AS eventBusinessKey,
                  event_canonical_hash AS eventCanonicalHash, reason_code AS reasonCode,
                  event_json AS eventJson
           FROM fix_metric_quarantine WHERE event_id = ?`,
        )
        .first<Record<string, SqlValue>>(record.eventId)) ??
      (await this.db
        .prepare(
          `SELECT event_id AS eventId, event_business_key AS eventBusinessKey,
                  event_canonical_hash AS eventCanonicalHash, reason_code AS reasonCode,
                  event_json AS eventJson
           FROM fix_metric_quarantine WHERE event_business_key = ?`,
        )
        .first<Record<string, SqlValue>>(record.eventBusinessKey));
    if (!existing) return { status: 'conflict' }; // no surviving row: unusual constraint failure, do not ACK

    if (
      existing.eventId === record.eventId &&
      existing.eventBusinessKey === record.eventBusinessKey &&
      existing.eventCanonicalHash === record.eventCanonicalHash &&
      existing.reasonCode === record.reasonCode &&
      existing.eventJson === record.eventJson
    ) {
      return { status: 'duplicate' };
    }
    return { status: 'conflict' };
  }

  async quarantinedInWindow(windowStart: string, windowEnd: string): Promise<QuarantineWindowRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT event_id AS eventId, run_id AS runId, reason_code AS reasonCode, occurred_at AS occurredAt,
                received_at AS receivedAt
         FROM fix_metric_quarantine WHERE occurred_at >= ? AND occurred_at < ?
         ORDER BY occurred_at, event_id`,
      )
      .all<Record<string, SqlValue>>(windowStart, windowEnd);
    return rows.map((row) => ({
      eventId: str(row, 'eventId'),
      runId: strOpt(row, 'runId'),
      reasonCode: str(row, 'reasonCode'),
      occurredAt: str(row, 'occurredAt'),
      receivedAt: str(row, 'receivedAt'),
    }));
  }

  // -------------------------------------------------------------------------
  // Projection reads
  // -------------------------------------------------------------------------

  async allAcceptedEvents(): Promise<AcceptedEventRow[]> {
    const rows = await this.db
      .prepare('SELECT * FROM fix_metric_events ORDER BY occurred_at, received_at, event_id')
      .all<Record<string, SqlValue>>();
    return rows.map(rowToAcceptedEvent);
  }

  async quarantinedCountInWindow(windowStart: string, windowEnd: string): Promise<number> {
    return (await this.quarantinedInWindow(windowStart, windowEnd)).length;
  }

  // Resolution-cycle lookup for the ingest-side verification binding contract: the accepted
  // resolution_completed of one run + resolution cycle, latest occurredAt first (event_id as the
  // deterministic read tiebreak). Used to bind verification_passed evidence to the actual
  // resolution of the same cycle (see ingest.verificationBindingIsCoherent).
  async latestResolutionCompleted(runId: string, resolutionCycleId: string): Promise<AcceptedEventRow | undefined> {
    const row = await this.db
      .prepare(
        `SELECT * FROM fix_metric_events
         WHERE event_type = 'resolution_completed' AND run_id = ? AND resolution_cycle_id = ?
         ORDER BY occurred_at DESC, event_id DESC LIMIT 1`,
      )
      .first<Record<string, SqlValue>>(runId, resolutionCycleId);
    return row ? rowToAcceptedEvent(row) : undefined;
  }

  // Acceptance-evidence gate for run_accepted (review P1.5): a run_accepted fact is only coherent
  // when the Acceptance facts this slice models — an accepted verification_passed for the SAME
  // run — are already stored (the human decision record is a later slice; verification_passed is
  // the modeled evidence here). Fail closed: a bare valid-shape run_accepted without prior
  // Acceptance evidence for its run is rejected at ingest, never silently accepted.
  async hasAcceptedVerificationPassed(runId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS hit FROM fix_metric_events
         WHERE event_type = 'verification_passed' AND run_id = ? LIMIT 1`,
      )
      .first(runId);
    return Boolean(row);
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  // `now` is the server-controlled clock (the worker's injected `now`), passed by the caller so
  // the store never guesses one. It is VALIDATED first (P1.7): a non-ISO/invalid/NaN value fails
  // closed with invalid_server_now instead of silently passing the future-as-of comparison (a
  // NaN comparison is always false). Fail closed: a snapshot whose as-of point lies in the
  // future relative to that validated clock is rejected at the store boundary — direct future
  // insertion and future publication are both impossible for canonical writes.
  async insertSnapshot(row: SnapshotRow, now: string): Promise<boolean> {
    const nowMs = serverNowMs(now);
    // Canonical revision contract, enforced before any write:
    //   1. shape: stored payload validates against the row's own metadata (calculable, bound ids);
    //      this also rejects non-ISO row timestamps before any time comparison uses them
    //   2. time: the as-of point has been reached on the server-controlled clock (no future data)
    //   3. content: the revision recomputed from canonical inputs (accepted events + quarantines
    //      as of snapshotAt) reproduces the row byte-for-byte — snapshotId is s_<revisionHash> and
    //      revisionHash is derived from content, never an arbitrary forged id
    //   4. lineage: a declared parent exists (and is itself fully verified), matches
    //      window/definition, is an earlier fixed point and rebuildTaskId coherence holds
    if (!validateSnapshotRowShape(row)) throw new Error('invalid_snapshot_payload');
    const snapshotAtMs = Date.parse(row.snapshotAt);
    if (!Number.isFinite(snapshotAtMs) || snapshotAtMs > nowMs) throw new Error('future_snapshot_at');
    if (!(await verifyStoredSnapshot(this, row)) || !(await verifySnapshotLineage(this, row))) {
      throw new Error('snapshot_revision_mismatch');
    }
    const insert = `INSERT OR IGNORE INTO fix_metric_snapshots (
      snapshot_id, parent_snapshot_id, rebuild_task_id, definition_version, window_start, window_end,
      snapshot_at, maturity_at, status, response_json, created_at, revision_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const result = await this.db
      .prepare(insert)
      .run(
        row.snapshotId,
        nullIfUndefined(row.parentSnapshotId),
        nullIfUndefined(row.rebuildTaskId),
        row.definitionVersion,
        row.windowStart,
        row.windowEnd,
        row.snapshotAt,
        row.maturityAt,
        row.status,
        row.responseJson,
        row.createdAt,
        row.revisionHash,
      );
    return result.changes > 0;
  }

  async getSnapshot(snapshotId: string): Promise<SnapshotRow | undefined> {
    const row = await this.db
      .prepare(
        `SELECT snapshot_id AS snapshotId, parent_snapshot_id AS parentSnapshotId, rebuild_task_id AS rebuildTaskId,
                definition_version AS definitionVersion, window_start AS windowStart, window_end AS windowEnd,
                snapshot_at AS snapshotAt, maturity_at AS maturityAt, status, response_json AS responseJson,
                created_at AS createdAt, revision_hash AS revisionHash
         FROM fix_metric_snapshots WHERE snapshot_id = ?`,
      )
      .first<Record<string, SqlValue>>(snapshotId);
    return row ? snapshotFromRow(row) : undefined;
  }

  async getSnapshotForWindowAt(windowStart: string, windowEnd: string, snapshotAt: string): Promise<SnapshotRow | undefined> {
    const row = await this.db.prepare(
      `SELECT snapshot_id AS snapshotId, parent_snapshot_id AS parentSnapshotId, rebuild_task_id AS rebuildTaskId,
              definition_version AS definitionVersion, window_start AS windowStart, window_end AS windowEnd,
              snapshot_at AS snapshotAt, maturity_at AS maturityAt, status, response_json AS responseJson,
              created_at AS createdAt, revision_hash AS revisionHash
       FROM fix_metric_snapshots WHERE window_start = ? AND window_end = ? AND snapshot_at = ?`,
    ).first<Record<string, SqlValue>>(windowStart, windowEnd, snapshotAt);
    return row ? snapshotFromRow(row) : undefined;
  }

  // All revisions stored for one fixed (window, as-of) point, NEWEST build first (createdAt,
  // then snapshotId as the deterministic tiebreak). Rebuilds can store several revisions at the
  // same fixed point; callers that need a lineage anchor must pick the latest one that still
  // fully verifies against the canonical inputs (see projection.latestVerifiableSnapshotAt).
  async listSnapshotsForWindowAt(windowStart: string, windowEnd: string, snapshotAt: string): Promise<SnapshotRow[]> {
    const rows = await this.db.prepare(
      `SELECT snapshot_id AS snapshotId, parent_snapshot_id AS parentSnapshotId, rebuild_task_id AS rebuildTaskId,
              definition_version AS definitionVersion, window_start AS windowStart, window_end AS windowEnd,
              snapshot_at AS snapshotAt, maturity_at AS maturityAt, status, response_json AS responseJson,
              created_at AS createdAt, revision_hash AS revisionHash
       FROM fix_metric_snapshots WHERE window_start = ? AND window_end = ? AND snapshot_at = ?
       ORDER BY created_at DESC, snapshot_id DESC`,
    ).all<Record<string, SqlValue>>(windowStart, windowEnd, snapshotAt);
    return rows.map(snapshotFromRow);
  }

  async getPublication(windowStart: string, windowEnd: string): Promise<PublicationRow | undefined> {
    return this.publicationBy(
      `SELECT window_start AS windowStart, window_end AS windowEnd, snapshot_at AS snapshotAt, definition_version AS definitionVersion,
              published_snapshot_id AS publishedSnapshotId, publication_generation AS publicationGeneration,
              published_at AS publishedAt, updated_at AS updatedAt
       FROM fix_metric_snapshot_publication WHERE window_start = ? AND window_end = ?`,
      windowStart,
      windowEnd,
    );
  }

  private async publicationBy(sql: string, ...params: SqlValue[]): Promise<PublicationRow | undefined> {
    const row = await this.db.prepare(sql).first<Record<string, SqlValue>>(...params);
    return row ? publicationFromRow(row) : undefined;
  }

  async latestPublication(): Promise<PublicationRow | undefined> {
    const row = await this.db
      .prepare(
        `SELECT window_start AS windowStart, window_end AS windowEnd, snapshot_at AS snapshotAt, definition_version AS definitionVersion,
                published_snapshot_id AS publishedSnapshotId, publication_generation AS publicationGeneration,
                published_at AS publishedAt, updated_at AS updatedAt
         FROM fix_metric_snapshot_publication ORDER BY window_end DESC LIMIT 1`,
      )
      .first<Record<string, SqlValue>>();
    return row ? publicationFromRow(row) : undefined;
  }

  // Publish a revision for a window with generation CAS. Idempotent: re-publishing the revision
  // the pointer already references is a no-op that never bumps the generation. A concurrent
  // writer who loses the CAS (or the first-insert race) gets false and must not treat its
  // revision as the published one.
  //
  // The CAS protects CONCURRENCY only. A new revision at the same fixed snapshotAt replaces the
  // current pointer regardless of snapshotId lexical order (rebuilds with new content must win);
  // the pointer may still only move forward in as-of time, never to an earlier point.
  //
  // Published-revision history (P1.5): every revision that wins the pointer write is also
  // recorded in fix_metric_snapshot_publication_history. Pointer update and history insert run as
  // ONE atomic transaction on the adapter's batch/transaction API (review P1.1): a partial
  // failure rolls BOTH back, so a pointer can never exist without its history row (and a history
  // row can never exist for a revision the pointer does not (or no longer) carries). The history
  // statement is made conditional INSIDE the same transaction: it only inserts when the pointer
  // row now points at this revision, so a lost CAS race inserts no history either.
  // `publishedAt` is the validated server-controlled clock: invalid/NaN/non-ISO values fail closed
  // (invalid_server_now), never silently pass the future-publication gate.
  async publishRevision(
    windowStart: string,
    windowEnd: string,
    definitionVersion: string,
    snapshotId: string,
    snapshotAt: string,
    publishedAt: string,
  ): Promise<boolean> {
    const publishedAtMs = serverNowMs(publishedAt);
    // Never publish a fixed as-of point whose UTC boundary has not been reached yet (fail closed
    // on future data), even if a matching row somehow exists.
    if (!Number.isFinite(Date.parse(snapshotAt)) || Date.parse(snapshotAt) > publishedAtMs) return false;
    // Validate the immutable target before touching the pointer. This is the application-level
    // half of the FK invariant: a pointer is never created for a missing or metadata-mismatched
    // snapshot, even on adapters that do not enable SQLite foreign keys.
    const target = await this.getSnapshot(snapshotId);
    if (
      !target ||
      !validateSnapshotRowShape(target) ||
      target.definitionVersion !== definitionVersion ||
      target.windowStart !== windowStart ||
      target.windowEnd !== windowEnd ||
      target.snapshotAt !== snapshotAt
    ) {
      return false;
    }

    // The history insert is conditional on the pointer write having landed for THIS revision: the
    // WHERE EXISTS sees the pointer state left by the first statement of the SAME transaction.
    const historyInsert = `INSERT OR IGNORE INTO fix_metric_snapshot_publication_history (
       window_start, window_end, definition_version, snapshot_id, snapshot_at, published_at
     ) SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM fix_metric_snapshot_publication
         WHERE window_start = ? AND window_end = ? AND definition_version = ? AND published_snapshot_id = ?
       )`;
    const historyParams = (targetSnapshotId: string): SqlValue[] => [
      windowStart, windowEnd, definitionVersion, targetSnapshotId, snapshotAt, publishedAt,
      windowStart, windowEnd, definitionVersion, targetSnapshotId,
    ];

    const existing = await this.getPublication(windowStart, windowEnd);
    if (existing) {
      const existingTarget = await this.getSnapshot(existing.publishedSnapshotId);
      // Treat a corrupt pointer as a hard failure. In particular, do not use a matching id as a
      // shortcut: the pointer's definition/window must agree with its immutable target too.
      if (
        !existingTarget ||
        !validateSnapshotRowShape(existingTarget) ||
        existing.windowStart !== existingTarget.windowStart ||
        existing.windowEnd !== existingTarget.windowEnd ||
        existing.snapshotAt !== existingTarget.snapshotAt ||
        existing.definitionVersion !== existingTarget.definitionVersion ||
        existingTarget.windowStart !== windowStart ||
        existingTarget.windowEnd !== windowEnd ||
        existingTarget.definitionVersion !== definitionVersion
      ) {
        return false;
      }
      if (existing.publishedSnapshotId === snapshotId) return true;
      // The pointer may only advance in as-of time (equal is a rebuild replacement); the
      // generation predicate in the CAS makes a concurrent loser fail closed.
      if (existingTarget.snapshotAt > snapshotAt) return false;
      // The history row is written in the SAME atomic transaction, conditioned on the pointer now
      // carrying this revision — a lost CAS race rolls the whole unit back and inserts no history.
      const [casChanges] = await this.db.transaction([
        {
          sql: `UPDATE fix_metric_snapshot_publication
                SET published_snapshot_id = ?, snapshot_at = ?, publication_generation = publication_generation + 1, updated_at = ?, published_at = ?
                WHERE window_start = ? AND window_end = ? AND snapshot_at <= ? AND definition_version = ? AND publication_generation = ?`,
          params: [
            snapshotId, snapshotAt, publishedAt, publishedAt, windowStart, windowEnd, snapshotAt, definitionVersion,
            existing.publicationGeneration,
          ],
        },
        { sql: historyInsert, params: historyParams(snapshotId) },
      ]);
      return casChanges > 0;
    }

    try {
      // First publication for this window: pointer insert + conditional history insert in one
      // atomic transaction. A unique-window insert race has exactly one winner; the loser's whole
      // transaction (including any history write) rolls back and it must not treat its revision
      // as the published one.
      const [insertChanges] = await this.db.transaction([
        {
          sql: `INSERT INTO fix_metric_snapshot_publication (
                   window_start, window_end, snapshot_at, definition_version, published_snapshot_id, publication_generation, published_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          params: [windowStart, windowEnd, snapshotAt, definitionVersion, snapshotId, publishedAt, publishedAt],
        },
        { sql: historyInsert, params: historyParams(snapshotId) },
      ]);
      return insertChanges > 0;
    } catch {
      // A unique-window insert race has a winner. Never update that winner from the losing
      // first-insert call; only an idempotent retry for exactly the same target may return true.
      const winner = await this.getPublication(windowStart, windowEnd);
      return Boolean(
        winner &&
        winner.publishedSnapshotId === snapshotId &&
        winner.snapshotAt === snapshotAt &&
        winner.definitionVersion === definitionVersion &&
        winner.windowStart === windowStart &&
        winner.windowEnd === windowEnd,
      );
    }
  }

  // Published-revision history for one window: pointer target (always readable) plus every
  // revision that was ever published for this window and has since been retained. This is the
  // visibility boundary for the retained-revision read path: a same-window stored-but-never-
  // published row has no pointer and no history row and must never be served.
  async hasPublishedRevision(windowStart: string, windowEnd: string, definitionVersion: string, snapshotId: string): Promise<boolean> {
    const byPointer = await this.db
      .prepare(
        `SELECT 1 AS hit FROM fix_metric_snapshot_publication
         WHERE window_start = ? AND window_end = ? AND definition_version = ? AND published_snapshot_id = ?`,
      )
      .first(windowStart, windowEnd, definitionVersion, snapshotId);
    if (byPointer) return true;
    const byHistory = await this.db
      .prepare(
        `SELECT 1 AS hit FROM fix_metric_snapshot_publication_history
         WHERE window_start = ? AND window_end = ? AND definition_version = ? AND snapshot_id = ?`,
      )
      .first(windowStart, windowEnd, definitionVersion, snapshotId);
    return Boolean(byHistory);
  }
}

// Validated server-controlled clock (P1.7): every store API that writes snapshots or publications
// receives its `now` and must reject anything that is not a well-formed UTC ISO timestamp. A
// NaN/invalid value must never reach a time comparison, where `NaN > x` is always false and
// would silently bypass the future-data gate.
const SERVER_NOW_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function serverNowMs(now: string): number {
  if (typeof now !== 'string' || !SERVER_NOW_PATTERN.test(now)) throw new Error('invalid_server_now');
  const t = Date.parse(now);
  if (!Number.isFinite(t) || new Date(t).toISOString() !== now) throw new Error('invalid_server_now');
  return t;
}

export interface QuarantineRecordInput {
  eventId: string;
  factId: string;
  /** Optional safe run identity used for deduplicated data-quality sample units. */
  runId?: string;
  eventBusinessKey: string;
  eventCanonicalHash: string;
  reasonCode: string;
  receivedAt: string;
  occurredAt?: string;
  eventJson: string;
}

// Quarantine writes must never silently drop: an ACK is only honest when the right row is
// durably present. 'inserted' = this record was persisted; 'duplicate' = the exact same durable
// fact already exists; 'conflict' = an existing row blocks this id/key with different content.
export type QuarantineInsertOutcome =
  | { status: 'inserted' }
  | { status: 'duplicate' }
  | { status: 'conflict' };

export interface QuarantineWindowRecord {
  eventId: string;
  /** Safe run identity when the quarantined event carried one; absent otherwise. */
  runId?: string;
  reasonCode: string;
  occurredAt: string;
  receivedAt: string;
}

function classifyConflict(storedHash: string, incomingHash: string, existingEventId: string): InsertOutcome {
  if (storedHash === incomingHash) {
    return { status: 'duplicate', existingEventId };
  }
  return { status: 'conflict', existingEventId };
}


function nullIfUndefined(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

function insertEventSql(columns: readonly string[]): string {
  const placeholders = columns.map(() => '?').join(', ');
  return `INSERT INTO fix_metric_events (${columns.join(', ')}) VALUES (${placeholders})`;
}

function str(row: Record<string, SqlValue>, key: string): string {
  const v = row[key];
  return v === null || v === undefined ? '' : String(v);
}

function strOpt(row: Record<string, SqlValue>, key: string): string | undefined {
  const v = row[key];
  return v === null || v === undefined ? undefined : String(v);
}

function rowToAcceptedEvent(row: Record<string, SqlValue>): AcceptedEventRow {
  return {
    eventId: str(row, 'event_id'),
    eventBusinessKey: str(row, 'event_business_key'),
    eventCanonicalHash: str(row, 'event_canonical_hash'),
    eventType: str(row, 'event_type'),
    occurredAt: str(row, 'occurred_at'),
    receivedAt: str(row, 'received_at'),
    runId: str(row, 'run_id'),
    factId: str(row, 'fact_id'),
    fixClassification: str(row, 'fix_classification'),
    bugCategory: str(row, 'bug_category'),
    riskLevel: str(row, 'risk_level'),
    stage: str(row, 'stage'),
    workflowId: str(row, 'workflow_id'),
    workflowDefinitionVersion: str(row, 'workflow_definition_version'),
    policyDigest: str(row, 'policy_digest'),
    metricDefinitionVersion: str(row, 'metric_definition_version'),
    stageFrom: strOpt(row, 'stage_from'),
    stageTo: strOpt(row, 'stage_to'),
    terminalOutcome: strOpt(row, 'terminal_outcome'),
    nodeId: strOpt(row, 'node_id'),
    nodeExecutionId: strOpt(row, 'node_execution_id'),
    artifactId: strOpt(row, 'artifact_id'),
    candidateRevision: strOpt(row, 'candidate_revision'),
    reviewCycleId: strOpt(row, 'review_cycle_id'),
    resolutionCycleId: strOpt(row, 'resolution_cycle_id'),
    dispositionOutcome: strOpt(row, 'disposition_outcome'),
    workerId: strOpt(row, 'worker_id'),
    role: strOpt(row, 'role'),
    controlRef: strOpt(row, 'control_ref'),
    supersedesEventId: strOpt(row, 'supersedes_event_id'),
    resolutionType: strOpt(row, 'resolution_type'),
    outcome: strOpt(row, 'outcome'),
    decision: strOpt(row, 'decision'),
    reasonCode: strOpt(row, 'reason_code'),
    sourceVersion: strOpt(row, 'source_version'),
    payloadJson: str(row, 'payload_json'),
  };
}

function snapshotFromRow(row: Record<string, SqlValue>): SnapshotRow {
  return {
    snapshotId: str(row, 'snapshotId'),
    parentSnapshotId: strOpt(row, 'parentSnapshotId'),
    rebuildTaskId: strOpt(row, 'rebuildTaskId'),
    definitionVersion: str(row, 'definitionVersion'),
    windowStart: str(row, 'windowStart'),
    windowEnd: str(row, 'windowEnd'),
    snapshotAt: str(row, 'snapshotAt'),
    maturityAt: str(row, 'maturityAt'),
    status: str(row, 'status'),
    responseJson: str(row, 'responseJson'),
    createdAt: str(row, 'createdAt'),
    revisionHash: str(row, 'revisionHash'),
  };
}

function publicationFromRow(row: Record<string, SqlValue>): PublicationRow {
  return {
    windowStart: str(row, 'windowStart'),
    windowEnd: str(row, 'windowEnd'),
    snapshotAt: str(row, 'snapshotAt'),
    definitionVersion: str(row, 'definitionVersion'),
    publishedSnapshotId: str(row, 'publishedSnapshotId'),
    publicationGeneration: Number(row.publicationGeneration),
    publishedAt: str(row, 'publishedAt'),
    updatedAt: str(row, 'updatedAt'),
  };
}