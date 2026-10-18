import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../src/index.ts';
import type { FastEnabledRecord } from '../src/fast-enabled-event.ts';
import { UsageController } from '../src/usage.ts';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalTarget } from '../../project-metrics/src/node-crypto.ts';
import { metricsStatus, submitMetric, type MetricScope } from '@pi/project-metrics/client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function context(session = 'nonblocking') {
  const notices: string[] = [];
  return {
    mode: 'tui', hasUI: true,
    model: { id: 'gpt-5.4', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api', cost: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 } },
    modelRegistry: { isUsingOAuth: () => true },
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined },
    ui: { setStatus: () => {}, setWidget: () => {}, notify: (message: string) => { notices.push(message); }, theme: { fg: (_: string, text: string) => text } },
    notices,
  };
}
function harness(deps: Parameters<typeof extension>[1], emit: (name: string, data: unknown) => void = () => {}) {
  const handlers = new Map<string, Function>();
  let command!: (args: string, ctx: any) => Promise<void>;
  extension({ on: (name: string, handler: Function) => handlers.set(name, handler), events: { emit, on: () => () => {} }, registerCommand: (_: string, options: { handler: typeof command }) => { command = options.handler; } } as any, deps);
  return { command, handlers };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function waitFor(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`missing ${label}`);
}
async function transportFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'fast-scope-'));
  const endpoint = 'https://fast-offline.invalid', namespace = 'fast-scope', outboxDir = join(root, 'outbox');
  const target = join(outboxDir, canonicalTarget(endpoint, namespace, 'live'));
  await mkdir(outboxDir, { mode: 0o700 });
  const writeTokenFile = join(root, 'write.token'), readTokenFile = join(root, 'read.token'), config = join(root, 'config.json');
  await writeFile(writeTokenFile, 'w'.repeat(40), { mode: 0o600 });
  await writeFile(readTokenFile, 'r'.repeat(40), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ enabled: true, endpoint, namespace, dataset: 'live', outboxDir, writeTokenFile, readTokenFile }), { mode: 0o600 });
  const previous = process.env.PI_METRICS_CONFIG, fetchOriginal = globalThis.fetch;
  process.env.PI_METRICS_CONFIG = config;
  t.after(async () => {
    globalThis.fetch = fetchOriginal;
    if (previous === undefined) delete process.env.PI_METRICS_CONFIG;
    else process.env.PI_METRICS_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { target };
}
function observeSubmits() {
  const submissions: { id: string; scope: MetricScope | undefined }[] = [];
  return { submissions, submitMetric: ((input: unknown, scope?: MetricScope) => {
    const id = (input as { eventId: string }).eventId;
    submissions.push({ id, scope });
    return submitMetric(input, scope);
  }) as typeof submitMetric };
}
function replyForRequest(init?: RequestInit) {
  const body = JSON.parse(String(init?.body)) as { event: { eventId: string } };
  return { id: body.event.eventId, response: new Response(JSON.stringify({ eventId: body.event.eventId, status: 'accepted' }), { status: 202 }) };
}

test('Fast captures immutable On fact before deferred writer, never awaits writer or submit, and preserves original bus error', async () => {
  const writerGate = deferred<FastEnabledRecord>();
  const submitGate = deferred<void>();
  const captured: FastEnabledRecord[] = [], submitted: unknown[] = [];
  const original = new Error('original bus error');
  const h = harness({ writeFastEnabledEvent: fact => { captured.push(fact); return writerGate.promise; }, submitMetric: async input => { submitted.push(input); return submitGate.promise; } }, (_name, data) => { if ((data as { requested?: boolean }).requested) throw original; });
  const ctx = context();
  const happenedBy = Date.now();
  await assert.rejects(h.command('on', ctx), error => error === original);
  assert.deepEqual(captured, [], 'the writer must not be invoked before the command settles');
  await turn();
  assert.equal(captured.length, 1);
  assert.ok(Date.parse(captured[0].occurredAt) >= happenedBy && Date.parse(captured[0].occurredAt) <= Date.now());
  assert.ok(Object.isFrozen(captured[0]));
  assert.deepEqual(submitted, []);
  writerGate.resolve(captured[0]);
  await turn();
  assert.deepEqual(submitted, [{ schemaVersion: 1, eventId: captured[0].eventId, kind: 'fast_enabled', occurredAt: captured[0].occurredAt, dataset: 'live' }]);
  submitGate.resolve();
  await h.handlers.get('session_shutdown')?.({}, ctx);
});

test('sync writer throw, async writer rejection and pending submit do not replace command result; old warnings stay in old scope', async () => {
  const old = context('old'), next = context('new');
  const gate = deferred<FastEnabledRecord>();
  let called = 0;
  const h = harness({ writeFastEnabledEvent: fact => { called++; if (called === 1) throw new Error('sync write'); if (called === 2) return Promise.reject(new Error('async write')); return gate.promise; } });
  await h.command('on', old);
  await h.command('off', old);
  await h.command('on', old);
  assert.equal(called, 0);
  await turn();
  assert.equal(called, 2);
  await turn();
  assert.equal(old.notices.filter(n => n === '本次计量记录无法确认').length, 2);
  await h.command('off', old);
  await h.command('on', old);
  await turn();
  h.handlers.get('session_start')?.({}, next);
  gate.reject(new Error('late writer failure'));
  await turn();
  assert.equal(next.notices.includes('本次计量记录无法确认'), false);
  assert.equal(old.notices.filter(n => n === '本次计量记录无法确认').length, 2);
  await h.handlers.get('session_shutdown')?.({}, next);
});

test('shutdown preserves the first business error while closing metrics and still draining local work', async () => {
  const original = new Error('original publish error'), secondary = new Error('usage shutdown error');
  const submitted: unknown[] = [];
  const h = harness({ writeFastEnabledEvent: async fact => fact, submitMetric: async input => { submitted.push(input); } },
    (_name, data) => { if (!(data as { requested: boolean }).requested) throw original; });
  const ctx = context();
  await h.command('on', ctx);
  const usageShutdown = UsageController.prototype.shutdown;
  UsageController.prototype.shutdown = function () { throw secondary; };
  try { await assert.rejects(h.handlers.get('session_shutdown')?.({}, ctx), error => error === original); }
  finally { UsageController.prototype.shutdown = usageShutdown; }
  assert.equal(submitted.length, 1, 'the captured local task is given its bounded drain despite both cleanup failures');
  await h.command('status', ctx);
  assert.equal(ctx.notices.some(text => text.includes('Fast off')), true, 'Fast cleanup was not skipped');
});

for (const before of ['session_before_switch', 'session_before_fork', 'session_before_tree'] as const) {
  test(`${before} cancelled leaves Fast transport alive for current and subsequent events`, async t => {
    await transportFixture(t);
    const first = deferred<Response>();
    const requests: { id: string; response: Response }[] = [];
    globalThis.fetch = (async (_url, init) => {
      const request = replyForRequest(init);
      requests.push(request);
      return requests.length === 1 ? first.promise : request.response;
    }) as typeof fetch;
    const observed = observeSubmits();
    const h = harness({ writeFastEnabledEvent: async fact => fact, submitMetric: observed.submitMetric });
    const ctx = context('cancelled-stays-here');
    h.handlers.get('session_start')?.({}, ctx);
    try {
      await h.command('on', ctx);
      await waitFor(() => requests.length === 1, 'first POST');
      const scope = observed.submissions[0].scope!;
      assert.equal(scope.closed, false);
      // A different SDK before-handler may cancel or abort after this callback;
      // no post-event and no session_start follows an unsuccessful attempt.
      h.handlers.get(before)?.({ type: before, signal: new AbortController().signal }, ctx);
      assert.equal(scope.closed, false, 'a cancellable before-event cannot close an active producer');
      first.resolve(requests[0].response);
      await waitFor(async () => (await metricsStatus()).pending === 0, 'first authenticated ACK');
      await h.command('off', ctx);
      await h.command('on', ctx);
      await waitFor(() => requests.length === 2, 'new POST after cancellation');
      assert.strictEqual(observed.submissions[1].scope, scope, 'no session transition happened');
      assert.equal(scope.closed, false);
      await waitFor(async () => (await metricsStatus()).pending === 0, 'second authenticated ACK');
      await h.handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }, ctx);
      assert.equal(scope.closed, true);
    } finally { if (requests[0]) first.resolve(requests[0].response); }
  });
}

test('successful session_tree rotates only afterward: old transport and warning are isolated while new Fast POST succeeds', async t => {
  const { target } = await transportFixture(t);
  const oldAck = deferred<Response>(), newAck = deferred<Response>(), delayedWriter = deferred<FastEnabledRecord>();
  const requests: { id: string; response: Response }[] = [];
  globalThis.fetch = (async (_url, init) => {
    const request = replyForRequest(init);
    requests.push(request);
    return requests.length === 1 ? oldAck.promise : requests.length === 2 ? newAck.promise : request.response;
  }) as typeof fetch;
  let writes = 0;
  const observed = observeSubmits();
  const h = harness({ writeFastEnabledEvent: fact => ++writes === 2 ? delayedWriter.promise : Promise.resolve(fact), submitMetric: observed.submitMetric });
  const before = context('tree-session'), after = context('tree-session');
  h.handlers.get('session_start')?.({}, before);
  try {
    await h.command('on', before);
    await waitFor(() => requests.length === 1, 'old in-flight POST');
    const prior = observed.submissions[0].scope!;
    const priorFlight = [...prior.flushes.values()][0];
    await h.command('off', before);
    await h.command('on', before);
    await waitFor(() => writes === 2, 'old deferred writer');
    h.handlers.get('session_before_tree')?.({ type: 'session_before_tree', signal: new AbortController().signal }, before);
    assert.equal(prior.closed, false, 'still active before navigation succeeds');
    h.handlers.get('session_tree')?.({ type: 'session_tree', oldLeafId: 'before', newLeafId: 'after' }, after);
    assert.equal(prior.closed, true);
    assert.equal((await priorFlight).pending, 1, 'old non-cooperative POST completes logically when its scope closes');
    delayedWriter.reject(new Error('old writer failed after tree'));
    await turn();
    assert.equal(before.notices.includes('本次计量记录无法确认'), false);
    assert.equal(after.notices.includes('本次计量记录无法确认'), false);
    await h.command('off', after);
    await h.command('on', after);
    await waitFor(() => requests.length === 2, 'new POST following successful tree');
    const current = observed.submissions.at(-1)!.scope!;
    assert.notStrictEqual(current, prior);
    assert.equal(current.closed, false);
    oldAck.resolve(requests[0].response);
    await turn();
    assert.equal(JSON.parse(await readFile(join(target, `${requests[0].id}.json`), 'utf8')).event.eventId, requests[0].id, 'late old ACK cannot unlink');
    newAck.resolve(requests[1].response);
    await waitFor(async () => (await metricsStatus()).pending === 0, 'new scope flushes prior and current IDs');
    await h.handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }, after);
  } finally {
    if (requests[0]) oldAck.resolve(requests[0].response);
    if (requests[1]) newAck.resolve(requests[1].response);
    delayedWriter.reject(new Error('test cleanup'));
  }
});

test('shutdown closes only its producer; session_start reopens same factory and a concurrent caller stays live', async t => {
  await transportFixture(t);
  const requests: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const request = replyForRequest(init);
    requests.push(request.id);
    return request.response;
  }) as typeof fetch;
  const a = observeSubmits(), b = observeSubmits();
  const factory = (observer: ReturnType<typeof observeSubmits>) => harness({ writeFastEnabledEvent: async fact => fact, submitMetric: observer.submitMetric });
  const first = factory(a), peer = factory(b);
  const old = context('before-reload'), independent = context('peer');
  first.handlers.get('session_start')?.({}, old);
  peer.handlers.get('session_start')?.({}, independent);
  await first.command('on', old);
  await peer.command('on', independent);
  await waitFor(async () => requests.length >= 2 && (await metricsStatus()).pending === 0, 'both independent caller ACKs');
  const peerScope = b.submissions[0].scope!;
  await first.handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'reload' }, old);
  assert.equal(a.submissions[0].scope!.closed, true);
  assert.equal(peerScope.closed, false, 'closing one producer cannot close another using the shared client');
  const resumed = context('after-reload');
  first.handlers.get('session_start')?.({ type: 'session_start', reason: 'reload' }, resumed);
  await first.command('on', resumed);
  await peer.command('off', independent);
  await peer.command('on', independent);
  await waitFor(async () => requests.includes(a.submissions[1]?.id) && requests.includes(b.submissions[1]?.id) && (await metricsStatus()).pending === 0, 'reloaded and concurrent caller POSTs');
  assert.notStrictEqual(a.submissions[1].scope, a.submissions[0].scope);
  assert.equal(a.submissions[1].scope!.closed, false);
  assert.strictEqual(b.submissions[1].scope, peerScope);
  await first.handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }, resumed);
  await peer.handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }, independent);
});

test('Fast caps pending local tasks at 32; a single shutdown budget covers both writer and outbox', async () => {
  const writers: Array<(record: FastEnabledRecord) => void> = [];
  const h = harness({ writeFastEnabledEvent: fact => new Promise<FastEnabledRecord>(resolve => writers.push(() => resolve(fact))), submitMetric: async () => new Promise<void>(() => {}) });
  const ctx = context();
  for (let n = 0; n < 35; n++) { await h.command('on', ctx); await h.command('off', ctx); }
  await turn();
  assert.equal(writers.length, 32);
  assert.equal(ctx.notices.filter(n => n === '本次计量记录无法确认').length, 3);
  writers[0]();
  await turn(); // one writer has finished while its outbox submission remains pending
  const started = Date.now();
  await h.handlers.get('session_shutdown')?.({}, ctx);
  assert.ok(Date.now() - started >= 900 && Date.now() - started < 1700, 'not two sequential one-second deadlines, and never waits for POST');
  for (const release of writers) release();
  await turn();
});
