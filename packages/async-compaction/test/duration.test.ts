import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager, buildSessionProjection, convertToLlm, estimateTokens } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { CompactionDurationObserver, formatCompactionPresentation, installCompactionDurationObserver } from '../src/duration.ts';
import { formatCompactionDuration, validateCompactionDuration } from '../src/duration-schema.ts';

const id = 'f1c3b1a2-5435-4d4a-8bcb-233fa8d946a1';
test('duration formatting uses milliseconds below one second and readable seconds/minutes above it', () => {
  const record = (durationMs: number) => ({ schemaVersion: 1, operationId: id, compactionEntryId: 'entry', reason: 'manual', outcome: 'completed', durationMs });
  assert.equal(formatCompactionDuration(record(42)), '压缩阶段耗时：42ms');
  assert.equal(formatCompactionDuration(record(1250)), '压缩阶段耗时：1.3s');
  assert.equal(formatCompactionDuration(record(61_000)), '压缩阶段耗时：1m 1s');
  assert.equal(formatCompactionDuration(record(119_600)), '压缩阶段耗时：2m 0s', 'rounding never emits a minute followed by 60 seconds');
});

test('presentation distinguishes sources, independent phases, zero/increase effects and legacy/unknown history', () => {
  const base = { schemaVersion: 2, operationId: id, compactionEntryId: 'new', reason: 'threshold', outcome: 'completed', durationMs: 42, backgroundGenerationMs: 80_000, tokensBefore: 1000, tokensAfter: 900, releasedTokens: 100, reductionPercent: 10 };
  assert.match(formatCompactionPresentation({ ...base, source: 'async' }), /已采用后台摘要.*前台压缩阶段耗时：42ms.*后台摘要生成：1m 20s/u);
  const badAssociation = formatCompactionPresentation({ ...base, source: 'async' }, false);
  assert.equal(badAssociation, '前台压缩阶段耗时：未知 (关联压缩不可用)');
  assert.doesNotMatch(badAssociation, /已采用后台摘要|后台摘要生成|tokens|减少/u);
  assert.equal(validateCompactionDuration({ ...base, source: 'async', tokensBefore: 1000, tokensAfter: 900, releasedTokens: 800, reductionPercent: 80 }), undefined, 'inconsistent release and percentage are rejected');
  assert.equal(validateCompactionDuration({ ...base, source: 'async', outcome: 'failed' }), undefined, 'failed v2 rows cannot claim adoption or effects');
  assert.equal(validateCompactionDuration({ ...base, source: 'async', tokensBefore: 0, tokensAfter: 0, releasedTokens: 0, reductionPercent: 0 }), undefined, 'invalid zero denominator cannot be rendered as 0%');
  for (const damaged of [{ ...base, source: ['native'] }, { ...base, source: { value: 'native' } }, { ...base, reason: ['threshold'] }, { ...base, outcome: { value: 'completed' } }]) {
    assert.equal(validateCompactionDuration(damaged), undefined, 'schema v2 enum fields must be primitive strings');
  }
  assert.match(formatCompactionPresentation({ ...base, source: 'native', backgroundGenerationMs: null }), /由原生压缩完成/u);
  assert.match(formatCompactionPresentation({ ...base, source: 'other', backgroundGenerationMs: null }), /由其他扩展完成/u);
  assert.ok(validateCompactionDuration({ ...base, source: 'async', tokensBefore: 1000, tokensAfter: 1000, releasedTokens: 0, reductionPercent: 0 }), 'a genuine zero delta is valid and distinct from missing estimates');
  assert.match(formatCompactionPresentation({ ...base, source: 'async', tokensBefore: 1000, tokensAfter: 1000, releasedTokens: 0, reductionPercent: 0 }), /未减少/u);
  assert.match(formatCompactionPresentation({ ...base, source: 'native', backgroundGenerationMs: null, tokensBefore: 1000, tokensAfter: 1100, releasedTokens: -100, reductionPercent: -10 }), /增加 100 tokens/u);
  assert.match(formatCompactionPresentation({ ...base, source: 'unknown', backgroundGenerationMs: null, tokensBefore: null, tokensAfter: null, releasedTokens: null, reductionPercent: null }), /上下文变化：未知/u);
  const legacy = { schemaVersion: 1, operationId: id, compactionEntryId: 'old', reason: 'manual', outcome: 'completed', durationMs: 7 };
  assert.equal(formatCompactionPresentation(legacy), '压缩阶段耗时：7ms', 'v1 history renders without migration or synthesized effect data');
  assert.equal(formatCompactionPresentation({ ...legacy, durationMs: -1 }), '压缩阶段耗时：未知');
});

test('observer consumes terminal by operation scope, reason and active branch delta rather than event pointer', () => {
  let now = 100; const branch: any[] = [{ id: 'old-compaction', type: 'compaction' }]; const records: any[] = [], renderers = new Map<string, Function>();
  const pi = { registerEntryRenderer: (name: string, renderer: Function) => renderers.set(name, renderer), appendEntry: (type: string, data: unknown) => records.push({ type, data }) } as any;
  const observer = new CompactionDurationObserver(pi, () => now, () => id);
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 's', getBranch: () => branch } } as any;
  observer.setBranch(ctx);
  observer.before({ reason: 'threshold' }, ctx);
  now = 1234; branch.push({ id: 'inserted-custom', type: 'custom' }, { id: 'new-compaction', type: 'compaction', summary: 'same summary' });
  observer.compact({ reason: 'threshold', compactionEntry: branch[0] }, ctx);
  observer.compact({ reason: 'threshold', compactionEntry: branch[0] }, ctx);
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'compaction-duration');
  assert.deepEqual(records[0].data, { schemaVersion: 2, operationId: id, compactionEntryId: 'new-compaction', reason: 'threshold', outcome: 'completed', durationMs: 1134, source: 'unknown', backgroundGenerationMs: null, tokensBefore: null, tokensAfter: null, releasedTokens: null, reductionPercent: null });
  const renderer: any = renderers.get('compaction-duration');
  assert.match(renderer({ data: records[0].data }, {}, { fg: (_c: string, text: string) => text }).render(80).join(''), /前台压缩阶段耗时：1\.1s/u);
  branch.pop(); observer.setBranch(ctx);
  const unassociated = renderer({ data: records[0].data }, {}, { fg: (_c: string, text: string) => text }).render(80).join('').trim();
  assert.equal(unassociated, '前台压缩阶段耗时：未知 (关联压缩不可用)', 'renderer association failure suppresses source, backend time, and effects');
});

test('one-sided token estimation failures preserve successful phase timing and normalize all effects to unknown', () => {
  for (const failedEstimate of [1, 2]) {
    const sm = SessionManager.inMemory(`/tmp/async-duration-one-sided-${failedEstimate}`);
    const userId = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'user context '.repeat(40) }], timestamp: Date.now() });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(20) }], api: 'fake-api', provider: 'fake', model: 'm', stopReason: 'stop', timestamp: Date.now() });
    let now = 10, systemReads = 0; const records: any[] = [];
    const pi = { registerEntryRenderer() {}, appendEntry: (_type: string, data: unknown) => records.push(data), getAllTools: () => [], getActiveTools: () => [] } as any;
    const ctx = { mode: 'tui', sessionManager: sm, getSystemPrompt: () => { if (++systemReads === failedEstimate) throw Error('fallback unavailable'); return 'live system'; } } as any;
    const observer = new CompactionDurationObserver(pi, () => now, () => id);
    observer.setBranch(ctx); observer.before({ reason: 'manual' }, ctx);
    now += 40;
    sm.appendCompaction('other extension summary', userId, 1200, { kind: 'other-extension' }, true);
    observer.compact({ reason: 'manual' }, ctx);
    observer.compact({ reason: 'manual' }, ctx);
    assert.equal(records.length, 1, `failed estimate ${failedEstimate}: successful terminal is persisted once despite duplicate terminal`);
    assert.equal(records[0].durationMs, 40, `failed estimate ${failedEstimate}: reliable foreground duration survives`);
    assert.equal(records[0].source, 'other');
    assert.equal(records[0].tokensBefore, null);
    assert.equal(records[0].tokensAfter, null);
    assert.equal(records[0].releasedTokens, null);
    assert.equal(records[0].reductionPercent, null);
    const rendered = formatCompactionPresentation(records[0]);
    assert.match(rendered, /前台压缩阶段耗时：40ms/u);
    assert.match(rendered, /上下文变化：未知/u);
    assert.doesNotMatch(rendered, /释放|减少|增加/u);
  }
});

test('adopted background duration is trusted only when its complete local TimingSample validates', () => {
  const good = { schemaVersion: 1, sampleId: 'sample-1', kind: 'background_generation', startedAtUTC: new Date(1000).toISOString(), durationMs: 100, outcome: 'completed', model: 'm', provider: 'p', attemptId: 'attempt-1' };
  const cases = [
    ['valid', good, 100], ['schema', { ...good, schemaVersion: 999 }, null], ['clock', { ...good, startedAtUTC: null }, null],
    ['sample id', { ...good, sampleId: [] }, null], ['duration', { ...good, durationMs: -1 }, null], ['outcome', { ...good, outcome: ['completed'] }, null],
  ] as const;
  for (const [name, timing, expected] of cases) {
    const sm = SessionManager.inMemory(`/tmp/async-duration-timing-${name.replaceAll(' ', '-')}`);
    const userId = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'user context '.repeat(40) }], timestamp: Date.now() });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(20) }], api: 'fake-api', provider: 'fake', model: 'm', stopReason: 'stop', timestamp: Date.now() });
    sm.appendCustomEntry('async-compact-timing', timing);
    const records: any[] = [], pi = { registerEntryRenderer() {}, appendEntry: (_type: string, data: unknown) => records.push(data), getAllTools: () => [], getActiveTools: () => [] } as any;
    const ctx = { mode: 'tui', sessionManager: sm, getSystemPrompt: () => 'system' } as any;
    const observer = new CompactionDurationObserver(pi, () => 10, () => id);
    observer.setBranch(ctx); observer.before({ reason: 'threshold' }, ctx);
    sm.appendCompaction('accepted summary', userId, 1200, { kind: 'async-compact', version: 1, attemptId: 'attempt-1' }, true);
    observer.compact({ reason: 'threshold' }, ctx, 'attempt-1');
    assert.equal(records.length, 1, `${name}: actual adoption still persists one successful duration record`);
    assert.equal(records[0].source, 'async', `${name}: timing corruption cannot rewrite Controller adoption`);
    assert.equal(records[0].backgroundGenerationMs, expected, `${name}: only a fully valid correlated TimingSample contributes a numeric background time`);
    const presentation = formatCompactionPresentation(records[0]);
    if (expected === null) assert.match(presentation, /后台摘要生成：未知/u, `${name}: aggregate display degrades to unknown`);
    else assert.match(presentation, /后台摘要生成：100ms/u);
  }
});

test('other-hook effect uses commit-boundary canonical system/tools, summary wrapper and effective context edits', () => {
  const sm = SessionManager.inMemory('/tmp/async-duration-other-hook');
  const tool = { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
  sm.appendMessage({ role: 'system', content: 'system A '.repeat(24), sections: { policy: 'section A '.repeat(12) }, toolsAdded: [tool], timestamp: Date.now() } as any);
  const userId = sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'original constraint '.repeat(40) }], timestamp: Date.now() });
  sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'answer '.repeat(20) }], api: 'fake-api', provider: 'fake', model: 'm', stopReason: 'stop', timestamp: Date.now() });
  sm.appendContextEdit(userId, { content: [{ type: 'text', text: 'edited constraint '.repeat(80) }] });
  let now = 20; const records: any[] = [];
  const observer = new CompactionDurationObserver({ registerEntryRenderer() {}, appendEntry: (_type: string, data: unknown) => records.push(data), getAllTools: () => [tool], getActiveTools: () => ['read'] } as any, () => now, () => id);
  const ctx = { mode: 'tui', sessionManager: sm, getSystemPrompt: () => { throw Error('live system must not replace present transcript checkpoint'); }, hasPendingMessages: () => false } as any;
  const estimate = (entries: any[]) => {
    const messages = buildSessionProjection(entries).messages;
    const checkpoint = getCurrentSystemMessage(messages);
    assert.ok(checkpoint, 'fixture has a canonical system checkpoint');
    const conversation = convertToLlm(messages).filter(message => message.role !== 'system');
    return estimateTokens(checkpoint) + conversation.reduce((sum, message) => sum + estimateTokens(message), 0);
  };
  observer.setBranch(ctx); observer.before({ reason: 'manual' }, ctx);
  now = 80;
  sm.appendMessage({ role: 'system', content: 'system B '.repeat(40), sections: { policy: 'section B '.repeat(24) }, toolsAdded: [{ ...tool, description: 'changed tool declaration '.repeat(8) }], timestamp: Date.now() } as any);
  const beforeCommit = sm.getBranch();
  const cut = userId;
  sm.appendCompaction('other extension summary '.repeat(12), cut, 1200, { kind: 'other-extension' }, true);
  const atCommit = sm.getBranch(), compactIndex = atCommit.findIndex(entry => entry.type === 'compaction');
  const expectedBefore = estimate(atCommit.slice(0, compactIndex));
  const submittedEntries = atCommit.slice(0, compactIndex + 1);
  const expectedAfter = estimate(submittedEntries);
  assert.notEqual(expectedBefore, expectedAfter, 'the wrapped compaction summary changes the model-visible estimate');
  sm.appendContextEdit(userId, { content: [{ type: 'text', text: 'late post-commit context edit '.repeat(140) }] });
  sm.appendMessage({ role: 'system', content: 'post-commit system C '.repeat(100), timestamp: Date.now() } as any);
  sm.appendCustomMessageEntry('post-commit', 'custom_message after compaction '.repeat(80), true);
  const fullAfterHandlers = estimate(sm.getBranch());
  assert.notEqual(fullAfterHandlers, expectedAfter, 'post-commit context/system/custom-message appends would change the estimate if included');
  observer.compact({ reason: 'manual', compactionEntry: beforeCommit[0] }, ctx);
  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'other', 'fromHook without Controller strict adoption proof belongs to another source');
  assert.equal(records[0].tokensBefore, expectedBefore, 'before estimates are from the actual branch immediately before the submitted compaction');
  assert.equal(records[0].tokensAfter, expectedAfter, 'after estimate is frozen at the committed compaction boundary, excluding later terminal-handler appends');
  assert.equal(records[0].releasedTokens, expectedBefore - expectedAfter);
  assert.equal(records[0].reductionPercent, (expectedBefore - expectedAfter) / expectedBefore * 100);
});

test('observer does not persist orphan terminals, rejects mismatched reasons and uses unknown for invalid clocks', () => {
  let now = 5; const branch: any[] = [{ id: 'source', type: 'message' }], records: any[] = []; let counter = 0;
  const observer = new CompactionDurationObserver({ registerEntryRenderer() {}, appendEntry: (_type: string, data: unknown) => records.push(data) } as any, () => now, () => `f1c3b1a2-5435-4d4a-8bcb-${String(++counter).padStart(12, '0')}`);
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 's', getBranch: () => branch } } as any;
  observer.compact({ reason: 'manual' }, ctx); assert.equal(records.length, 0);
  observer.before({ reason: 'manual' }, ctx); observer.compact({ reason: 'threshold' }, ctx);
  assert.equal(records[0].outcome, 'unknown'); assert.equal(records[0].unknownReason, 'ambiguous_terminal');
  observer.before({ reason: 'overflow' }, ctx); now = Number.NaN; observer.failed({ reason: 'overflow', aborted: true }, ctx);
  assert.equal(records[1].outcome, 'unknown'); assert.equal(records[1].unknownReason, 'clock_invalid');
  observer.before({ reason: 'threshold' }, ctx); observer.leave(ctx);
  assert.equal(records[2].outcome, 'unknown'); assert.equal(records[2].unknownReason, 'scope_left');
});

test('failed branch snapshots, sibling leaves, empty scopes and observer reinstallation stay non-numeric and isolated', () => {
  const records: any[] = [], renderers: Function[] = []; let failBranch = false, sessionId = 'valid-session', now = 10, sequence = 0;
  const pi = { registerEntryRenderer: (_name: string, renderer: Function) => renderers.push(renderer), appendEntry: (_type: string, data: unknown) => records.push(data) } as any;
  const observer = installCompactionDurationObserver(pi, () => now);
  assert.equal(installCompactionDurationObserver(pi), observer);
  assert.equal(renderers.length, 1, 'same host object cannot register duplicate renderers');
  const branch: any[] = [{ id: 'start', type: 'message' }];
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => sessionId, getBranch: () => { if (failBranch) throw Error('branch failure'); return branch; } } } as any;
  observer.setBranch(ctx);
  observer.before({ reason: 'manual' }, ctx); failBranch = true; now = 20; observer.compact({ reason: 'manual' }, ctx);
  assert.equal(records[0].outcome, 'unknown'); assert.equal(records[0].unknownReason, 'ambiguous_terminal');
  failBranch = false; observer.before({ reason: 'threshold' }, ctx); branch.splice(0, branch.length, { id: 'sibling', type: 'message' }); now = 30; observer.compact({ reason: 'threshold' }, ctx);
  assert.equal(records[1].outcome, 'unknown', 'a start leaf absent from current branch is fenced');
  sessionId = ''; observer.before({ reason: 'overflow' }, ctx); observer.compact({ reason: 'overflow' }, ctx);
  assert.equal(records.length, 2, 'empty session ids cannot establish or persist an operation scope');
  const duplicateEvent = { reason: 'manual' }; sessionId = 'valid-session'; observer.before(duplicateEvent, ctx); observer.before(duplicateEvent, ctx);
  assert.equal(records.length, 2, 'the same host event observed through duplicate registrations is consumed once');
});

test('generic observer produces diagnostics without a metrics dependency', () => {
  const records: any[] = []; let sequence = 0;
  const observer = new CompactionDurationObserver({ registerEntryRenderer() {}, appendEntry: (type: string, data: unknown) => records.push({ type, data }) } as any, () => 100, () => `f1c3b1a2-5435-4d4a-8bcb-${String(++sequence).padStart(12, '0')}`);
  const branch: any[] = [{ id: 'source', type: 'message' }];
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => 's', getBranch: () => branch } } as any;
  for (const reason of ['manual', 'threshold', 'overflow'] as const) {
    observer.before({ reason }, ctx);
    branch.push({ id: `${reason}-entry`, type: 'compaction', fromHook: false });
    observer.compact({ reason }, ctx);
    observer.before({ reason }, ctx);
    observer.failed({ reason, aborted: true }, ctx);
  }
  assert.equal(records.length, 6);
  assert.equal(records.every(record => record.type === 'compaction-duration'), true);
  assert.equal(records.filter(record => record.data.schemaVersion === 2).every(record => record.data.source === 'native'), true, 'manual/threshold/overflow native commits are not attributed to a background attempt');
  assert.equal(records.filter(record => record.data.schemaVersion === 2).every(record => record.data.tokensBefore === null && record.data.tokensAfter === null && record.data.releasedTokens === null && record.data.reductionPercent === null), true, 'missing live system fallback fails closed rather than inventing context effects');
});
