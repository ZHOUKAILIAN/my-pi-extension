import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { submitMetric, flushMetricQueue } from '../src/client.ts';
import { canonicalTarget } from '../src/node-crypto.ts';

const event = (eventId: string) => ({ schemaVersion: 1, eventId, kind: 'fast_enabled', occurredAt: '2025-01-01T00:00:00.000Z', dataset: 'live' });
const id = '4a19dc3b-8397-4d74-834f-a19ec67e891c';
const another = '07ee11a9-4f53-4aa3-8287-57ec5be04755';
const clientUrl = new URL('../src/client.ts', import.meta.url).href;

// A child-only fs shim pauses at actual filesystem operations. No test hooks or
// environment-triggered branches are installed in production client code.
const preload = `
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { dirname, basename, join } from 'node:path';
const fs = createRequire(import.meta.url)('node:fs/promises');
const open = fs.open, link = fs.link, readdir = fs.readdir, unlink = fs.unlink;
const owned = process.env.PI_LOCK_INTERCEPT_DIR;
const phase = process.env.PI_LOCK_PHASE;
let paused = false, operationPaused = false, reapPaused = false;
const wait = async (name) => {
  paused = true;
  process.send({ phase: name });
  await new Promise(resolve => {
    const onMessage = message => {
      if (message?.phase !== 'continue') return;
      process.off('message', onMessage);
      resolve();
    };
    process.on('message', onMessage);
  });
};
fs.open = async (...args) => {
  const file = await open(...args);
  const path = String(args[0]);
  if (phase === 'before-recheck' && path === join(owned, '.lock')) {
    const original = file.readFile.bind(file);
    file.readFile = async (...rest) => {
      const content = await original(...rest);
      if (!paused) await wait('before-recheck');
      return content;
    };
  }
  if (phase === 'prepare-short-write' && dirname(path) === owned && basename(path).startsWith('.lock-') && basename(path).endsWith('.tmp')) file.writeFile = async () => {};
  if (phase === 'prepare-sync-failure' && dirname(path) === owned && basename(path).startsWith('.lock-') && basename(path).endsWith('.tmp')) file.sync = async () => { throw new Error('synthetic_prepare_sync_failure'); };
  if (phase === 'directory-sync-failure' && path === owned) file.sync = async () => { throw new Error('synthetic_directory_sync_failure'); };
  if (phase === 'before-write' && dirname(path) === owned && (basename(path) === '.lock' || (basename(path).startsWith('.lock-') && basename(path).endsWith('.tmp')))) {
    const original = file.writeFile.bind(file);
    file.writeFile = async (data, ...rest) => {
      let lock;
      try { lock = JSON.parse(data); } catch {}
      if (!paused && Number.isSafeInteger(lock?.pid) && typeof lock.nonce === 'string' && Object.keys(lock).length === 2) await wait('before-write');
      return original(data, ...rest);
    };
  }
  return file;
};
fs.link = async (source, target, ...rest) => {
  try {
    const result = await link(source, target, ...rest);
    if (!paused && phase === 'after-link' && target === join(owned, '.lock')) await wait('after-link');
    if (!paused && phase === 'after-link-guard' && target === join(owned, '.lock-reaper')) await wait('after-link-guard');
    if (!paused && phase === 'competing-reap' && target === join(owned, '.lock')) await wait('unsafe-published');
    return result;
  } catch (error) {
    if (phase === 'competing-reap' && target === join(owned, '.lock-reaper') && error.code === 'EEXIST' && !paused) {
      paused = true;
      process.send({ phase: 'guard-conflict' });
    }
    if (phase === 'conflict' && target === join(owned, '.lock') && error.code === 'EEXIST' && !paused) {
      paused = true;
      process.send({ phase: 'conflict' });
    }
    throw error;
  }
};
fs.unlink = async (path, ...rest) => {
  if (phase === 'ordinary-wins' && path === join(owned, '.lock') && !reapPaused) {
    reapPaused = true;
    const result = await unlink(path, ...rest);
    await wait('after-reap-unlink');
    return result;
  }
  if (phase === 'reap-and-operate' && path === join(owned, '.lock') && !reapPaused) {
    reapPaused = true;
    await wait('before-reap-unlink');
  }
  return unlink(path, ...rest);
};
fs.readdir = async (...args) => {
  const result = await readdir(...args);
  if (!paused && phase === 'during-operation' && args[0] === owned) await wait('during-operation');
  if (phase === 'reap-and-operate' && !operationPaused && args[0] === owned) {
    operationPaused = true;
    await wait('during-operation');
  }
  if (phase === 'competing-reap' && args[0] === owned) process.send({ phase: 'operation-entered' });
  return result;
};
syncBuiltinESMExports();
`;

type Fixture = { root: string; outbox: string; target: string; config: string; bootstrap: string };
async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<Fixture> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'project-lock-publication-'));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const outbox = join(root, 'outbox');
  const target = join(outbox, canonicalTarget('http://127.0.0.1:1', 'lock-test', 'live'));
  await mkdir(target, { recursive: true, mode: 0o700 });
  const config = join(root, 'config.json');
  const bootstrap = join(root, 'bootstrap.mjs');
  const writeTokenFile = join(root, 'write.token'), readTokenFile = join(root, 'read.token');
  await writeFile(writeTokenFile, 'w'.repeat(40), { mode: 0o600 });
  await writeFile(readTokenFile, 'r'.repeat(40), { mode: 0o600 });
  await writeFile(config, JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:1', namespace: 'lock-test', dataset: 'live', writeTokenFile, readTokenFile, outboxDir: outbox }), { mode: 0o600 });
  await writeFile(bootstrap, preload, { mode: 0o600 });
  return { root, outbox, target, config, bootstrap };
}
async function configured<T>(config: string, operation: () => Promise<T>): Promise<T> {
  const prior = process.env.PI_METRICS_CONFIG;
  process.env.PI_METRICS_CONFIG = config;
  try { return await operation(); }
  finally { if (prior === undefined) delete process.env.PI_METRICS_CONFIG; else process.env.PI_METRICS_CONFIG = prior; }
}
function start(fixture: Fixture, directory: string, phase: string, command: 'submit' | 'flush', eventId = id) {
  const script = command === 'flush'
    ? `import {flushMetricQueue} from ${JSON.stringify(clientUrl)};await flushMetricQueue();`
    : `import {submitMetric} from ${JSON.stringify(clientUrl)};await submitMetric(${JSON.stringify(event(eventId))});`;
  const child = spawn(process.execPath, ['--import', fixture.bootstrap, '--experimental-strip-types', '--input-type=module', '-e', script], {
    env: { ...process.env, PI_METRICS_CONFIG: fixture.config, PI_LOCK_INTERCEPT_DIR: directory, PI_LOCK_PHASE: phase },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, finished };
}
async function phase(child: ChildProcess, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`lock_phase_missing:${expected}`)); }, 5000);
    function cleanup() { clearTimeout(timeout); child.off('message', onMessage); child.off('close', onClose); }
    function onMessage(message: unknown) {
      if ((message as { phase?: string })?.phase !== expected) return;
      cleanup(); resolve();
    }
    function onClose() { cleanup(); reject(new Error(`child_closed_before:${expected}`)); }
    child.on('message', onMessage);
    child.once('close', onClose);
  });
}
async function phaseOneOf(child: ChildProcess, names: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('reaper_phase_missing')); }, 5000);
    function cleanup() { clearTimeout(timeout); child.off('message', onMessage); child.off('close', onClose); }
    function onMessage(message: unknown) {
      const name = (message as { phase?: string })?.phase;
      if (!name || !names.includes(name)) return;
      cleanup(); resolve(name);
    }
    function onClose() { cleanup(); reject(new Error('reaper_child_closed')); }
    child.on('message', onMessage);
    child.once('close', onClose);
  });
}
function continueChild(child: ChildProcess) { child.send({ phase: 'continue' }); }
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const pid = child.pid!;
  child.kill('SIGKILL');
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  return pid;
}
async function completeLock(path: string, expectedPid: number): Promise<{ pid: number; nonce: string }> {
  const stat = await lstat(path);
  assert.ok(stat.isFile());
  assert.equal(stat.mode & 0o777, 0o600);
  const raw = await readFile(path, 'utf8');
  const lock = JSON.parse(raw) as { pid: number; nonce: string };
  assert.deepEqual(Object.keys(lock), ['pid', 'nonce']);
  assert.equal(lock.pid, expectedPid);
  assert.match(lock.nonce, /^[0-9a-f-]{36}$/u);
  return lock;
}

test('SIGKILL during private lock preparation never publishes empty root or target locks; a competing reader proceeds', async t => {
  for (const location of ['root', 'target'] as const) {
    const f = await fixture(t);
    const directory = location === 'root' ? f.outbox : f.target;
    const held = start(f, directory, 'before-write', location === 'root' ? 'submit' : 'flush');
    t.after(async () => { held.child.kill('SIGKILL'); await held.finished; });
    await phase(held.child, 'before-write');
    const pendingFiles = await readdir(directory);
    assert.ok(pendingFiles.some(name => /^\.lock-[^/]+\.tmp$/u.test(name)), 'child reached private preparation');
    assert.equal(pendingFiles.includes('.lock'), false, 'an incomplete lock is never published');
    if (location === 'target') {
      const result = await configured(f.config, () => flushMetricQueue());
      assert.equal(result.pending, 0, 'a second process can acquire the lock while first prepares');
    }
    held.child.kill('SIGKILL');
    assert.equal((await held.finished).signal, 'SIGKILL');
    assert.equal((await readdir(directory)).includes('.lock'), false);
    await configured(f.config, async () => {
      if (location === 'root') await submitMetric(event(another));
      const result = await flushMetricQueue();
      assert.equal(result.pending, location === 'root' ? 1 : 0);
    });
  }
});

test('post-publication death leaves complete PID lock, competing process waits, and dead owner is safely reclaimed', async t => {
  for (const location of ['root', 'target'] as const) {
    const f = await fixture(t);
    const directory = location === 'root' ? f.outbox : f.target;
    const held = start(f, directory, 'after-link', location === 'root' ? 'submit' : 'flush');
    t.after(async () => { held.child.kill('SIGKILL'); await held.finished; });
    await phase(held.child, 'after-link');
    await completeLock(join(directory, '.lock'), held.child.pid!);
    const competitor = start(f, directory, 'conflict', location === 'root' ? 'submit' : 'flush', another);
    t.after(async () => { competitor.child.kill('SIGKILL'); await competitor.finished; });
    await phase(competitor.child, 'conflict');
    await completeLock(join(directory, '.lock'), held.child.pid!);
    held.child.kill('SIGKILL');
    assert.equal((await held.finished).signal, 'SIGKILL');
    const acquired = await competitor.finished;
    assert.equal(acquired.code, 0, acquired.stderr);
    assert.equal((await readdir(directory)).includes('.lock'), false);
    await configured(f.config, async () => {
      const result = await flushMetricQueue();
      assert.equal(result.pending, location === 'root' ? 1 : 0);
    });
  }
});

test('operation exit does not unlink a replacement lock with a changed inode or nonce', async t => {
  for (const replacement of ['inode', 'nonce'] as const) {
    const f = await fixture(t);
    const held = start(f, f.target, 'during-operation', 'flush');
    t.after(async () => { held.child.kill('SIGKILL'); await held.finished; });
    await phase(held.child, 'during-operation');
    await completeLock(join(f.target, '.lock'), held.child.pid!);
    const path = join(f.target, '.lock');
    if (replacement === 'inode') await unlink(path);
    const body = JSON.stringify({ pid: process.pid, nonce: `external-${replacement}` });
    await writeFile(path, body, { mode: 0o600 });
    continueChild(held.child);
    assert.equal((await held.finished).code, 0);
    assert.equal(await readFile(path, 'utf8'), body, 'finally must not delete another owner’s lock');
    await unlink(path); // test-owned dummy lock only
  }
});

test('incomplete writes and preparation/publication sync faults never expose a lock, and later flush proceeds', async t => {
  for (const failure of ['prepare-short-write', 'prepare-sync-failure', 'directory-sync-failure'] as const) for (const location of ['root', 'target'] as const) {
    const f = await fixture(t);
    const directory = location === 'root' ? f.outbox : f.target;
    const child = start(f, directory, failure, location === 'root' ? 'submit' : 'flush');
    const outcome = await child.finished;
    assert.notEqual(outcome.code, 0, 'injected sync failure must reach the caller');
    assert.match(outcome.stderr, /unsafe_lock|synthetic_(prepare|directory)_sync_failure/u);
    assert.equal((await readdir(directory)).includes('.lock'), false);
    assert.equal((await readdir(directory)).some(name => name.startsWith('.lock-')), false, 'failure cleans test-owned private preparation');
    await configured(f.config, async () => {
      if (location === 'root') await submitMetric(event(another));
      assert.equal((await flushMetricQueue()).pending, location === 'root' ? 1 : 0);
    });
  }
});

test('two reclaimers serialize old-dead-lock removal through new publication; the loser cannot enter a live owner operation', async t => {
  for (const location of ['root', 'target'] as const) {
    const f = await fixture(t);
    const directory = location === 'root' ? f.outbox : f.target;
    const previous = JSON.stringify({ pid: await deadPid(), nonce: 'dead-owner' });
    await writeFile(join(directory, '.lock'), previous, { mode: 0o600 });
    const a = start(f, directory, 'reap-and-operate', location === 'root' ? 'submit' : 'flush');
    t.after(async () => { a.child.kill('SIGKILL'); await a.finished; });
    await phase(a.child, 'before-reap-unlink');
    await completeLock(join(directory, '.lock-reaper'), a.child.pid!);
    assert.equal(await readFile(join(directory, '.lock'), 'utf8'), previous);
    const b = start(f, directory, 'competing-reap', location === 'root' ? 'submit' : 'flush', another);
    t.after(async () => { b.child.kill('SIGKILL'); await b.finished; });
    const entered: string[] = [];
    b.child.on('message', message => { if ((message as { phase?: string })?.phase === 'operation-entered') entered.push('operation-entered'); });
    assert.equal(await phaseOneOf(b.child, ['guard-conflict', 'unsafe-published', 'operation-entered']), 'guard-conflict', 'old implementation would publish after deleting A’s confirmed lock');
    await completeLock(join(directory, '.lock-reaper'), a.child.pid!);
    continueChild(a.child);
    await phase(a.child, 'during-operation');
    await completeLock(join(directory, '.lock'), a.child.pid!);
    const rejected = await b.finished;
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /outbox_locked/u);
    assert.deepEqual(entered, [], 'B must not enter the operation while A owns the replacement lock');
    await completeLock(join(directory, '.lock'), a.child.pid!);
    continueChild(a.child);
    assert.equal((await a.finished).code, 0);
    assert.equal((await readdir(directory)).includes('.lock'), false);
    assert.equal((await readdir(directory)).includes('.lock-reaper'), false);
  }
});

test('an ordinary publisher winning after stale unlink is never deleted by the guarded reclaimer', async t => {
  const f = await fixture(t);
  const lock = join(f.target, '.lock'), guard = join(f.target, '.lock-reaper');
  await writeFile(lock, JSON.stringify({ pid: await deadPid(), nonce: 'dead-owner' }), { mode: 0o600 });
  const reaper = start(f, f.target, 'ordinary-wins', 'flush');
  t.after(async () => { reaper.child.kill('SIGKILL'); await reaper.finished; });
  await phase(reaper.child, 'after-reap-unlink');
  await completeLock(guard, reaper.child.pid!);
  assert.equal((await readdir(f.target)).includes('.lock'), false);
  const ordinary = start(f, f.target, 'during-operation', 'flush');
  t.after(async () => { ordinary.child.kill('SIGKILL'); await ordinary.finished; });
  await phase(ordinary.child, 'during-operation');
  const won = await completeLock(lock, ordinary.child.pid!);
  continueChild(reaper.child);
  const rejected = await reaper.finished;
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /outbox_locked/u);
  assert.deepEqual(await completeLock(lock, ordinary.child.pid!), won);
  assert.equal((await readdir(f.target)).includes('.lock-reaper'), false);
  continueChild(ordinary.child);
  assert.equal((await ordinary.finished).code, 0);
  assert.equal((await readdir(f.target)).includes('.lock'), false);
});

test('dead, empty, live and unsafe reaper guards stop reclamation without removing an old lock', async t => {
  const f = await fixture(t);
  const lock = join(f.target, '.lock'), guard = join(f.target, '.lock-reaper');
  const previous = JSON.stringify({ pid: await deadPid(), nonce: 'original-dead-owner' });
  await writeFile(lock, previous, { mode: 0o600 });
  const crashed = start(f, f.target, 'after-link-guard', 'flush');
  t.after(async () => { crashed.child.kill('SIGKILL'); await crashed.finished; });
  await phase(crashed.child, 'after-link-guard');
  await completeLock(guard, crashed.child.pid!);
  crashed.child.kill('SIGKILL');
  assert.equal((await crashed.finished).signal, 'SIGKILL');
  const outside = join(f.root, 'external-guard');
  await writeFile(outside, 'unchanged', { mode: 0o600 });
  for (const type of ['crashed', 'empty', 'live', 'unsafe', 'symlink'] as const) {
    if (type !== 'crashed') {
      if (type === 'symlink') await symlink(outside, guard);
      else await writeFile(guard, type === 'empty' ? '' : JSON.stringify({ pid: process.pid, nonce: type }), { mode: type === 'unsafe' ? 0o644 : 0o600 });
    }
    await assert.rejects(configured(f.config, () => flushMetricQueue()), /outbox_locked/u);
    assert.equal(await readFile(lock, 'utf8'), previous, 'unknown guard cannot authorize deletion of old lock');
    assert.ok((await lstat(guard)).isSymbolicLink() === (type === 'symlink'));
    await unlink(guard); // only this test fixture’s guard; production has no auto-reap
  }
  assert.equal(await readFile(outside, 'utf8'), 'unchanged');
  assert.equal((await configured(f.config, () => flushMetricQueue())).pending, 0, 'dead PID remains reclaimable after explicit test-fixture guard removal');
});

test('lost reaper guard fails closed and its error cleanup cannot remove a replacement guard or the old lock', async t => {
  for (const mutation of ['inode', 'nonce'] as const) {
    const f = await fixture(t);
    const lock = join(f.target, '.lock'), guard = join(f.target, '.lock-reaper');
    const previous = JSON.stringify({ pid: await deadPid(), nonce: 'old' });
    await writeFile(lock, previous, { mode: 0o600 });
    const child = start(f, f.target, 'before-recheck', 'flush');
    t.after(async () => { child.child.kill('SIGKILL'); await child.finished; });
    await phase(child.child, 'before-recheck');
    await completeLock(guard, child.child.pid!);
    if (mutation === 'inode') await unlink(guard);
    const replacement = JSON.stringify({ pid: process.pid, nonce: `foreign-guard-${mutation}` });
    await writeFile(guard, replacement, { mode: 0o600 });
    continueChild(child.child);
    const rejected = await child.finished;
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /outbox_reaper_lost/u);
    assert.equal(await readFile(lock, 'utf8'), previous);
    assert.equal(await readFile(guard, 'utf8'), replacement, 'release must only unlink its original guard');
    await unlink(guard); // test-owned replacement only
  }
});

test('changed dead-lock inode or nonce under a held guard is not reclaimed', async t => {
  for (const mutation of ['inode', 'nonce'] as const) {
    const f = await fixture(t);
    const lock = join(f.target, '.lock');
    await writeFile(lock, JSON.stringify({ pid: await deadPid(), nonce: 'old' }), { mode: 0o600 });
    const child = start(f, f.target, 'before-recheck', 'flush');
    t.after(async () => { child.child.kill('SIGKILL'); await child.finished; });
    await phase(child.child, 'before-recheck');
    await completeLock(join(f.target, '.lock-reaper'), child.child.pid!);
    if (mutation === 'inode') await unlink(lock);
    const replacement = JSON.stringify({ pid: process.pid, nonce: `live-${mutation}` });
    await writeFile(lock, replacement, { mode: 0o600 });
    continueChild(child.child);
    const rejected = await child.finished;
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /outbox_locked/u);
    assert.equal(await readFile(lock, 'utf8'), replacement);
    assert.equal((await readdir(f.target)).includes('.lock-reaper'), false, 'only owned reaper guard is released');
    await unlink(lock); // test-owned replacement only
  }
});

test('empty, live, unsafe-permission and symlink external locks remain untouched', async t => {
  const f = await fixture(t);
  const lock = join(f.target, '.lock');
  const outside = join(f.root, 'external');
  await writeFile(outside, 'outside', { mode: 0o600 });
  for (const item of [
    { value: '', mode: 0o600 },
    { value: JSON.stringify({ pid: process.pid, nonce: 'live-owner' }), mode: 0o600 },
    { value: JSON.stringify({ pid: -1, nonce: 'unsafe' }), mode: 0o644 },
  ]) {
    await writeFile(lock, item.value, { mode: item.mode });
    await assert.rejects(configured(f.config, () => flushMetricQueue()), /outbox_locked/u);
    assert.equal(await readFile(lock, 'utf8'), item.value);
    assert.equal((await lstat(lock)).mode & 0o777, item.mode);
    await unlink(lock);
  }
  await symlink(outside, lock);
  await assert.rejects(configured(f.config, () => flushMetricQueue()), /outbox_locked/u);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  assert.ok((await lstat(lock)).isSymbolicLink());
  await unlink(lock);
  assert.equal((await configured(f.config, () => flushMetricQueue())).pending, 0);
});
