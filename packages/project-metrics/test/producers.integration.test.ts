import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/worker.ts';
import { drainLocal, submitMetric } from '../src/client.ts';
import { writeFastEnabledEvent } from '../../codex-usage-status/src/fast-enabled-event.ts';
import { Timing } from '../../async-compaction/src/timing.ts';

const namespace = 'producer-integration';
const writeToken = 'w'.repeat(40);
const readToken = 'r'.repeat(40);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function d1(db: DatabaseSync) {
  return {
    prepare(sql: string) {
      return {
        args: [] as unknown[],
        bind(...args: unknown[]) { this.args = args; return this; },
        async run() { const result = db.prepare(sql).run(...this.args as any[]); return { meta: { changes: Number(result.changes) }, results: [] }; },
        async first<T>() { return db.prepare(sql).get(...this.args as any[]) as T ?? null; },
        async all<T>() { return { results: db.prepare(sql).all(...this.args as any[]) as T[], meta: { changes: 0 } }; },
      };
    },
  };
}
async function runCli(args: string[], config: string) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', 'packages/project-metrics/src/cli.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, PI_METRICS_CONFIG: config },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', (chunk) => stderr += chunk);
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test('Fast committed record and Async real Timing.finish reach Worker D1 and CLI as two normalized events', async (t) => {
  const previousConfig = process.env.PI_METRICS_CONFIG;
  const privateRoot = await mkdtemp(join(await realpath(tmpdir()), 'metrics-producer-'));
  await chmod(privateRoot, 0o700);
  t.after(async () => {
    if (previousConfig === undefined) delete process.env.PI_METRICS_CONFIG;
    else process.env.PI_METRICS_CONFIG = previousConfig;
    await rm(privateRoot, { recursive: true, force: true });
  });

  const database = new DatabaseSync(':memory:');
  database.exec(await readFile(new URL('../migrations/0003_project_metrics.sql', import.meta.url), 'utf8'));
  database.prepare('INSERT INTO project_metrics_meta(singleton,namespace) VALUES(1,?)').run(namespace);
  const env = { DB: d1(database), TARGET_NAMESPACE: namespace, METRICS_WRITE_TOKEN: writeToken, METRICS_READ_TOKEN: readToken, PROJECT_METRICS_ENABLED: 'true' };
  const server = createServer(async (request, response) => {
    const body = request.method === 'POST' ? await new Promise<string>((resolvePromise) => {
      let value = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => value += chunk);
      request.on('end', () => resolvePromise(value));
    }) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
    const handled = await worker.fetch(new Request(`https://metrics.test${request.url}`, { method: request.method, headers, body } as RequestInit), env);
    response.writeHead(handled.status, Object.fromEntries(handled.headers));
    response.end(await handled.text());
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())));

  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const outboxDir = join(privateRoot, 'outbox');
  await mkdir(outboxDir, { mode: 0o700 });
  const writeTokenFile = join(privateRoot, 'write.token');
  const readTokenFile = join(privateRoot, 'read.token');
  const config = join(privateRoot, 'config.json');
  await writeFile(writeTokenFile, writeToken, { mode: 0o600 });
  await writeFile(readTokenFile, readToken, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ enabled: true, endpoint, namespace, dataset: 'validation', writeTokenFile, readTokenFile, outboxDir }), { mode: 0o600 });
  process.env.PI_METRICS_CONFIG = config;

  const agentDir = join(privateRoot, 'agent');
  await mkdir(agentDir, { mode: 0o700 });
  const fastRecord = await writeFastEnabledEvent(agentDir, () => '4a19dc3b-8397-4d74-834f-a19ec67e891c');
  await submitMetric({ schemaVersion: 1, eventId: fastRecord.eventId, kind: 'fast_enabled', occurredAt: fastRecord.occurredAt, dataset: 'live' });

  const localEntries: any[] = [];
  let monotonic = 20;
  const timing = new Timing({ registerEntryRenderer() {}, appendEntry: (_type: string, data: unknown) => localEntries.push(data) } as any, {
    monotonic: () => monotonic += 15,
    utc: () => Date.now(),
  });
  const generation = timing.begin('background_generation', 'model-x', 'provider-y');
  generation.finish('completed');
  generation.finish('failed');
  const foreground = timing.begin('foreground_compaction', 'model-x', 'provider-y');
  foreground.finish('failed');
  assert.equal(localEntries.length, 2, 'real Timing.finish is idempotent for both producer kinds');
  assert.equal(localEntries[0].durationMs, 15);
  assert.equal(localEntries[1].kind, 'foreground_compaction');
  assert.equal(await drainLocal(1000), true, 'shutdown boundary waits for local commits only');

  const flush = await runCli(['flush'], config);
  assert.equal(flush.code, 0);
  assert.equal(flush.stderr, '');
  const rows = database.prepare('SELECT event_id,kind,duration_ms,model,provider,dataset FROM project_metric_events ORDER BY kind').all() as any[];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.kind), ['background_generation', 'fast_enabled', 'foreground_compaction']);
  assert.ok(rows.every((row) => row.dataset === 'validation'));
  assert.equal(rows.find((row) => row.kind === 'fast_enabled').event_id, fastRecord.eventId);
  assert.equal(rows.find((row) => row.kind === 'background_generation').duration_ms, 15);

  const stats = await runCli(['stats', '--days', '7', '--validation'], config);
  assert.equal(stats.code, 0);
  const report = JSON.parse(stats.stdout);
  assert.equal(report.coverage, 'received_only');
  assert.equal('events' in report, false);
  assert.equal(report.local.enabled, true);
  database.close();
});

test('CLI accepts real SQLite Worker finite-large ratios and displays non-comparable overflow without leaking credentials', async t => {
  const privateRoot = await mkdtemp(join(await realpath(tmpdir()), 'metrics-ratio-cli-'));
  await chmod(privateRoot, 0o700);
  t.after(() => rm(privateRoot, { recursive: true, force: true }));
  const database = new DatabaseSync(':memory:');
  database.exec(await readFile(new URL('../migrations/0003_project_metrics.sql', import.meta.url), 'utf8'));
  database.prepare('INSERT INTO project_metrics_meta(singleton,namespace) VALUES(1,?)').run(namespace);
  t.after(() => database.close());
  const env = { DB: d1(database), TARGET_NAMESPACE: namespace, METRICS_WRITE_TOKEN: writeToken, METRICS_READ_TOKEN: readToken, PROJECT_METRICS_ENABLED: 'true' };
  const server = createServer(async (req, res) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
      const result = await worker.fetch(new Request(`https://metrics.test${req.url}`, { method: req.method, headers }), env);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(await result.text());
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise<void>(resolvePromise => server.close(() => resolvePromise())));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const writeTokenFile = join(privateRoot, 'write.token'), readTokenFile = join(privateRoot, 'read.token');
  const config = join(privateRoot, 'config.json');
  await writeFile(writeTokenFile, writeToken, { mode: 0o600 });
  await writeFile(readTokenFile, readToken, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ enabled: false, endpoint, namespace, dataset: 'validation', writeTokenFile, readTokenFile, outboxDir: join(privateRoot, 'outbox') }), { mode: 0o600 });
  const today = new Date().toISOString().slice(0, 10);
  const stamp = (offset: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) - offset * 86400000).toISOString();
  for (const baseline of [Number.MIN_VALUE, 1e-10]) {
    database.prepare('DELETE FROM project_metric_events').run(); // isolated in-memory fixture, never a remote write
    for (const [offset, durationMs] of [[2, baseline], [1, 86400000]]) {
      const event = { schemaVersion: 1, eventId: randomUUID(), kind: 'background_generation', occurredAt: stamp(offset), dataset: 'validation', durationMs, outcome: 'completed', model: 'm', provider: 'p' };
      const response = await worker.fetch(new Request('https://metrics.test/api/v1/project-events', { method: 'POST', headers: { authorization: `Bearer ${writeToken}` }, body: JSON.stringify({ namespace, event }) }), env);
      assert.equal(response.status, 202);
    }
    const cli = await runCli(['stats', '--days', '1', '--validation'], config);
    assert.equal(cli.code, 0, `CLI must accept legal baseline ${baseline}: ${cli.stderr}`);
    assert.equal(cli.stderr, '');
    assert.equal(cli.stdout.includes(readToken), false);
    const report = JSON.parse(cli.stdout);
    assert.equal(report.coverage, 'received_only');
    for (const comparisons of [report.completeDays.comparisons, report.completeDays.overallComparisons]) {
      assert.equal(comparisons.length, 1);
      assert.equal(comparisons[0].comparable, baseline !== Number.MIN_VALUE);
      assert.equal(comparisons[0].percentChange, baseline === Number.MIN_VALUE ? null : 8.64e17);
    }
  }
});
