import { FIX_FUNNEL_DEFINITION_VERSION, FUNNEL_STEPS } from './config.ts';
import { RESOLUTION_TYPES } from './events.ts';
import { verifyStoredSnapshot } from './projection.ts';
import type { MetricStore, SnapshotRow } from './store.ts';

export interface FunnelStep {
  eventType: string;
  runs: number;
  fromPreviousRate: number | null;
}

export interface DropOffReason {
  reasonCode: string;
  runs: number;
}

export interface FunnelSnapshotPayload {
  snapshotId: string;
  parentSnapshotId: string | null;
  rebuildTaskId: string | null;
  definitionVersion: string;
  windowStart: string;
  windowEnd: string;
  snapshotAt: string;
  maturityAt: string;
  totalRuns: number;
  steps: FunnelStep[];
  resolutionTypes: Record<string, number>;
  dropOffReasons: DropOffReason[];
  dataQuality: {
    incompleteRuns: number;
    lateEvents: number;
    invalidEvents: number;
    /** Deduplicated safe runId sample units (low-sample basis); unattributable records suppressed. */
    lateEventRuns: number;
    invalidEventRuns: number;
    lowSampleProtected: boolean;
  };
  dataFreshnessSeconds: number;
}

const ID_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isUtcMonthStart(value: unknown): value is string {
  if (!isIso(value)) return false;
  const date = new Date(value);
  return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0 && date.getUTCDate() === 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteRate(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isFunnelStep(value: unknown): value is (typeof FUNNEL_STEPS)[number] {
  return typeof value === 'string' && (FUNNEL_STEPS as readonly string[]).includes(value);
}

/** Validate the stored response and its row metadata without trusting TypeScript casts. */
export function validateSnapshotPayload(
  value: unknown,
  metadata: Pick<SnapshotRowMetadata, 'snapshotId' | 'parentSnapshotId' | 'rebuildTaskId' | 'definitionVersion' | 'windowStart' | 'windowEnd' | 'snapshotAt' | 'maturityAt'>,
): value is FunnelSnapshotPayload {
  if (!isRecord(value) || !sameKeys(value, [
    'snapshotId', 'parentSnapshotId', 'rebuildTaskId', 'definitionVersion', 'windowStart', 'windowEnd',
    'snapshotAt', 'maturityAt', 'totalRuns', 'steps', 'resolutionTypes', 'dropOffReasons', 'dataQuality',
    'dataFreshnessSeconds',
  ])) return false;
  if (typeof value.snapshotId !== 'string' || !ID_PATTERN.test(value.snapshotId)) return false;
  if (value.snapshotId !== metadata.snapshotId || value.parentSnapshotId !== (metadata.parentSnapshotId ?? null) || value.rebuildTaskId !== (metadata.rebuildTaskId ?? null) || value.definitionVersion !== metadata.definitionVersion || value.windowStart !== metadata.windowStart || value.windowEnd !== metadata.windowEnd || value.snapshotAt !== metadata.snapshotAt || value.maturityAt !== metadata.maturityAt) return false;
  if (value.definitionVersion !== FIX_FUNNEL_DEFINITION_VERSION || !isUtcMonthStart(value.windowStart) || !isUtcMonthStart(value.windowEnd) || !isUtcMonthStart(value.snapshotAt)) return false;
  const start = new Date(value.windowStart);
  const end = new Date(value.windowEnd);
  const snapshotAt = new Date(value.snapshotAt);
  const expectedEnd = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  if (end.getTime() !== expectedEnd.getTime()) return false;
  if (snapshotAt.getTime() < end.getTime()) return false;
  if (value.maturityAt !== new Date(end.getTime() + 30 * 86400 * 1000).toISOString()) return false;
  if (value.parentSnapshotId !== null && (typeof value.parentSnapshotId !== 'string' || !ID_PATTERN.test(value.parentSnapshotId))) return false;
  if (value.rebuildTaskId !== null && (typeof value.rebuildTaskId !== 'string' || !ID_PATTERN.test(value.rebuildTaskId))) return false;
  if (!isNonNegativeInteger(value.totalRuns) || !isNonNegativeInteger(value.dataFreshnessSeconds)) return false;
  if (!Array.isArray(value.steps) || value.steps.length !== FUNNEL_STEPS.length) return false;
  for (let i = 0; i < value.steps.length; i += 1) {
    const step = value.steps[i];
    if (!isRecord(step) || !sameKeys(step, ['eventType', 'runs', 'fromPreviousRate']) || step.eventType !== FUNNEL_STEPS[i] || !isNonNegativeInteger(step.runs) || !isFiniteRate(step.fromPreviousRate)) return false;
  }
  if (!isRecord(value.resolutionTypes)) return false;
  for (const [key, count] of Object.entries(value.resolutionTypes)) {
    if (!(RESOLUTION_TYPES as readonly string[]).includes(key) || !isNonNegativeInteger(count)) return false;
  }
  if (!Array.isArray(value.dropOffReasons)) return false;
  const seenDropOffReasons = new Set<string>();
  for (const reason of value.dropOffReasons) {
    if (!isRecord(reason) || !sameKeys(reason, ['reasonCode', 'runs']) || typeof reason.reasonCode !== 'string' || !ID_PATTERN.test(reason.reasonCode) || !reason.reasonCode.startsWith('not_reached_') || !isFunnelStep(reason.reasonCode.slice('not_reached_'.length)) || !isNonNegativeInteger(reason.runs) || seenDropOffReasons.has(reason.reasonCode)) return false;
    seenDropOffReasons.add(reason.reasonCode);
  }
  if (!isRecord(value.dataQuality) || !sameKeys(value.dataQuality, ['incompleteRuns', 'lateEvents', 'invalidEvents', 'lateEventRuns', 'invalidEventRuns', 'lowSampleProtected']) || !isNonNegativeInteger(value.dataQuality.incompleteRuns) || !isNonNegativeInteger(value.dataQuality.lateEvents) || !isNonNegativeInteger(value.dataQuality.invalidEvents) || !isNonNegativeInteger(value.dataQuality.lateEventRuns) || !isNonNegativeInteger(value.dataQuality.invalidEventRuns) || typeof value.dataQuality.lowSampleProtected !== 'boolean') return false;
  return true;
}

export interface SnapshotRowMetadata {
  snapshotId: string;
  parentSnapshotId?: string | null;
  rebuildTaskId?: string | null;
  definitionVersion: string;
  windowStart: string;
  windowEnd: string;
  snapshotAt: string;
  maturityAt: string;
}

/**
 * Row-level half of the canonical snapshot contract: the stored payload must validate against the
 * row's own metadata and carry a calculable status with non-empty revision binding fields. This is
 * the metadata/content shape check only — it does NOT prove the revision hash is bound to real
 * canonical inputs (see verifyStoredSnapshot in projection.ts) nor that lineage is coherent (see
 * verifySnapshotLineage below).
 */
export function validateSnapshotRowShape(row: SnapshotRow): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(row.responseJson) as unknown;
  } catch {
    return false;
  }
  return validateSnapshotPayload(payload, row) &&
    row.status === 'calculable' &&
    typeof row.revisionHash === 'string' && row.revisionHash.length > 0 &&
    typeof row.createdAt === 'string';
}

/**
 * Parent lineage validation for the canonical snapshot contract. A revision that declares a parent
 * must be part of a coherent rebuild chain:
 *   - parent row exists and is itself a valid calculable revision whose content fully recomputes
 *     from the canonical inputs (full stored-snapshot verification, not a shape-only check — a
 *     forged or mutated parent row can never anchor a child lineage)
 *   - parent covers the SAME window and definition version
 *   - parent is a strictly EARLIER fixed as-of point
 *   - parentSnapshotId and rebuildTaskId are set together (a rebuild task without a parent, or a
 *     parent without a rebuild task, is incoherent lineage)
 * Root revisions (no parent) must not carry a rebuild task id.
 */
export async function verifySnapshotLineage(store: MetricStore, row: SnapshotRow): Promise<boolean> {
  if (row.parentSnapshotId === undefined) {
    return row.rebuildTaskId === undefined;
  }
  if (row.rebuildTaskId === undefined) return false;
  const parent = await store.getSnapshot(row.parentSnapshotId);
  // Full verification of the stored parent: shape AND content recompute (verifyStoredSnapshot),
  // not merely the metadata/shape check. A parent row that was forged or mutated outside
  // insertSnapshot must fail the child's lineage no matter how well-formed it looks.
  if (!parent || !validateSnapshotRowShape(parent) || !(await verifyStoredSnapshot(store, parent))) return false;
  return parent.definitionVersion === row.definitionVersion &&
    parent.windowStart === row.windowStart &&
    parent.windowEnd === row.windowEnd &&
    Date.parse(parent.snapshotAt) < Date.parse(row.snapshotAt);
}
