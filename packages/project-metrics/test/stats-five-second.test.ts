import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { queryMetricStats, statsFailureCode } from '../src/client.ts';

function stats() {
  const today = new Date().toISOString().slice(0, 10);
  const day = (n: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - n * 86400000).toISOString().slice(0, 10);
  return { coverage: 'received_only', status: 'no_received_data', watermark: 0, asOf: new Date().toISOString(), dataset: 'validation', days: 1,
    completeDays: { from: day(1), to: day(1), baselineDay: day(2), overallAggregates: [], overallComparisons: [], aggregates: [], comparisons: [] },
    unlocatedByReceivedDay: [], unlocatedOverallByReceivedDay: [], todayInProgress: { day: today, comparison: false, overallReceivedAggregates: [], receivedAggregates: [] }, truncated: false };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'metrics-stats-clock-'));
  const writeTokenFile = join(root, 'write.token'), readTokenFile = join(root, 'read.token'), outboxDir = join(root, 'outbox'), config = join(root, 'config.json');
  await mkdir(outboxDir, { mode: 0o700 });
  await writeFile(writeTokenFile, 'w'.repeat(40), { mode: 0o600 });
  await writeFile(readTokenFile, 'r'.repeat(40), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ enabled: false, endpoint: 'https://local-stats.invalid', namespace: 'test-namespace', dataset: 'validation', writeTokenFile, readTokenFile, outboxDir }), { mode: 0o600 });
  const prior = process.env.PI_METRICS_CONFIG, oldFetch = globalThis.fetch;
  process.env.PI_METRICS_CONFIG = config;
  t.after(async () => { globalThis.fetch = oldFetch; if (prior === undefined) delete process.env.PI_METRICS_CONFIG; else process.env.PI_METRICS_CONFIG = prior; await rm(root, { recursive: true, force: true }); });
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() >= deadline) throw Error('stats request did not reach controlled boundary'); await turn(); }
}

 test('stats accepts a valid response after two seconds and before the five-second header+body+parse deadline', async t => {
  await fixture(t);
  let sent = false, aborts = 0, reply!: (response: Response) => void;
  globalThis.fetch = (async (_url, init) => new Promise<Response>((resolve, reject) => {
    sent = true;
    reply = resolve;
    (init?.signal as AbortSignal).addEventListener('abort', () => { aborts++; reject(new Error('private-abort-message')); });
  })) as typeof fetch;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const result = queryMetricStats(1, 'validation');
    await until(() => sent);
    t.mock.timers.tick(2100);
    assert.equal(aborts, 0, 'the previous two-second abort would reject the request here');
    reply(new Response(JSON.stringify(stats()), { status: 200 }));
    assert.equal((await result as { coverage: string }).coverage, 'received_only');
  } finally { t.mock.timers.reset(); }
});

 test('stats header and ACK reader that ignore abort both settle at the five-second deadline, then discard late responses', async t => {
  await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let called = false, reply!: (response: Response) => void, cancelled = 0;
    globalThis.fetch = (async () => new Promise<Response>(resolve => { called = true; reply = resolve; })) as typeof fetch;
    const header = queryMetricStats(1, 'validation');
    await until(() => called);
    t.mock.timers.tick(5001);
    await assert.rejects(header, error => statsFailureCode(error) === 'stats_timeout');
    reply(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; return Promise.reject(new Error('private-late-body')); } }), { status: 200 }));
    await turn();
    assert.equal(cancelled, 1, 'late response from abort-ignoring fetch must not retain an unread socket');
    let readerStarted = false, readerCancelled = 0;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({ pull() { readerStarted = true; return new Promise<void>(() => {}); }, cancel() { readerCancelled++; return new Promise<void>(() => {}); } }), { status: 200 })) as typeof fetch;
    const body = queryMetricStats(1, 'validation');
    await until(() => readerStarted);
    t.mock.timers.tick(5001);
    await assert.rejects(body, error => statsFailureCode(error) === 'stats_timeout');
    assert.equal(readerCancelled, 1, 'reader cancellation must be attempted without awaiting it');
  } finally { t.mock.timers.reset(); }
});

 test('stats failure codes distinguish transport, auth, HTTP, malformed schema/body and oversized body without trusting thrown codes', async t => {
  await fixture(t);
  const secret = 'private-error-payload';
  const cases: Array<{ response?: Response; throw?: boolean; code: string }> = [
    { throw: true, code: 'stats_transport' },
    { response: new Response(new ReadableStream<Uint8Array>({ cancel() { return Promise.reject(Error(secret)); } }), { status: 401 }), code: 'stats_unauthorized' },
    { response: new Response('private-error-body', { status: 503 }), code: 'stats_http_error' },
    { response: new Response(JSON.stringify({ ...stats(), extra: secret }), { status: 200 }), code: 'stats_invalid_response' },
    { response: new Response('invalid json', { status: 200 }), code: 'stats_invalid_response' },
    { response: new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }), code: 'stats_body_too_large' },
  ];
  for (const item of cases) {
    globalThis.fetch = (async () => {
      if (item.throw) throw Object.assign(new Error(secret), { code: 'stats_timeout' });
      return item.response!;
    }) as typeof fetch;
    await assert.rejects(queryMetricStats(1, 'validation'), error => {
      assert.equal(statsFailureCode(error), item.code);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
  await assert.rejects(queryMetricStats(0, 'validation'), error => statsFailureCode(error) === 'stats_configuration');
});
