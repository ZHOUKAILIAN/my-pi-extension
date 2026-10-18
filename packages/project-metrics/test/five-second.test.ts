import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { canonicalTarget } from '../src/node-crypto.ts';
import { createMetricScope, flushMetricQueue, submitMetric } from '../src/client.ts';

const eventId = '4a19dc3b-8397-4d74-834f-a19ec67e891c';
const event = { schemaVersion: 1, eventId, kind: 'fast_enabled', occurredAt: '2025-01-01T00:00:00.000Z', dataset: 'live' };
const ack = () => new Response(JSON.stringify({ eventId, status: 'accepted' }), { status: 202 });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) { const deadline = Date.now() + 2000; while (Date.now() < deadline) { if (predicate()) return; await turn(); } throw new Error('request did not start'); }
async function fixture(t: { after(fn: () => Promise<void>): void }, endpoint = 'https://example.invalid') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'metrics-five-'));
  const outboxDir = join(root, 'outbox');
  await mkdir(outboxDir, { mode: 0o700 });
  const writeTokenFile = join(root, 'write.token'), readTokenFile = join(root, 'read.token'), path = join(root, 'config.json');
  await writeFile(writeTokenFile, 'w'.repeat(40), { mode: 0o600 });
  await writeFile(readTokenFile, 'r'.repeat(40), { mode: 0o600 });
  await writeFile(path, JSON.stringify({ enabled: true, endpoint, namespace: 'test-namespace', dataset: 'live', writeTokenFile, readTokenFile, outboxDir }), { mode: 0o600 });
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { path, target: join(outboxDir, canonicalTarget(endpoint, 'test-namespace', 'live')) };
}
async function configured<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.PI_METRICS_CONFIG;
  process.env.PI_METRICS_CONFIG = path;
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.PI_METRICS_CONFIG; else process.env.PI_METRICS_CONFIG = previous; }
}
async function staged(path: string) {
  const scope = createMetricScope(); scope.close();
  await configured(path, () => submitMetric(event, scope));
}

test('POST still accepts a valid ACK after two seconds, but never after the whole five-second deadline', async t => {
  const f = await fixture(t);
  await staged(f.path);
  const original = globalThis.fetch;
  const pending = deferred<Response>();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return pending.promise; }) as typeof fetch;
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const flushing = configured(f.path, () => flushMetricQueue());
    await until(() => calls === 1);
    t.mock.timers.tick(2100);
    pending.resolve(ack());
    assert.equal((await flushing).pending, 0, 'a 2.1s ACK must be accepted');
  } finally { t.mock.timers.reset(); globalThis.fetch = original; }
});

test('non-cooperative fetch expires logically, frees flush slot, and its late ACK cannot unlink during next explicit flush', async t => {
  const f = await fixture(t);
  await staged(f.path);
  const original = globalThis.fetch;
  const first = deferred<Response>(), second = deferred<Response>();
  let calls = 0;
  globalThis.fetch = (async () => (++calls === 1 ? first.promise : second.promise)) as typeof fetch;
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const attempt = configured(f.path, () => flushMetricQueue());
    await until(() => calls === 1);
    t.mock.timers.tick(5001);
    const expired = await attempt;
    assert.equal(expired.pending, 1);
    assert.equal(expired.unknown, true);
    const retry = configured(f.path, () => flushMetricQueue());
    await until(() => calls === 2);
    first.resolve(ack());
    await turn();
    assert.equal((await readdir(f.target)).filter(name => name.endsWith('.json')).length, 1, 'late ACK cannot unlink under a new attempt');
    second.resolve(ack());
    assert.equal((await retry).pending, 0);
  } finally { t.mock.timers.reset(); globalThis.fetch = original; }
});

test('non-cooperative ACK reader is cancelled at deadline without awaiting its cancellation; next flush can recover', async t => {
  const f = await fixture(t);
  await staged(f.path);
  const original = globalThis.fetch;
  let stream!: ReadableStreamDefaultController<Uint8Array>, calls = 0, cancels = 0;
  globalThis.fetch = (async () => { calls++; if (calls === 1) return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; }, cancel() { cancels++; return new Promise<void>(() => {}); } }), { status: 202 }); return ack(); }) as typeof fetch;
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const attempt = configured(f.path, () => flushMetricQueue());
    await until(() => calls === 1);
    t.mock.timers.tick(5001);
    assert.equal((await attempt).pending, 1);
    assert.equal(cancels, 1);
    assert.throws(() => stream.enqueue(new TextEncoder().encode(JSON.stringify({ eventId, status: 'accepted' }))));
    await turn();
    assert.equal((await readdir(f.target)).filter(name => name.endsWith('.json')).length, 1);
    assert.equal((await configured(f.path, () => flushMetricQueue())).pending, 0);
  } finally { t.mock.timers.reset(); globalThis.fetch = original; }
});

test('scope shutdown cancels an in-flight ACK and preserves local commits without disabling the next scope', async t => {
  const f = await fixture(t);
  const original = globalThis.fetch, pending = deferred<Response>();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return calls === 1 ? pending.promise : ack(); }) as typeof fetch;
  try {
    const scope = createMetricScope();
    await configured(f.path, () => submitMetric(event, scope));
    await until(() => calls === 1);
    const flight = [...scope.flushes.values()][0];
    scope.close();
    const result = await flight;
    assert.equal(result.pending, 1);
    pending.resolve(ack());
    await turn();
    assert.equal((await readdir(f.target)).filter(name => name.endsWith('.json')).length, 1);
    const next = createMetricScope();
    assert.equal((await configured(f.path, () => flushMetricQueue())).pending, 0);
    assert.equal(next.closed, false);
    next.close();
  } finally { globalThis.fetch = original; }
});

test('non-OK headers abort transport without awaiting a rejecting or non-cooperative body cancellation, and preserve status classification', async t => {
  for (const status of [302, 409, 500]) {
    const f = await fixture(t);
    await staged(f.path);
    const original = globalThis.fetch;
    let aborted = false, cancellations = 0;
    globalThis.fetch = (async (_url, init) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => { aborted = true; });
      const body = new ReadableStream<Uint8Array>({ cancel() {
        cancellations++;
        return status === 409 ? Promise.reject(new Error('cancellation rejected')) : new Promise<void>(() => {});
      } });
      return new Response(body, { status });
    }) as typeof fetch;
    try {
      const result = await configured(f.path, () => flushMetricQueue());
      assert.equal(result.pending, 1);
      assert.equal(result.failed, 1);
      assert.equal(aborted, true, `${status} response transport must be aborted before returning`);
      assert.equal(cancellations, 1, `${status} body cancellation is attempted but never awaited`);
      assert.equal((await readdir(f.target)).includes(`.blocked-${eventId}`), status === 409);
    } finally { globalThis.fetch = original; }
  }
});

test('fetch resolving with an unread body after deadline or scope shutdown is discarded, never orphaned', async t => {
  for (const end of ['deadline', 'shutdown'] as const) {
    const f = await fixture(t);
    if (end === 'deadline') await staged(f.path);
    const original = globalThis.fetch;
    const late = deferred<Response>();
    let calls = 0, cancelled = 0;
    globalThis.fetch = (async () => ++calls === 1 ? late.promise : ack()) as typeof fetch;
    try {
      if (end === 'deadline') t.mock.timers.enable({ apis: ['setTimeout'] });
      const scope = createMetricScope();
      let flushing: Promise<{ pending: number | null }>;
      if (end === 'deadline') flushing = configured(f.path, () => flushMetricQueue());
      else {
        await configured(f.path, () => submitMetric(event, scope));
        flushing = [...scope.flushes.values()][0];
      }
      await until(() => calls === 1);
      if (end === 'deadline') t.mock.timers.tick(5001);
      else scope.close();
      assert.equal((await flushing).pending, 1);
      late.resolve(new Response(new ReadableStream<Uint8Array>({ cancel() {
        cancelled++;
        return Promise.reject(new Error('late cancellation failure'));
      } }), { status: 202 }));
      await turn();
      assert.equal(cancelled, 1, `${end} late response must release its unread body`);
      assert.equal((await readdir(f.target)).filter(name => name.endsWith('.json')).length, 1);
      assert.equal((await configured(f.path, () => flushMetricQueue())).pending, 0);
    } finally { t.mock.timers.reset(); globalThis.fetch = original; }
  }
});

test('invalid UTF-8 and oversized ACK abort and cancel the reader; synchronous fetch failure aborts its signal', async t => {
  for (const data of [new Uint8Array([0xff]), new TextEncoder().encode('x'.repeat(2049))]) {
    const f = await fixture(t);
    await staged(f.path);
    const original = globalThis.fetch;
    let cancelled = 0, aborted = false;
    globalThis.fetch = (async (_url, init) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => { aborted = true; });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); }, cancel() { cancelled++; return Promise.reject(new Error('reader cancellation rejected')); } }), { status: 202 });
    }) as typeof fetch;
    try {
      const result = await configured(f.path, () => flushMetricQueue());
      assert.equal(result.pending, 1);
      assert.equal(aborted, true);
      assert.equal(cancelled, 1);
    } finally { globalThis.fetch = original; }
  }
  const f = await fixture(t);
  await staged(f.path);
  const original = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = ((_url, init) => { signal = init?.signal as AbortSignal; throw new Error('offline sync fetch'); }) as typeof fetch;
  try {
    const result = await configured(f.path, () => flushMetricQueue());
    assert.equal(result.pending, 1);
    assert.equal(result.unknown, true);
    assert.equal(signal?.aborted, true);
  } finally { globalThis.fetch = original; }
});

for (const status of [409, 500]) {
  test(`real ${status} headers with an endless body do not hold a short producer child; durable ${status} recovery remains correct`, async t => {
    const sockets = new Set<import('node:net').Socket>();
    const seen: string[] = [];
    let firstClosed = false;
    const server = createServer((req, res) => {
      let content = '';
      req.setEncoding('utf8').on('data', chunk => { content += chunk; }).on('end', () => {
        const id = (JSON.parse(content) as { event: { eventId: string } }).event.eventId;
        seen.push(id);
        if (seen.length === 1) {
          res.once('close', () => { firstClosed = true; });
          res.writeHead(status, { 'content-type': 'application/json' });
          res.flushHeaders(); // never end or consume the error body
        } else {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ eventId: id, status: 'accepted' }));
        }
      });
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const f = await fixture(t, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    const another = { ...event, eventId: '07ee11a9-4f53-4aa3-8287-57ec5be04755' };
    const script = `import { submitMetric, flushMetricQueue, createMetricScope, drainLocal } from ${JSON.stringify(new URL('../src/client.ts', import.meta.url).href)};
      const scope=createMetricScope(); await submitMetric(${JSON.stringify(event)},scope);
      const first=await [...scope.flushes.values()][0];
      if(${status}===409){
        await submitMetric(${JSON.stringify(another)},scope);
        const later=await [...scope.flushes.values()][0];
        const skipped=await flushMetricQueue();
        scope.close(); await drainLocal(1000);
        console.log(JSON.stringify({first,later,skipped}));
      }else{
        scope.close(); const retried=await flushMetricQueue(); await drainLocal(1000);
        console.log(JSON.stringify({first,retried}));
      }`;
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { env: { ...process.env, PI_METRICS_CONFIG: f.path }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', text => { stdout += text; });
    child.stderr.setEncoding('utf8').on('data', text => { stderr += text; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2500);
    const started = Date.now();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timeout));
    assert.equal(exit.code, 0, `child held by unread ${status} body or errored (${exit.signal}): ${stderr}`);
    assert.ok(Date.now() - started < 2500, 'must not wait for the five-second transport timer or SDK body timeout');
    assert.equal(firstClosed, true, 'unread native HTTP response must close on abort');
    const result = JSON.parse(stdout.trim()) as { first: { pending: number; failed: number }; later?: { pending: number; sent: number }; skipped?: { pending: number; sent: number }; retried?: { pending: number; sent: number } };
    assert.equal(result.first.pending, 1);
    assert.equal(result.first.failed, 1);
    if (status === 409) {
      assert.equal(result.later?.pending, 1);
      assert.equal(result.later?.sent, 1, 'later queued event is not starved by the blocked ID');
      assert.equal(result.skipped?.pending, 1);
      assert.equal(result.skipped?.sent, 0);
      assert.deepEqual(seen, [eventId, another.eventId]);
      assert.equal((await readdir(f.target)).includes(`.blocked-${eventId}`), true);
    } else {
      assert.equal(result.retried?.pending, 0, 'transient failure is retried explicitly with the same ID');
      assert.equal(result.retried?.sent, 1);
      assert.deepEqual(seen, [eventId, eventId]);
    }
  });
}

test('short RPC child exits after local commit and scope close despite a live unresponsive loopback POST', async t => {
  let seen!: () => void;
  const requested = new Promise<void>(resolve => { seen = resolve; });
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((req, _res) => { req.resume(); seen(); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const f = await fixture(t, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  const script = `import { submitMetric, createMetricScope, drainLocal } from ${JSON.stringify(new URL('../src/client.ts', import.meta.url).href)};
    const scope=createMetricScope(); await submitMetric(${JSON.stringify(event)},scope);
    await new Promise(resolve=>setTimeout(resolve,100)); scope.close(); await drainLocal(1000);`;
  const start = Date.now();
  const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { env: { ...process.env, PI_METRICS_CONFIG: f.path }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  child.stderr.setEncoding('utf8').on('data', text => { error += text; });
  t.after(() => { child.kill('SIGKILL'); });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 2200);
  try {
    await Promise.race([requested, closed.then(() => { throw new Error('RPC exited before a POST was observed'); })]);
    const exit = await closed;
    assert.equal(exit, 0, error);
  } finally { clearTimeout(timeout); }
  assert.ok(Date.now() - start < 2200);
  assert.equal((await readdir(f.target)).filter(name => name.endsWith('.json')).length, 1);
  assert.equal(JSON.parse(await readFile(join(f.target, `${eventId}.json`), 'utf8')).event.eventId, eventId);
});
