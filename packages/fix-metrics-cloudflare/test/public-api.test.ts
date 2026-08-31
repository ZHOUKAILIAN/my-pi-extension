import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { derivePublicStatus } from '../src/public-api.ts';
import type { FunnelSnapshotPayload } from '../src/projection.ts';

function payload(overrides: Partial<FunnelSnapshotPayload> = {}): FunnelSnapshotPayload {
  return {
    snapshotId: 's_test', parentSnapshotId: null, rebuildTaskId: null, definitionVersion: 'fix-funnel-v1',
    windowStart: '2026-08-01T00:00:00.000Z', windowEnd: '2026-09-01T00:00:00.000Z', snapshotAt: '2026-09-01T00:00:00.000Z',
    maturityAt: '2026-10-01T00:00:00.000Z', totalRuns: 5,
    steps: ['run_started', 'investigation_review_passed', 'resolution_completed', 'verification_passed', 'run_accepted'].map((eventType) => ({ eventType, runs: 5, fromPreviousRate: 1 })),
    resolutionTypes: { code_change: 5 }, dropOffReasons: [],
    dataQuality: { incompleteRuns: 0, lateEvents: 0, invalidEvents: 0, lateEventRuns: 0, invalidEventRuns: 0, lowSampleProtected: false }, dataFreshnessSeconds: 0,
    ...overrides,
  };
}

describe('public low-sample protection', () => {
  it('protects a singleton data-quality group', () => {
    assert.equal(derivePublicStatus(payload({ dataQuality: { incompleteRuns: 1, lateEvents: 0, invalidEvents: 0, lateEventRuns: 0, invalidEventRuns: 0, lowSampleProtected: false } }), 5), 'low_sample_protected');
    assert.equal(derivePublicStatus(payload({ dataQuality: { incompleteRuns: 0, lateEvents: 1, invalidEvents: 0, lateEventRuns: 1, invalidEventRuns: 0, lowSampleProtected: false } }), 5), 'low_sample_protected');
    assert.equal(derivePublicStatus(payload({ dataQuality: { incompleteRuns: 0, lateEvents: 0, invalidEvents: 1, lateEventRuns: 0, invalidEventRuns: 1, lowSampleProtected: false } }), 5), 'low_sample_protected');
  });

  it('protects a future drop-off group without leaking its reason', () => {
    assert.equal(derivePublicStatus(payload({ dropOffReasons: [{ reasonCode: 'not_reached_run_accepted', runs: 1 }] }), 5), 'low_sample_protected');
  });

  it('data-quality protection uses deduplicated run units, not event/row counts', () => {
    // many late rows but a single affected run: the run unit is below k -> protected
    assert.equal(derivePublicStatus(payload({ dataQuality: { incompleteRuns: 0, lateEvents: 7, invalidEvents: 0, lateEventRuns: 1, invalidEventRuns: 0, lowSampleProtected: false } }), 5), 'low_sample_protected');
    // many invalid rows but a single attributable run -> still protected
    assert.equal(derivePublicStatus(payload({ dataQuality: { incompleteRuns: 0, lateEvents: 0, invalidEvents: 9, lateEventRuns: 0, invalidEventRuns: 1, lowSampleProtected: false } }), 5), 'low_sample_protected');
    // five distinct affected runs reach k -> calculable even though row counts differ
    assert.equal(derivePublicStatus(payload({ dataQuality: { incompleteRuns: 0, lateEvents: 6, invalidEvents: 5, lateEventRuns: 5, invalidEventRuns: 5, lowSampleProtected: false } }), 5), 'calculable');
  });

  it('unattributable quality records are suppressed from run units', () => {
    // quarantines without a safe runId never create pseudo sample units: the group stays empty
    assert.equal(derivePublicStatus(payload({ dataQuality: { incompleteRuns: 0, lateEvents: 0, invalidEvents: 9, lateEventRuns: 0, invalidEventRuns: 0, lowSampleProtected: false } }), 5), 'calculable');
  });
});
