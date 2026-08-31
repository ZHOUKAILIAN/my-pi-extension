import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  businessKey,
  canonicalHash,
  sanitizeEventJson,
  validateEvent,
  type FunnelEventType,
} from '../src/events.ts';
import { canonicalJson } from '../src/canonical.ts';
import { fixedNow, syntheticRunEvents, FIXED_NOW } from './helpers.ts';

// Shared validation context and assertion helper used by every describe below (the helper is
// defined once here rather than per-describe so the quarantine block can reuse it too).
const ctx = { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 };

async function expectPermanent(input: unknown, code: string): Promise<void> {
  const out = await validateEvent(input, ctx);
  assert.deepEqual(out, { kind: 'permanent', errorCode: code });
}

async function expectQuarantine(input: unknown, code: string): Promise<void> {
  const out = await validateEvent(input, ctx);
  assert.equal(out.kind, 'quarantine');
  if (out.kind !== 'quarantine') return;
  assert.equal(out.errorCode, code);
  assert.ok(out.record.receivedAt);
  assert.ok(out.record.eventJson.length > 0);
}

describe('validateEvent — accepted events', () => {
  const types: FunnelEventType[] = [
    'run_started',
    'investigation_review_passed',
    'resolution_completed',
    'verification_passed',
    'run_accepted',
  ];

  for (const type of types) {
    it(`accepts a contract-valid ${type}`, async () => {
      const index = types.indexOf(type);
      const ev = syntheticRunEvents({ seed: 'ok', reached: (index + 1) as 1 | 2 | 3 | 4 | 5 })[index];
      const outcome = await validateEvent(ev, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
      assert.equal(outcome.kind, 'ok');
      if (outcome.kind !== 'ok') return;
      assert.ok(outcome.eventBusinessKey.length > 0);
      assert.ok(outcome.eventCanonicalHash.length > 0);
      assert.equal(outcome.event.eventType, type);
      assert.equal(outcome.event.payloadJson, canonicalJson(ev.payload ?? {}));
    });
  }

  it('rejects the same wire bytes with a client-supplied wrong business key', async () => {
    const [ev] = syntheticRunEvents({ seed: 'key' });
    const outcome = await validateEvent({ ...ev, eventBusinessKey: 'not-the-server-key' }, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    assert.deepEqual(outcome, { kind: 'permanent', errorCode: 'business_key_mismatch' });
  });

  it('accepts a client-supplied correct business key', async () => {
    const [ev] = syntheticRunEvents({ seed: 'key2' });
    const computed = await validateEvent(ev, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    assert.equal(computed.kind, 'ok');
    if (computed.kind !== 'ok') return;
    const again = await validateEvent({ ...ev, eventBusinessKey: computed.eventBusinessKey }, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    assert.equal(again.kind, 'ok');
  });

  it('canonical hash covers timestamps while the business key does not', async () => {
    const [ev] = syntheticRunEvents({ seed: 'skew' });
    const a = await validateEvent(ev, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    const b = await validateEvent(
      { ...ev, occurredAt: new Date(Date.parse(ev.occurredAt) + 60_000).toISOString() },
      { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 },
    );
    assert.equal(a.kind, 'ok');
    assert.equal(b.kind, 'ok');
    if (a.kind !== 'ok' || b.kind !== 'ok') return;
    assert.equal(a.eventBusinessKey, b.eventBusinessKey); // key = factId + type + payload only
    assert.notEqual(a.eventCanonicalHash, b.eventCanonicalHash); // hash covers occurredAt
  });
});

describe('validateEvent — permanent errors (schema/enum/union)', () => {
  const [run] = syntheticRunEvents({ seed: 'perm' });

  it('unknown event type', () => expectPermanent({ ...run, eventType: 'nuke_all' }, 'unknown_event_type'));
  it('unsupported schema version', () => expectPermanent({ ...run, schemaVersion: 2 }, 'unsupported_schema_version'));
  it('unsupported definition version', () =>
    expectPermanent({ ...run, metricDefinitionVersion: 'fix-funnel-v0' }, 'unsupported_definition_version'));
  it('unknown top-level field (no raw text extension)', () => expectPermanent({ ...run, extraNotes: 'buy more milk' }, 'unknown_top_level_field'));
  it('invalid closed enum (riskLevel)', () => expectPermanent({ ...run, riskLevel: 'urgent' }, 'invalid_enum_value'));
  it('invalid workflow id', () => expectPermanent({ ...run, workflowId: 'sync' }, 'invalid_enum_value'));
  it('invalid role', () => expectPermanent({ ...run, role: 'boss' }, 'invalid_enum_value'));
  it('run_started union: wrong stage', () => expectPermanent({ ...run, stage: 'RESOLUTION' }, 'invalid_enum_value'));
  it('run_started union: confirmed classification still requires unclassified at start', () =>
    expectPermanent({ ...run, fixClassification: 'regression' }, 'invalid_union_shape'));
  it('free-form fixClassification is rejected by the closed enum', () =>
    expectPermanent({ ...run, fixClassification: 'made_up_label' }, 'invalid_enum_value'));
  it('invalid resolution branch', async () => {
    const [, , res] = syntheticRunEvents({ seed: 'perm4', reached: 5 });
    await expectPermanent({ ...res, resolutionType: 'reboot_everything' }, 'invalid_enum_value');
  });
  it('missing required field', async () => {
    const [, , , , acc] = syntheticRunEvents({ seed: 'perm2', reached: 5 });
    const { controlRef: _drop, ...rest } = acc;
    void _drop;
    await expectPermanent(rest, 'missing_required_field');
  });
  // payload that is not a plain object fails the required-field payload guard before the
  // shape checks below can run, so the documented code is missing_required_field
  it('payload is not an object', () => expectPermanent({ ...run, payload: 'oops' }, 'invalid_field_type'));
  it('unknown payload field', () => expectPermanent({ ...run, payload: { reasoning: 'because power' } }, 'unknown_payload_field'));
  it('payload constructor key is rejected by the own-property schema check', () =>
    expectPermanent({ ...run, payload: { constructor: 'x' } }, 'unknown_payload_field'));
  it('payload toString key is rejected by the own-property schema check', () =>
    expectPermanent({ ...run, payload: { toString: 'evil' } }, 'unknown_payload_field'));
  it('payload valueOf key is rejected by the own-property schema check', () =>
    expectPermanent({ ...run, payload: { valueOf: 1 } }, 'unknown_payload_field'));
  it('payload __proto__ own property (JSON.parse) is rejected and never persisted', async () => {
    // JSON.parse creates __proto__ as an OWN property; it must be treated like any other unknown
    // field, and since the outcome is permanent nothing about it is ever durably stored.
    const wire = JSON.parse(
      JSON.stringify({ ...run, payload: {} }),
    ) as Record<string, unknown>;
    wire.payload = JSON.parse('{"__proto__": {"admin": true}}');
    await expectPermanent(wire, 'unknown_payload_field');
  });
  it('unknown payload fields (including prototype keys) never reach the accepted payloadJson', async () => {
    const valid = await validateEvent({ ...run, payload: {} }, ctx);
    assert.equal(valid.kind, 'ok');
    if (valid.kind !== 'ok') return;
    assert.ok(!valid.event.payloadJson.includes('constructor'));
    assert.ok(!valid.event.payloadJson.includes('toString'));
    assert.ok(!valid.event.payloadJson.includes('__proto__'));
  });
  it('missing required payload field (resolutionEvidenceRef)', async () => {
    const [, , res] = syntheticRunEvents({ seed: 'perm3', reached: 5 });
    await expectPermanent({ ...res, payload: {} }, 'missing_required_field');
  });
  it('required payload field cannot be satisfied through the prototype chain (Object.create)', async () => {
    // Regression: an inherited resolutionEvidenceRef used to pass validation while the persisted
    // payloadJson (own enumerable properties only) silently omitted the required evidence.
    const [, , res] = syntheticRunEvents({ seed: 'proto1', reached: 5 });
    const inherited = Object.create({ resolutionEvidenceRef: 'rev-proto1' }) as Record<string, unknown>;
    await expectPermanent({ ...res, payload: inherited }, 'missing_required_field');
  });
  it('accepted payloadJson always carries the required evidence as an own property', async () => {
    const [, , res] = syntheticRunEvents({ seed: 'own1', reached: 5 });
    const out = await validateEvent(res, ctx);
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    const parsed = JSON.parse(out.event.payloadJson) as Record<string, unknown>;
    assert.equal(Object.hasOwn(parsed, 'resolutionEvidenceRef'), true);
    assert.equal(parsed.resolutionEvidenceRef, 'rev-own1');
  });
  it('not an event at all', () => expectPermanent('temperature celsius', 'not_an_event'));
  it('verification_passed without any evidence/version binding is permanent (empty payload)', async () => {
    const [, , , ver] = syntheticRunEvents({ seed: 'vev1', reached: 4 });
    await expectPermanent({ ...ver, payload: {} }, 'missing_required_field');
  });
  it('verification_passed cannot satisfy the evidence binding through the prototype chain', async () => {
    const [, , , ver] = syntheticRunEvents({ seed: 'vev2', reached: 4 });
    const inherited = Object.create({ resolutionEvidenceRef: 'rev-vev2' }) as Record<string, unknown>;
    await expectPermanent({ ...ver, payload: inherited }, 'missing_required_field');
  });
  it('verification_passed binds via candidateRevision, sourceVersion or payload evidence', async () => {
    const [, , , ver] = syntheticRunEvents({ seed: 'vev3', reached: 4 });
    for (const binding of [
      { payload: {}, candidateRevision: 'rev-candidate' },
      { payload: {}, sourceVersion: 'git:abc123' },
      { payload: { resolutionEvidenceRef: 'rev-evidence' } },
    ]) {
      const out = await validateEvent({ ...ver, ...binding }, ctx);
      assert.equal(out.kind, 'ok', `expected ok for binding ${JSON.stringify(binding)}`);
    }
  });
});

describe('validateEvent — quarantine (time safety + content safety)', () => {
  const [run] = syntheticRunEvents({ seed: 'quar' });

  it('invalid occurredAt format', () =>
    expectQuarantine({ ...run, occurredAt: '2026-08-01' }, 'invalid_occurred_at'));
  it('late event (beyond 24h window)', () =>
    expectQuarantine(
      { ...run, occurredAt: new Date(FIXED_NOW.getTime() - 25 * 60 * 60 * 1000).toISOString() },
      'late_event',
    ));
  it('future event (beyond 5min skew)', () =>
    expectQuarantine(
      { ...run, occurredAt: new Date(FIXED_NOW.getTime() + 10 * 60 * 1000).toISOString() },
      'future_event',
    ));
  it('unsafe eventId (non-ASCII)', () => expectQuarantine({ ...run, eventId: 'e\u4e2d\u6587' }, 'unsafe_content'));
  it('oversized policyDigest (no raw business text)', () =>
    expectQuarantine({ ...run, policyDigest: 'x'.repeat(600) }, 'unsafe_content'));
  it('unsafe payload id', async () => {
    const [, , res] = syntheticRunEvents({ seed: 'quar2', reached: 5 });
    await expectQuarantine({ ...res, payload: { resolutionEvidenceRef: '中文' } }, 'unsafe_content');
  });

  it('free-form reference fields are rejected (no free text in ids)', async () => {
    await expectQuarantine({ ...run, controlRef: 'some free text reference' }, 'unsafe_content');
    await expectQuarantine({ ...run, runId: 'run with spaces' }, 'unsafe_content');
    await expectQuarantine({ ...run, reviewCycleId: '中文 cycle' }, 'unsafe_content');
    await expectQuarantine({ ...run, resolutionCycleId: '' }, 'unsafe_content');
  });

  it('closed enums reject free-form values on structured axes', async () => {
    await expectPermanent({ ...run, outcome: 'passsed' }, 'invalid_enum_value');
    await expectPermanent({ ...run, decision: 'maybe' }, 'invalid_enum_value');
    await expectPermanent({ ...run, terminalOutcome: 'done' }, 'invalid_enum_value');
    await expectPermanent({ ...run, dispositionOutcome: 'approved_as_is' }, 'invalid_enum_value');
    // waitReason is NOT a top-level field of the five public funnel events: it belongs to the
    // future run_stage_changed / waiting-stage slice, so a wire event carrying it is rejected
    // by the unknown-field sweep (covered by the 'unknown top-level field' test above).
  });

  it('reasonCode over the 64-char bound is unsafe', () =>
    expectQuarantine({ ...run, reasonCode: 'R'.repeat(65) }, 'unsafe_content'));

  it('quarantine identities are unique per unrelated event, never shared sentinels', async () => {
    // identical safe metadata, different raw content: both must be independently durable
    const a = await validateEvent({ ...run, eventId: 'e\u4e2d\u6587', runId: 'run\u4e2d-1' }, ctx);
    const b = await validateEvent({ ...run, eventId: 'e\u4e2d\u6587', runId: 'run\u4e2d-2' }, ctx);
    assert.equal(a.kind, 'quarantine');
    assert.equal(b.kind, 'quarantine');
    if (a.kind !== 'quarantine' || b.kind !== 'quarantine') return;
    assert.notEqual(a.record.eventId, '[redacted]');
    assert.notEqual(b.record.eventId, '[redacted]');
    assert.notEqual(a.record.eventId, b.record.eventId);
    assert.notEqual(a.record.eventBusinessKey, '[unkeyed]');
    assert.notEqual(a.record.eventBusinessKey, b.record.eventBusinessKey);
    assert.notEqual(a.record.eventCanonicalHash, '[unkeyed]');
    assert.notEqual(a.record.eventCanonicalHash, b.record.eventCanonicalHash);
    assert.match(a.record.eventId, /^qz_/);
    assert.match(a.record.eventBusinessKey, /^qzk_/);
  });

  it('the exact same quarantined event maps to the same server-side identity (duplicate path)', async () => {
    const wire = { ...run, eventId: 'e\u4e2d\u6587', runId: 'run\u4e2d' };
    const a = await validateEvent(wire, ctx);
    const b = await validateEvent(wire, ctx);
    assert.equal(a.kind, 'quarantine');
    assert.equal(b.kind, 'quarantine');
    if (a.kind !== 'quarantine' || b.kind !== 'quarantine') return;
    assert.equal(a.record.eventId, b.record.eventId);
    assert.equal(a.record.eventBusinessKey, b.record.eventBusinessKey);
    assert.equal(a.record.eventCanonicalHash, b.record.eventCanonicalHash);
  });

  it('quarantine retains a safe runId and drops an unsafe one (no raw text persisted)', async () => {
    const safe = await validateEvent({ ...run, policyDigest: 'x'.repeat(600), runId: 'run-quar' }, ctx);
    assert.equal(safe.kind, 'quarantine');
    if (safe.kind !== 'quarantine') return;
    assert.equal(safe.record.runId, 'run-quar');
    const unsafe = await validateEvent({ ...run, policyDigest: 'x'.repeat(600), runId: 'run \u4e2d\u6587' }, ctx);
    assert.equal(unsafe.kind, 'quarantine');
    if (unsafe.kind !== 'quarantine') return;
    assert.equal(unsafe.record.runId, undefined);
    assert.ok(!unsafe.record.eventJson.includes('\u4e2d\u6587'));
  });

  it('quarantine storage never contains raw business text', async () => {
    const [ev] = syntheticRunEvents({ seed: 'redact' });
    const secret = 'VERY-SECRET-MARKER-' + 'y'.repeat(520); // above the 512 wire limit -> quarantine
    const out = await validateEvent({ ...ev, policyDigest: `digest-${secret}` }, ctx);
    assert.equal(out.kind, 'quarantine');
    if (out.kind !== 'quarantine') return;
    assert.equal(out.errorCode, 'unsafe_content');
    assert.ok(!out.record.eventJson.includes('VERY-SECRET-MARKER'));
    const parsed = JSON.parse(out.record.eventJson) as Record<string, unknown>;
    assert.equal(parsed.policyDigest, undefined);
    assert.equal(parsed.eventId, out.record.eventId);
  });
});

describe('businessKey / canonicalHash determinism', () => {
  it('same payload twice yields the same key and hash', async () => {
    const [ev] = syntheticRunEvents({ seed: 'stable' });
    const out = await validateEvent(ev, { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    const again = await businessKey(out.event);
    const hashAgain = await canonicalHash(out.event);
    assert.equal(again, out.eventBusinessKey);
    assert.equal(hashAgain, out.eventCanonicalHash);
  });

  it('canonical hash never includes the internal payloadJson column', async () => {
    // Two events whose payload objects are semantically identical but serialized differently in
    // the internal payloadJson column must produce the same canonical hash (and business key).
    const out = await validateEvent(syntheticRunEvents({ seed: 'pq1' })[0], { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    const a = { ...out.event, payloadJson: '{"b":2,"a":1}' };
    const b = { ...out.event, payloadJson: '{"a":1,"b":2}' };
    assert.equal(await canonicalHash(a), await canonicalHash(b));
    assert.equal(await businessKey(a), await businessKey(b));
  });

  it('receivedAt (transport metadata) never enters the canonical hash', async () => {
    const out = await validateEvent(syntheticRunEvents({ seed: 'rx1' })[0], { now: fixedNow(), futureSkewMs: 5 * 60 * 1000, lateEventWindowMs: 24 * 60 * 60 * 1000 });
    assert.equal(out.kind, 'ok');
    if (out.kind !== 'ok') return;
    const shifted = await canonicalHash({ ...out.event, receivedAt: '2026-08-02T00:00:00.000Z' });
    assert.equal(shifted, out.eventCanonicalHash);
  });
});

describe('sanitizeEventJson', () => {
  it('omits arbitrary keys and unsafe scalar/nested values', () => {
    const parsed = JSON.parse(sanitizeEventJson({ eventId: 'evt-1', note: 'hello', count: 42, flag: true, nested: { secret: 'x' } })) as Record<string, unknown>;
    assert.deepEqual(parsed, { eventId: 'evt-1' });
  });
});