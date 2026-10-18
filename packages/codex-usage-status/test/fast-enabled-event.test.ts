import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, lstat, readFile, readdir, mkdir, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFastEnabledEvent } from '../src/fast-enabled-event.ts';

const EVENT_ID = '4a19dc3b-8397-4d74-834f-a19ec67e891c';

async function agentDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'fast-event-test-'));
  t.after(async () => { await (await import('node:fs/promises')).rm(root, { recursive: true, force: true }); });
  return root;
}

function eventsPath(root: string): string {
  return join(root, 'metrics', 'codex-fast-enabled', 'v1');
}

test('commits only the four whitelisted fields under private directories and a private file', async (t) => {
  const root = await agentDir(t);
  await writeFastEnabledEvent(root, () => EVENT_ID);
  const dir = eventsPath(root);
  assert.equal((await lstat(join(root, 'metrics'))).mode & 0o777, 0o700);
  assert.equal((await lstat(join(root, 'metrics', 'codex-fast-enabled'))).mode & 0o777, 0o700);
  assert.equal((await lstat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dir), [`${EVENT_ID}.json`]);
  const path = join(dir, `${EVENT_ID}.json`);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  const record = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(record), ['schemaVersion', 'eventId', 'occurredAt', 'source']);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.eventId, EVENT_ID);
  assert.equal(record.source, 'user_command');
  assert.match(record.occurredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u);
  assert.equal(new Date(record.occurredAt).toISOString(), record.occurredAt);
});

test('exclusive commit never overwrites a colliding ID or a symlink target', async (t) => {
  const root = await agentDir(t);
  await writeFastEnabledEvent(root, () => EVENT_ID);
  const dir = eventsPath(root);
  const path = join(dir, `${EVENT_ID}.json`);
  const original = await readFile(path, 'utf8');
  await assert.rejects(writeFastEnabledEvent(root, () => EVENT_ID), { code: 'EEXIST' });
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual(await readdir(dir), [`${EVENT_ID}.json`]);

  const otherId = '07ee11a9-4f53-4aa3-8287-57ec5be04755';
  const target = join(root, 'target');
  await writeFile(target, 'untouched');
  await symlink(target, join(dir, `${otherId}.json`));
  await assert.rejects(writeFastEnabledEvent(root, () => otherId), { code: 'EEXIST' });
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  assert.equal(await readFile(path, 'utf8'), original);
  assert.deepEqual((await readdir(dir)).sort(), [`${otherId}.json`, `${EVENT_ID}.json`].sort());
});

test('refuses a symlinked agent root without writing through it',async t=>{const root=await agentDir(t),outside=await agentDir(t);const alias=join(root,'agent-link');await symlink(outside,alias);await assert.rejects(writeFastEnabledEvent(alias,()=>EVENT_ID));assert.deepEqual(await readdir(outside),[]);});

test('refuses symlink, non-directory, and non-private storage components without modifying the target', async (t) => {
  for (const part of ['metrics', 'codex-fast-enabled', 'v1'] as const) {
    const root = await agentDir(t);
    const parent = part === 'metrics' ? root : part === 'codex-fast-enabled' ? join(root, 'metrics') : join(root, 'metrics', 'codex-fast-enabled');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const target = join(root, `target-${part}`);
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(parent, part));
    await assert.rejects(writeFastEnabledEvent(root, () => EVENT_ID));
    assert.deepEqual(await readdir(target), []);
  }
  for (const part of ['metrics', 'codex-fast-enabled', 'v1'] as const) {
    const root = await agentDir(t);
    const parent = part === 'metrics' ? root : part === 'codex-fast-enabled' ? join(root, 'metrics') : join(root, 'metrics', 'codex-fast-enabled');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await writeFile(join(parent, part), 'not a directory');
    await assert.rejects(writeFastEnabledEvent(root, () => EVENT_ID));
  }
  const root = await agentDir(t);
  await mkdir(join(root, 'metrics'), { mode: 0o755 });
  await assert.rejects(writeFastEnabledEvent(root, () => EVENT_ID));
  assert.equal((await lstat(join(root, 'metrics'))).mode & 0o777, 0o755);
});

test('a missing/unwritable agent root fails without creating an event', async (t) => {
  const root = await agentDir(t);
  await assert.rejects(writeFastEnabledEvent(join(root, 'missing'), () => EVENT_ID));
  assert.deepEqual(await readdir(root), []);
});
