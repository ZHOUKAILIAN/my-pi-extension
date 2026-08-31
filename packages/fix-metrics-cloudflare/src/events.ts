// Allowlisted Fix funnel events: the public five-step funnel contract, server-side validation,
// idempotency-key derivation (eventBusinessKey / eventCanonicalHash) and quarantine sanitization.
//
// Server responsibilities (approved design §6.3, §6.7, §6.8):
//   - accept ONLY the five public funnel event types
//   - validate strict per-eventType shape: required fields, closed enums, joint-field combinations,
//     "additionalProperties=false" on the envelope and on the payload (no raw business text)
//   - compute eventBusinessKey and eventCanonicalHash server-side; never trust the client for storage
//   - classify failures as item permanent_error (schema/enum/union/definition version) or
//     item quarantined (time skew, malformed time, unsafe content) and never silent-drop
//
// This slice intentionally does NOT implement: signatures/trust roots, replay audit, outbox,
// disposition/classification events, or any event type outside the public funnel.

import { canonicalJson, canonicalJsonSafe, sha256Base64url } from './canonical.ts';
import { FIX_FUNNEL_DEFINITION_VERSION } from './config.ts';

export const RESOLUTION_TYPES = [
  'code_change',
  'versioned_config_change',
  'runtime_or_data_action',
  'external_dependency_action',
  'no_change_expected_behavior',
] as const;
export type ResolutionType = (typeof RESOLUTION_TYPES)[number];

export const BUG_CATEGORIES = ['application', 'data', 'configuration', 'environment', 'dependency', 'workflow', 'unknown'] as const;

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export const ROLES = ['controller', 'runtime', 'reviewer', 'verifier', 'operator'] as const;

export const STAGES = [
  'INTAKE',
  'INVESTIGATING',
  'DISPOSITION',
  'IMPLEMENTING',
  'VERIFYING',
  'WAITING_FOR_USER',
  'ACCEPTED',
  'BLOCKED',
] as const;

// L1 versioned business classification (schemaVersion 1, approved design §6.3).
export const FIX_CLASSIFICATIONS = [
  'unclassified',
  'implementation_defect',
  'regression',
  'configuration_issue',
  'data_or_environment',
  'external_dependency',
  'expected_behavior',
  'change_request',
  'insufficient_evidence',
] as const;

export const OUTCOMES = ['passed', 'failed', 'completed', 'blocked'] as const;
export const DECISIONS = ['approve', 'request_changes', 'reject'] as const;
export const WAIT_REASONS = ['user_decision', 'external_action', 'supplemental_evidence'] as const;
export const DISPOSITION_OUTCOMES = ['actionable', 'deferred', 'insufficient_evidence'] as const;
export const TERMINAL_OUTCOMES = ['accepted', 'rejected', 'aborted'] as const;

export type FunnelEventType =
  | 'run_started'
  | 'investigation_review_passed'
  | 'resolution_completed'
  | 'verification_passed'
  | 'run_accepted';

// ---------------------------------------------------------------------------
// Storage / validation types
// ---------------------------------------------------------------------------

export interface AcceptedEvent {
  schemaVersion: number;
  metricDefinitionVersion: string;
  eventId: string;
  eventBusinessKey: string;
  eventCanonicalHash: string;
  eventType: FunnelEventType;
  occurredAt: string;
  receivedAt: string;
  runId: string;
  workflowId: 'fix';
  workflowDefinitionVersion: string;
  policyDigest: string;
  factId: string;
  fixClassification: string;
  bugCategory: string;
  riskLevel: string;
  stage: string;
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

export interface QuarantineRecord {
  eventId: string;
  factId: string;
  /** Safe run identity retained for deduplicated data-quality sample units; never raw text. */
  runId?: string;
  eventBusinessKey: string;
  eventCanonicalHash: string;
  reasonCode: string;
  receivedAt: string;
  occurredAt: string;
  eventJson: string; // sanitized/redacted, never raw business text
}

export type ValidationOutcome =
  | { kind: 'ok'; event: AcceptedEvent; eventBusinessKey: string; eventCanonicalHash: string }
  | { kind: 'quarantine'; errorCode: string; record: QuarantineRecord }
  | { kind: 'permanent'; errorCode: string };

export interface ValidationContext {
  now: Date;
  futureSkewMs: number;
  lateEventWindowMs: number;
}

// ---------------------------------------------------------------------------
// Field / value checks
// ---------------------------------------------------------------------------

const ID_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/;
const ASCII_PRINTABLE_PATTERN = /^[\x20-\x7e]+$/;
// Opaque digest values (policyDigest): bounded structured ASCII, not arbitrary prose.
const DIGEST_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/;
// reasonCode is a structured code, never free-form text.
const REASON_CODE_PATTERN = /^[A-Za-z0-9._:+-]{1,64}$/;

// ID-class reference fields must be well-formed short ASCII ids (no free-form text):
// run/worker/node references, cycle refs, controlRef, artifact/candidate refs.
const STRICT_ID_FIELDS = [
  'runId',
  'factId',
  'nodeId',
  'nodeExecutionId',
  'artifactId',
  'candidateRevision',
  'reviewCycleId',
  'resolutionCycleId',
  'workerId',
  'controlRef',
  'supersedesEventId',
  'sourceVersion',
] as const;
const DIGEST_FIELDS = ['policyDigest'] as const;
// Stage-reference fields use the same closed stage enum as `stage`; no arbitrary transition text is
// accepted in this public contract.
const SHORT_TEXT_FIELDS = ['stageFrom', 'stageTo'] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isShortAsciiId(v: unknown): v is string {
  return typeof v === 'string' && ID_PATTERN.test(v);
}

function isShortText(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= 128 && ASCII_PRINTABLE_PATTERN.test(v);
}


const WORKFLOW_DEFINITION_VERSION_PATTERN = /^[A-Za-z0-9._:+-]{1,128}$/;

function isStage(v: unknown): v is (typeof STAGES)[number] {
  return typeof v === 'string' && (STAGES as readonly string[]).includes(v);
}

function requiredString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string') throw new Error(`validated field is not a string: ${field}`);
  return value;
}

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  'schemaVersion',
  'metricDefinitionVersion',
  'eventId',
  'eventBusinessKey',
  'factId',
  'eventType',
  'occurredAt',
  'runId',
  'workflowId',
  'workflowDefinitionVersion',
  'policyDigest',
  'fixClassification',
  'bugCategory',
  'riskLevel',
  'stage',
  'stageFrom',
  'stageTo',
  'terminalOutcome',
  'nodeId',
  'nodeExecutionId',
  'artifactId',
  'candidateRevision',
  'reviewCycleId',
  'resolutionCycleId',
  'dispositionOutcome',
  'workerId',
  'role',
  'controlRef',
  'supersedesEventId',
  'resolutionType',
  'outcome',
  'decision',
  'reasonCode',
  'sourceVersion',
  'payload',
]);

function validUtcIso(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)) return false;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString() === v;
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

export async function validateEvent(raw: unknown, ctx: ValidationContext): Promise<ValidationOutcome> {
  const receivedAt = ctx.now.toISOString();
  const nowMs = ctx.now.getTime();

  if (!isPlainObject(raw)) {
    return permanent('not_an_event');
  }

  // Validate the envelope's shape before time safety. A present field with the wrong type is a
  // permanent item error and must not be converted into a quarantine record by another field.
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) return permanent('unknown_top_level_field');
  }
  const typedStringFields = [
    'eventId', 'eventBusinessKey', 'factId', 'eventType', 'occurredAt', 'runId', 'workflowId',
    'workflowDefinitionVersion', 'policyDigest', 'fixClassification', 'bugCategory', 'riskLevel',
    'stage', 'stageFrom', 'stageTo', 'terminalOutcome', 'nodeId', 'nodeExecutionId', 'artifactId',
    'candidateRevision', 'reviewCycleId', 'resolutionCycleId', 'dispositionOutcome', 'workerId',
    'role', 'controlRef', 'supersedesEventId', 'resolutionType', 'outcome', 'decision', 'reasonCode',
    'sourceVersion',
  ];
  for (const field of typedStringFields) {
    if (raw[field] !== undefined && typeof raw[field] !== 'string') return permanent('invalid_field_type');
  }
  if (raw.schemaVersion !== undefined && (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion))) {
    return permanent('invalid_field_type');
  }
  if (raw.payload !== undefined && !isPlainObject(raw.payload)) return permanent('invalid_field_type');

  const eventType = raw.eventType;
  if (eventType === undefined) return permanent('missing_required_field');
  if (!isFunnelEventType(eventType)) return permanent(typeof eventType === 'string' ? 'unknown_event_type' : 'invalid_field_type');
  for (const field of requiredFor(eventType)) {
    if (raw[field] === undefined || raw[field] === null || raw[field] === '') return permanent('missing_required_field');
  }

  // --- time safety (only a well-typed timestamp may enter quarantine) ---
  const occurredAtRaw = raw.occurredAt;
  if (typeof occurredAtRaw !== 'string') return permanent('missing_required_field');
  if (!validUtcIso(occurredAtRaw)) return await quarantineEvent(raw, 'invalid_occurred_at', receivedAt);
  const occurredMs = Date.parse(occurredAtRaw);
  if (occurredMs > nowMs + ctx.futureSkewMs) return await quarantineEvent(raw, 'future_event', receivedAt);
  if (nowMs - occurredMs > ctx.lateEventWindowMs) return await quarantineEvent(raw, 'late_event', receivedAt);

  if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion)) return permanent('invalid_field_type');
  if (raw.schemaVersion !== 1) return permanent('unsupported_schema_version');
  if (typeof raw.metricDefinitionVersion !== 'string') return permanent('invalid_field_type');
  if (raw.metricDefinitionVersion !== FIX_FUNNEL_DEFINITION_VERSION) return permanent('unsupported_definition_version');

  if (typeof raw.eventId !== 'string') return permanent('invalid_field_type');
  if (!isShortAsciiId(raw.eventId)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
  if (typeof raw.factId !== 'string') return permanent('invalid_field_type');
  if (!isShortAsciiId(raw.factId)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
  if (typeof raw.runId !== 'string') return permanent('invalid_field_type');
  if (!isShortAsciiId(raw.runId)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
  if (typeof raw.workflowDefinitionVersion !== 'string' || !WORKFLOW_DEFINITION_VERSION_PATTERN.test(raw.workflowDefinitionVersion)) return permanent('invalid_field_type');
  if (typeof raw.policyDigest !== 'string') return permanent('invalid_field_type');
  if (!DIGEST_PATTERN.test(raw.policyDigest)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
  if (typeof raw.stage !== 'string' || !isStage(raw.stage)) return permanent(typeof raw.stage === 'string' ? 'invalid_enum_value' : 'invalid_field_type');
  if (raw.eventBusinessKey !== undefined && !isShortAsciiId(raw.eventBusinessKey)) return permanent('invalid_field_type');
  for (const field of ['stageFrom', 'stageTo'] as const) {
    if (raw[field] !== undefined && !isStage(raw[field])) return permanent(typeof raw[field] === 'string' ? 'invalid_enum_value' : 'invalid_field_type');
  }

  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === 'string' && !safeWireString(value)) {
      return await quarantineEvent(raw, 'unsafe_content', receivedAt);
    }
  }

  if (typeof raw.workflowId !== 'string') return permanent('invalid_field_type');
  if (typeof raw.riskLevel !== 'string') return permanent('invalid_field_type');
  if (typeof raw.bugCategory !== 'string') return permanent('invalid_field_type');
  if (raw.role !== undefined && typeof raw.role !== 'string') return permanent('invalid_field_type');
  if (raw.workflowId !== 'fix') return permanent('invalid_enum_value');
  if (!(RISK_LEVELS as readonly string[]).includes(raw.riskLevel)) return permanent('invalid_enum_value');
  if (!(BUG_CATEGORIES as readonly string[]).includes(raw.bugCategory)) return permanent('invalid_enum_value');
  if (raw.role !== undefined && !(ROLES as readonly string[]).includes(raw.role)) return permanent('invalid_enum_value');


  // --- per-field strict patterns: reference/digest/text fields must be well-formed ---
  // Non-string values for optional reference fields are rejected too (never silently dropped).
  for (const field of STRICT_ID_FIELDS) {
    const value = raw[field];
    if (value !== undefined && typeof value !== 'string') return permanent('invalid_field_type');
    if (value !== undefined && !ID_PATTERN.test(value)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
  }
  for (const field of DIGEST_FIELDS) {
    const value = raw[field];
    if (value !== undefined && typeof value !== 'string') return permanent('invalid_field_type');
    if (value !== undefined && !DIGEST_PATTERN.test(value)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
  }
  for (const field of SHORT_TEXT_FIELDS) {
    const value = raw[field];
    if (value !== undefined && (typeof value !== 'string' || !isShortText(value))) {
      return await quarantineEvent(raw, 'unsafe_content', receivedAt);
    }
  }
  const reasonCode = raw.reasonCode;
  if (reasonCode !== undefined && typeof reasonCode !== 'string') return permanent('invalid_field_type');
  if (typeof reasonCode === 'string' && !REASON_CODE_PATTERN.test(reasonCode)) {
    return await quarantineEvent(raw, 'unsafe_content', receivedAt);
  }

  // --- closed enums on every structured axis (when present). The joint checks below add the
  //     per-eventType combination constraints (e.g. outcome=passed for verified nodes).
  const enumAxes: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['fixClassification', FIX_CLASSIFICATIONS],
    ['outcome', OUTCOMES],
    ['decision', DECISIONS],
    ['waitReason', WAIT_REASONS],
    ['terminalOutcome', TERMINAL_OUTCOMES],
    ['dispositionOutcome', DISPOSITION_OUTCOMES],
    ['resolutionType', RESOLUTION_TYPES],
  ];
  for (const [field, allowed] of enumAxes) {
    const value = raw[field];
    if (value !== undefined && typeof value !== 'string') return permanent('invalid_field_type');
    if (typeof value === 'string' && !(allowed as readonly string[]).includes(value)) return permanent('invalid_enum_value');
  }

  // --- strict payload: plain object, no unknown fields ---
  // Own-property checks only, in BOTH directions: unknown-key detection (Object.keys +
  // Object.hasOwn on the schema) and required-field reads (Object.hasOwn on the payload).
  // `key in schema` would accept inherited Object.prototype keys, and reading payload[key]
  // without Object.hasOwn would let a payload built via Object.create(proto) satisfy a required
  // field through the prototype chain — while the persisted payloadJson (own enumerable
  // properties only) would silently omit that required evidence from durable storage.
  const payload = raw.payload;
  if (!isPlainObject(payload)) return permanent('invalid_payload_shape');
  const payloadSchema = payloadSchemaFor(eventType);
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(payloadSchema, key)) return permanent('unknown_payload_field');
  }
  for (const [key, spec] of Object.entries(payloadSchema)) {
    const value = Object.hasOwn(payload, key) ? payload[key] : undefined;
    if (spec.required && value === undefined) return permanent('missing_required_field');
    if (value !== undefined && spec.type === 'id') {
      if (typeof value !== 'string') return permanent('invalid_field_type');
      if (!isShortAsciiId(value)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
    }
    if (value !== undefined && spec.type === 'text') {
      if (typeof value !== 'string') return permanent('invalid_field_type');
      if (!isShortText(value)) return await quarantineEvent(raw, 'unsafe_content', receivedAt);
    }
  }

  // --- joint combination checks ---
  const joint = jointCheck(eventType, raw);
  if (joint) return permanent(joint);

  // --- assemble the normalized storage event from whitelisted fields only ---
  const optionalId = (field: string): string | undefined => {
    const v = raw[field];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };

  const event: AcceptedEvent = {
    schemaVersion: 1,
    metricDefinitionVersion: FIX_FUNNEL_DEFINITION_VERSION,
    eventId: requiredString(raw, 'eventId'),
    eventBusinessKey: '', // server-computed below; placeholder keeps the storage type exact
    eventCanonicalHash: '',
    eventType,
    occurredAt: requiredString(raw, 'occurredAt'),
    receivedAt,
    runId: requiredString(raw, 'runId'),
    workflowId: 'fix',
    workflowDefinitionVersion: requiredString(raw, 'workflowDefinitionVersion'),
    policyDigest: requiredString(raw, 'policyDigest'),
    factId: requiredString(raw, 'factId'),
    fixClassification: requiredString(raw, 'fixClassification'),
    bugCategory: requiredString(raw, 'bugCategory'),
    riskLevel: requiredString(raw, 'riskLevel'),
    stage: requiredString(raw, 'stage'),
    stageFrom: optionalId('stageFrom'),
    stageTo: optionalId('stageTo'),
    terminalOutcome: optionalId('terminalOutcome'),
    nodeId: optionalId('nodeId'),
    nodeExecutionId: optionalId('nodeExecutionId'),
    artifactId: optionalId('artifactId'),
    candidateRevision: optionalId('candidateRevision'),
    reviewCycleId: optionalId('reviewCycleId'),
    resolutionCycleId: optionalId('resolutionCycleId'),
    dispositionOutcome: optionalId('dispositionOutcome'),
    workerId: optionalId('workerId'),
    role: optionalId('role'),
    controlRef: optionalId('controlRef'),
    supersedesEventId: optionalId('supersedesEventId'),
    resolutionType: optionalId('resolutionType'),
    outcome: optionalId('outcome'),
    decision: optionalId('decision'),
    reasonCode: optionalId('reasonCode'),
    sourceVersion: optionalId('sourceVersion'),
    payloadJson: canonicalJson(payload),
  };

  const eventBusinessKey = await businessKey(event);
  const eventCanonicalHash = await canonicalHash(event);
  // the storage envelope carries the server-computed keys (never client input)
  event.eventBusinessKey = eventBusinessKey;
  event.eventCanonicalHash = eventCanonicalHash;

  // client-supplied business key, if present, must match the server recomputation
  if (raw.eventBusinessKey !== undefined && typeof raw.eventBusinessKey === 'string' && raw.eventBusinessKey !== eventBusinessKey) {
    return permanent('business_key_mismatch');
  }

  return { kind: 'ok', event, eventBusinessKey, eventCanonicalHash };
}

// ---------------------------------------------------------------------------
// Idempotency keys (approved design §6.3)
// ---------------------------------------------------------------------------

// Business key pins the business identity: factId + eventType + semantic payload. Transport
// records (eventId, receivedAt), worker/attempt fields and timestamps never enter it, so a retry
// of the exact same confirmed fact reuses the same key; a legitimate rework produces a new factId
// and therefore a new key.
export async function businessKey(event: AcceptedEvent): Promise<string> {
  const semantic = { factId: event.factId, eventType: event.eventType, payload: JSON.parse(event.payloadJson) };
  return sha256Base64url(canonicalJson(semantic));
}

// The semantic envelope is the approved design's `semanticEnvelope`: the whole allowlisted wire
// envelope minus transport/derived records (eventId, eventBusinessKey, eventCanonicalHash,
// receivedAt) and minus the internal payloadJson column. payload appears exactly once, as the
// parsed object, so hash bytes never depend on how the server serialized the payload column.
export function semanticEnvelope(event: AcceptedEvent): Record<string, unknown> {
  const envelope: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (
      key === 'eventId' ||
      key === 'eventBusinessKey' ||
      key === 'eventCanonicalHash' ||
      key === 'receivedAt' ||
      key === 'payloadJson' ||
      value === undefined
    ) {
      continue;
    }
    envelope[key] = value;
  }
  envelope.payload = JSON.parse(event.payloadJson);
  return envelope;
}

// Canonical hash of the semantic allowlisted envelope. Used for duplicate-vs-conflict comparison.
export async function canonicalHash(event: AcceptedEvent): Promise<string> {
  return sha256Base64url(canonicalJson(semanticEnvelope(event)));
}

// ---------------------------------------------------------------------------
// Per-type contract tables
// ---------------------------------------------------------------------------

function isFunnelEventType(v: unknown): v is FunnelEventType {
  return (
    v === 'run_started' ||
    v === 'investigation_review_passed' ||
    v === 'resolution_completed' ||
    v === 'verification_passed' ||
    v === 'run_accepted'
  );
}

// NOTE (deliberate follow-up, P2): the per-type wire contract is currently spread across several
// registries that must stay in agreement (KNOWN_TOP_LEVEL_FIELDS, typedStringFields,
// STRICT_ID_FIELDS, DIGEST_FIELDS, SHORT_TEXT_FIELDS, requiredFor, payloadSchemaFor, jointCheck,
// enumAxes, SANITIZABLE_ID_FIELDS). Consolidating them into one per-eventType contract table is
// a dedicated refactor and is intentionally NOT done in this slice to keep the change minimal;
// test/events.test.ts exercises each registry against all five public event types.
function requiredFor(eventType: FunnelEventType): string[] {
  const base = [
    'schemaVersion',
    'metricDefinitionVersion',
    'eventId',
    'factId',
    'eventType',
    'occurredAt',
    'runId',
    'workflowId',
    'workflowDefinitionVersion',
    'policyDigest',
    'bugCategory',
    'riskLevel',
    'fixClassification',
    'stage',
    'payload',
  ];
  switch (eventType) {
    case 'run_started':
      // 'stage' is already in base; the duplicated [...base, 'stage'] entry was removed.
      return base;
    case 'investigation_review_passed':
      return [...base, 'reviewCycleId', 'controlRef', 'outcome'];
    case 'resolution_completed':
      return [...base, 'controlRef', 'resolutionCycleId', 'resolutionType', 'dispositionOutcome'];
    case 'verification_passed':
      return [...base, 'controlRef', 'resolutionCycleId', 'outcome'];
    case 'run_accepted':
      return [...base, 'controlRef', 'terminalOutcome'];
  }
}

function payloadSchemaFor(eventType: FunnelEventType): Record<string, { required: boolean; type: 'id' | 'text' }> {
  switch (eventType) {
    case 'run_started':
    case 'investigation_review_passed':
    case 'run_accepted':
      return {};
    case 'resolution_completed':
      return { resolutionEvidenceRef: { required: true, type: 'id' } };
    case 'verification_passed':
      return { resolutionEvidenceRef: { required: false, type: 'id' } };
  }
}

// Error code for the ingest-side Acceptance gate (src/ingest.ts): this slice models the
// Acceptance facts a run_accepted may rely on as an already-accepted verification_passed for the
// SAME run (the human decision record is a later slice). A bare valid-shape run_accepted without
// that prior evidence is rejected as a permanent error, never silently accepted.
export const RUN_ACCEPTED_WITHOUT_VERIFICATION = 'run_accepted_without_verification';

/**
 * True when a raw wire eventId is a schema-safe identifier fit for echoing back in an ACK
 * (review P2.9). An eventId that fails this check is never echoed: the ACK carries a fixed safe
 * placeholder (permanent items) or the server-generated quarantine identity (quarantined items).
 */
export function isSafeEventId(v: unknown): v is string {
  return typeof v === 'string' && ID_PATTERN.test(v);
}

function jointCheck(eventType: FunnelEventType, raw: Record<string, unknown>): string | null {
  switch (eventType) {
    case 'run_started':
      if (raw.stage !== 'INTAKE') return 'invalid_union_shape';
      if (raw.fixClassification !== 'unclassified') return 'invalid_union_shape';
      return null;
    case 'investigation_review_passed':
      if (raw.outcome !== 'passed') return 'invalid_union_shape';
      return null;
    case 'resolution_completed': {
      if (raw.dispositionOutcome !== 'actionable') return 'invalid_union_shape';
      const rt = raw.resolutionType;
      if (typeof rt !== 'string' || !RESOLUTION_TYPES.includes(rt as (typeof RESOLUTION_TYPES)[number])) {
        return 'invalid_enum_value';
      }
      return null;
    }
    case 'verification_passed':
      if (raw.outcome !== 'passed') return 'invalid_union_shape';
      // Approved evidence/version binding: a verification fact must name WHAT was verified — the
      // candidate revision, the source version, or the structured payload evidence reference
      // (own property). An empty payload with no version/evidence binding is a permanent error;
      // it must never be accepted as a silently unbound verification fact (L2 design:
      // candidateRevision must stay consistent across implementation, review and verification).
      if (
        raw.candidateRevision === undefined &&
        raw.sourceVersion === undefined &&
        !(isPlainObject(raw.payload) && Object.hasOwn(raw.payload, 'resolutionEvidenceRef'))
      ) {
        return 'missing_required_field';
      }
      return null;
    case 'run_accepted':
      // Schema-level union shape only. The ORDERING contract — run_accepted requires prior
      // Acceptance evidence (an accepted verification_passed for the same run) — is enforced at
      // ingest (src/ingest.ts, review P1.5), where stored facts are visible; a per-item schema
      // check cannot see them.
      if (raw.terminalOutcome !== 'accepted') return 'invalid_union_shape';
      return null;
  }
}

// ---------------------------------------------------------------------------
// Quarantine sanitization and helpers
// ---------------------------------------------------------------------------

function permanent(errorCode: string): ValidationOutcome {
  return { kind: 'permanent', errorCode };
}

async function quarantineEvent(raw: Record<string, unknown>, reasonCode: string, receivedAt: string): Promise<ValidationOutcome> {
  const occurredAt =
    typeof raw.occurredAt === 'string' && validUtcIso(raw.occurredAt) ? raw.occurredAt : receivedAt;
  const safeEventId = typeof raw.eventId === 'string' && isShortAsciiId(raw.eventId) ? raw.eventId : undefined;
  const safeFactId = typeof raw.factId === 'string' && isShortAsciiId(raw.factId) ? raw.factId : undefined;
  // Run identity is retained only when it is a schema-safe id; it feeds deduplicated data-quality
  // sample units and is never raw business text. Unsafe or absent runIds are not retained.
  const safeRunId = typeof raw.runId === 'string' && isShortAsciiId(raw.runId) ? raw.runId : undefined;
  const identity = await quarantineIdentity(raw, reasonCode);
  return {
    kind: 'quarantine',
    errorCode: reasonCode,
    record: {
      eventId: safeEventId ?? `qz_${identity}`,
      factId: safeFactId ?? `qz_${identity}`,
      // Quarantine identities are never shared sentinels ('[unkeyed]'/'[redacted]'): unrelated
      // invalid events must each be independently durable and both ACKed quarantined, while the
      // exact same event re-sent maps to the same identity and stays a duplicate.
      eventBusinessKey: `qzk_${identity}`,
      eventCanonicalHash: `qzh_${identity}`,
      ...(safeRunId ? { runId: safeRunId } : {}),
      reasonCode,
      receivedAt,
      occurredAt,
      eventJson: sanitizeEventJson(raw),
    },
  };
}

// Deterministic, collision-resistant server-side quarantine identity: a SHA-256 digest over the
// reason code and a digest of the full raw wire content. The raw digest enters durable storage
// only as a hash, so no raw business text is ever persisted. Unrelated events hash differently
// (even when their safe sanitized metadata would be identical); the exact same bytes with the
// same reason produce the same identity, preserving duplicate/conflict behavior. If the raw
// content cannot be canonicalized (e.g. a lone surrogate in a wire string), the fallback still
// hashes the SAME raw content through the surrogate-escaping safe serializer — the identity stays
// deterministic for identical retry bytes and distinct for distinct bytes. A random value (e.g. a
// UUID) is never used: it would make the same invalid event re-send durably duplicated and break
// the durable-ACK guarantee.
async function quarantineIdentity(raw: Record<string, unknown>, reasonCode: string): Promise<string> {
  let rawDigest: string;
  try {
    rawDigest = await sha256Base64url(canonicalJson(raw));
  } catch {
    rawDigest = await sha256Base64url(canonicalJsonSafe(raw));
  }
  return sha256Base64url(canonicalJson({ reasonCode, rawDigest }));
}

// Quarantine uses the same allowlist as the wire contract. Unknown keys and values with the
// wrong type are omitted rather than copied or replaced with a generic string. In particular,
// arbitrary nested objects, numbers, booleans and free-form text never become durable quarantine
// data. Only schema-valid identifiers, enums, timestamps and the exact event-type payload schema
// are retained.
const SANITIZABLE_ID_FIELDS = new Set([
  'eventId', 'eventBusinessKey', 'factId', 'runId', 'nodeId', 'nodeExecutionId', 'artifactId',
  'candidateRevision', 'reviewCycleId', 'resolutionCycleId', 'workerId', 'controlRef',
  'supersedesEventId', 'sourceVersion',
]);

function isAllowedValue(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

export function sanitizeEventJson(raw: Record<string, unknown>): string {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'schemaVersion' && value === 1) sanitized[key] = value;
    else if (SANITIZABLE_ID_FIELDS.has(key) && isShortAsciiId(value)) sanitized[key] = value;
    else if (key === 'metricDefinitionVersion' && value === FIX_FUNNEL_DEFINITION_VERSION) sanitized[key] = value;
    else if (key === 'eventType' && isFunnelEventType(value)) sanitized[key] = value;
    else if (key === 'occurredAt' && validUtcIso(value)) sanitized[key] = value;
    else if (key === 'workflowId' && value === 'fix') sanitized[key] = value;
    else if (key === 'workflowDefinitionVersion' && typeof value === 'string' && WORKFLOW_DEFINITION_VERSION_PATTERN.test(value)) sanitized[key] = value;
    else if (key === 'policyDigest' && typeof value === 'string' && DIGEST_PATTERN.test(value)) sanitized[key] = value;
    else if (key === 'fixClassification' && isAllowedValue(value, FIX_CLASSIFICATIONS)) sanitized[key] = value;
    else if (key === 'bugCategory' && isAllowedValue(value, BUG_CATEGORIES)) sanitized[key] = value;
    else if (key === 'riskLevel' && isAllowedValue(value, RISK_LEVELS)) sanitized[key] = value;
    else if (key === 'stage' && isStage(value)) sanitized[key] = value;
    else if ((key === 'stageFrom' || key === 'stageTo') && isStage(value)) sanitized[key] = value;
    else if (key === 'terminalOutcome' && isAllowedValue(value, TERMINAL_OUTCOMES)) sanitized[key] = value;
    else if (key === 'dispositionOutcome' && isAllowedValue(value, DISPOSITION_OUTCOMES)) sanitized[key] = value;
    else if (key === 'resolutionType' && isAllowedValue(value, RESOLUTION_TYPES)) sanitized[key] = value;
    else if (key === 'outcome' && isAllowedValue(value, OUTCOMES)) sanitized[key] = value;
    else if (key === 'decision' && isAllowedValue(value, DECISIONS)) sanitized[key] = value;
    else if (key === 'role' && isAllowedValue(value, ROLES)) sanitized[key] = value;
    else if (key === 'reasonCode' && typeof value === 'string' && REASON_CODE_PATTERN.test(value)) sanitized[key] = value;
    else if (key === 'payload' && isPlainObject(value) && isFunnelEventType(raw.eventType)) {
      const schema = payloadSchemaFor(raw.eventType);
      const payload: Record<string, string> = {};
      for (const [payloadKey, spec] of Object.entries(schema)) {
        // own property only: inherited prototype values must never be copied into durable data
        if (!Object.hasOwn(value, payloadKey)) continue;
        const payloadValue = value[payloadKey];
        if (spec.type === 'id' && isShortAsciiId(payloadValue)) payload[payloadKey] = payloadValue;
        if (spec.type === 'text' && isShortText(payloadValue)) payload[payloadKey] = payloadValue;
      }
      if (Object.keys(payload).length > 0) sanitized[key] = payload;
    }
  }
  return canonicalJson(sanitized);
}


function safeWireString(value: string): boolean {
  return value.length <= 512 && /^[\x20-\x7e]*$/.test(value);
}