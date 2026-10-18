import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { normalizeEvent, type Dataset } from './contracts.ts';
import { canonicalTarget } from './node-crypto.ts';
import { validateStatsResponse } from './stats-response.ts';

type Config = { enabled: boolean; endpoint: string; namespace: string; dataset: Dataset; writeTokenFile: string; readTokenFile: string; outboxDir: string };
type Envelope = { targetId: string; endpoint: string; namespace: string; dataset: Dataset; event: ReturnType<typeof normalizeEvent> };
type FlushResult = { sent: number; pending: number; failed: number; unknown: boolean };
const MAX_EVENTS = 512, MAX_RECORD = 16 * 1024, MAX_MEMORY = 32, MAX_BATCH = 16, MAX_ACK = 2048;
let inFlight = 0;
const localPending = new Set<Promise<unknown>>();
type FlushTask = Promise<FlushResult> & { rerun?: boolean };
const backgroundFlushes = new Map<string, FlushTask>();
/** Per-producer lifecycle. Explicit CLI flushes have no producer scope. */
export class MetricScope {
  closed = false;
  readonly attempts = new Set<() => void>();
  readonly flushes = new Map<string, FlushTask>();
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.attempts]) cancel();
  }
}
export function createMetricScope(): MetricScope { return new MetricScope(); }
const targetCounters = new Map<string, { failed: number; unknown: boolean }>();
let unattributedUnknown = false;
function diagnostic(targetId: string) {
  let value = targetCounters.get(targetId);
  if (!value) { value = { failed: 0, unknown: true }; targetCounters.set(targetId, value); }
  return value;
}

async function inspectPath(path: string, kind: 'file' | 'directory', privateMode = true): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('unsafe_path');
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('unsafe_path');
    const final = current === path;
    if (final && ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory()))) throw new Error('unsafe_path');
    if (final && privateMode && (stat.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600)) throw new Error('unsafe_permissions');
    if (final && process.getuid && stat.uid !== process.getuid()) throw new Error('unsafe_owner');
  }
}
async function ensurePrivateDir(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('unsafe_path');
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe_path');
    if (current === path && ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid()))) throw new Error('unsafe_permissions');
  }
}
async function readPrivate(path: string, maxBytes = 64 * 1024): Promise<string> {
  await inspectPath(path, 'file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size > maxBytes) throw new Error('unsafe_private_file');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
async function readConfig(): Promise<Config | null> {
  const path = process.env.PI_METRICS_CONFIG;
  if (!path) return null;
  const text = await readPrivate(path, 16 * 1024);
  let config: Config;
  try { config = JSON.parse(text) as Config; } catch { throw new Error('invalid_config'); }
  if (!config || typeof config.enabled !== 'boolean' || (config.dataset !== 'live' && config.dataset !== 'validation') || typeof config.endpoint !== 'string' || typeof config.namespace !== 'string' || typeof config.writeTokenFile !== 'string' || typeof config.readTokenFile !== 'string' || typeof config.outboxDir !== 'string') throw new Error('invalid_config');
  canonicalTarget(config.endpoint, config.namespace, config.dataset);
  for (const path of [config.writeTokenFile, config.readTokenFile, config.outboxDir]) if (!isAbsolute(path)) throw new Error('unsafe_config_path');
  return Object.freeze({ ...config });
}
async function writeExclusive(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), `.${randomUUID()}.tmp`);
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_private_file');
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally { await file.close(); }
  try {
    await (await import('node:fs/promises')).link(temp, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await unlink(temp).catch(() => {}); }
}
type LockIdentity = { dev: number; ino: number };
async function ownsLock(path: string, identity: LockIdentity, nonce: string): Promise<boolean> {
  try {
    const before = await lstat(path);
    const body = JSON.parse(await readPrivate(path, 2048)) as { nonce?: unknown };
    const after = await lstat(path);
    return before.dev === identity.dev && before.ino === identity.ino &&
      after.dev === identity.dev && after.ino === identity.ino && body.nonce === nonce;
  } catch { return false; }
}
// Called only while holding the same directory's reaper guard. Other reclaimers
// cannot validate/unlink this pathname until the guard owner has republished.
async function reclaimStaleLock(path: string, guard: LockIdentity, guardNonce: string): Promise<boolean> {
  try {
    const before = await lstat(path);
    const lock = JSON.parse(await readPrivate(path, 2048)) as { pid?: number; nonce?: string };
    if (!Number.isSafeInteger(lock.pid) || lock.pid! <= 0 || typeof lock.nonce !== 'string' || !lock.nonce) return false;
    let dead = false;
    try { process.kill(lock.pid!, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    const after = await lstat(path);
    const confirm = JSON.parse(await readPrivate(path, 2048)) as { pid?: number; nonce?: string };
    if (!dead || before.dev !== after.dev || before.ino !== after.ino || confirm.pid !== lock.pid || confirm.nonce !== lock.nonce) return false;
    if (!await ownsLock(join(dirname(path), '.lock-reaper'), guard, guardNonce)) throw new Error('outbox_reaper_lost');
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as Error).message === 'outbox_reaper_lost') throw error;
    // Unknown, active or replaced lock: never guess that the old owner is gone.
    return false;
  }
}
async function releaseOwnedLock(path: string, identity: LockIdentity, nonce: string): Promise<void> {
  try {
    const before = await lstat(path);
    const body = JSON.parse(await readPrivate(path, 2048)) as { nonce?: unknown };
    const after = await lstat(path);
    if (before.dev === identity.dev && before.ino === identity.ino &&
        after.dev === identity.dev && after.ino === identity.ino && body.nonce === nonce) await unlink(path);
  } catch { /* never remove a lock without matching inode and nonce */ }
}
async function publishLock(path: string, nonce: string): Promise<LockIdentity | null> {
  const temporary = join(dirname(path), `.lock-${randomUUID()}.tmp`);
  // Prepare privately before exposing .lock. A crash here leaves only an ignored
  // temporary file; a crash after link() leaves a complete, reclaimable PID record.
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let identity: LockIdentity;
  let published = false;
  try {
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_lock');
      identity = { dev: stat.dev, ino: stat.ino };
      const record = JSON.stringify({ pid: process.pid, nonce });
      await file.writeFile(record);
      await file.sync();
      const verified = await file.stat();
      if (verified.dev !== identity.dev || verified.ino !== identity.ino ||
          verified.size !== Buffer.byteLength(record) || await readPrivate(temporary, 2048) !== record) throw new Error('unsafe_lock');
    } finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw error;
    }
    published = true;
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return identity!;
  } catch (error) {
    if (published) await releaseOwnedLock(path, identity!, nonce);
    throw error;
  } finally { await unlink(temporary).catch(() => {}); }
}
async function reclaimAndPublishLock(path: string, nonce: string): Promise<LockIdentity | null> {
  const guardPath = join(dirname(path), '.lock-reaper');
  const guardNonce = randomUUID();
  const guard = await publishLock(guardPath, guardNonce);
  // Never recursively reclaim a busy/unknown reaper guard, including one left
  // by a dead process. A normal acquirer can still publish an absent .lock.
  if (!guard) return null;
  try {
    if (!await reclaimStaleLock(path, guard, guardNonce)) return null;
    // Hold the guard across the new publication. An ordinary publisher may win
    // the gap after unlink; its EEXIST is authoritative, not ours to remove.
    return await publishLock(path, nonce);
  } finally { await releaseOwnedLock(guardPath, guard, guardNonce); }
}
async function withLock<T>(directory: string, operation: () => Promise<T>, waitMs = 1000): Promise<T> {
  const path = join(directory, '.lock');
  const nonce = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    const identity = await publishLock(path, nonce) ?? await reclaimAndPublishLock(path, nonce);
    if (!identity) {
      if (Date.now() >= deadline) throw new Error('outbox_locked');
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    try {
      const current = await lstat(path);
      const body = JSON.parse(await readPrivate(path, 2048)) as { nonce?: unknown };
      if (current.dev !== identity.dev || current.ino !== identity.ino || body.nonce !== nonce) throw new Error('outbox_lock_lost');
      return await operation();
    } finally { await releaseOwnedLock(path, identity, nonce); }
  }
}
async function targetDirectory(config: Config): Promise<{ target: string; targetId: string }> {
  const targetId = canonicalTarget(config.endpoint, config.namespace, config.dataset);
  await ensurePrivateDir(config.outboxDir);
  const target = join(config.outboxDir, targetId);
  await ensurePrivateDir(target);
  return { target, targetId };
}
async function countOutboxEvents(root: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(root)) {
    if (name === '.lock' || name.startsWith('.')) continue;
    if (!/^[0-9a-f]{64}$/u.test(name)) throw new Error('unsafe_outbox_entry');
    const directory = join(root, name);
    await inspectPath(directory, 'directory');
    for (const file of await readdir(directory)) {
      if (!file.endsWith('.json')) continue;
      await inspectPath(join(directory, file), 'file');
      total++;
      if (total >= MAX_EVENTS) return total;
    }
  }
  return total;
}
function track<T>(promise: Promise<T>): Promise<T> {
  localPending.add(promise);
  promise.finally(() => localPending.delete(promise)).catch(() => {});
  return promise;
}
export function noteMetricFailure(): void { unattributedUnknown = true; }
export function drainLocal(timeoutMs = 1000, additional: Iterable<Promise<unknown>> = []): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    Promise.allSettled([...localPending, ...additional]).then(() => { clearTimeout(timer); resolve(true); });
  });
}
export function submitMetric(input: unknown, scope?: MetricScope): Promise<void> {
  if (inFlight >= MAX_MEMORY) { unattributedUnknown = true; return Promise.reject(new Error('metrics_queue_full')); }
  inFlight++;
  let targetId: string | null = null;
  const task = (async () => {
    const config = await readConfig();
    if (!config?.enabled) return;
    const capturedTargetId = canonicalTarget(config.endpoint, config.namespace, config.dataset);
    targetId = capturedTargetId;
    const event = normalizeEvent({ ...(input as Record<string, unknown>), dataset: config.dataset });
    const { target } = await targetDirectory(config);
    const envelope: Envelope = { targetId: capturedTargetId, endpoint: new URL(config.endpoint).origin, namespace: config.namespace, dataset: config.dataset, event };
    const serialized = JSON.stringify(envelope);
    if (Buffer.byteLength(serialized) > MAX_RECORD) throw new Error('record_too_large');
    const path = join(target, `${event.eventId}.json`);
    await withLock(config.outboxDir, async () => withLock(target, async () => {
      const count = await countOutboxEvents(config.outboxDir);
      if (count >= MAX_EVENTS) throw new Error('outbox_full');
      await writeExclusive(path, serialized);
    }));
    if (!scope?.closed) void scheduleFlush(config, scope).catch(() => {});
  })().catch((error) => {
    if (targetId) { diagnostic(targetId).failed++; diagnostic(targetId).unknown = true; }
    else unattributedUnknown = true;
    throw error;
  }).finally(() => { inFlight--; });
  return track(task);
}
function discardBody(response: Response, controller: AbortController): void {
  controller.abort();
  // Undici must not retain an unread error body/socket after headers. A custom
  // reader can ignore cancellation or reject: never await its cleanup promise.
  try { void response.body?.cancel().catch(() => {}); } catch { /* best effort */ }
}
async function readAck(response: Response, controller: AbortController, onReader: (cancel: () => void) => void): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const cancel = () => {
    controller.abort();
    try { void reader.cancel().catch(() => {}); } catch { /* best effort */ }
  };
  onReader(cancel);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ACK) { cancel(); return null; }
      body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
  } catch { cancel(); return null; }
}
// Race the entire POST plus ACK reader, not only an AbortSignal that a transport
// or reader may ignore. Only the raced result can mutate durable outbox state.
async function postAndAck(config: Config, event: Envelope['event'], token: string, scope?: MetricScope): Promise<{ response: Response | null; ack: string | null; unknown: boolean; cancelled: boolean }> {
  if (scope?.closed) return { response: null, ack: null, unknown: true, cancelled: true };
  const controller = new AbortController();
  let cancelReader: (() => void) | undefined;
  let expire!: (cancelled: boolean) => void;
  const cutoff = new Promise<{ response: null; ack: null; unknown: true; cancelled: boolean }>(resolve => {
    expire = cancelled => {
      controller.abort();
      cancelReader?.();
      resolve({ response: null, ack: null, unknown: true, cancelled });
    };
  });
  const cancel = () => expire(true);
  scope?.attempts.add(cancel);
  if (scope?.closed) { cancel(); scope.attempts.delete(cancel); return cutoff; }
  const timer = setTimeout(() => expire(false), 5000);
  if (scope) timer.unref();
  const request = (async () => {
    try {
      const response = await fetch(`${config.endpoint.replace(/\/$/u, '')}/api/v1/project-events`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ namespace: config.namespace, event }),
      });
      // A transport may resolve after ignoring an earlier deadline or shutdown
      // abort. Never start reading that orphaned response or leave its body open.
      if (controller.signal.aborted || scope?.closed) {
        discardBody(response, controller);
        return { response: null, ack: null, unknown: true, cancelled: !!scope?.closed };
      }
      if (!response.ok) {
        discardBody(response, controller);
        return { response, ack: null, unknown: false, cancelled: false };
      }
      const ack = await readAck(response, controller, cancel => { cancelReader = cancel; });
      return { response, ack, unknown: false, cancelled: false };
    } catch {
      controller.abort();
      cancelReader?.();
      return { response: null, ack: null, unknown: true, cancelled: false };
    }
  })();
  try { return await Promise.race([cutoff, request]); }
  finally { clearTimeout(timer); scope?.attempts.delete(cancel); }
}
const blockedPath = (target: string, eventId: string) => join(target, `.blocked-${eventId}`);
const BLOCKED_MARKER = 'permanent_remote_rejection';
async function isBlocked(path: string): Promise<boolean> {
  try { return await readPrivate(path, 64) === BLOCKED_MARKER; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function clearBlocked(path: string): Promise<void> {
  try {
    const before = await lstat(path);
    const body = await readPrivate(path, 64);
    const after = await lstat(path);
    if (body === BLOCKED_MARKER && before.dev === after.dev && before.ino === after.ino && after.isFile() && !after.isSymbolicLink()) await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function blockedCount(target: string): Promise<number> {
  const names = (await readdir(target)).filter((name) => name.startsWith('.blocked-'));
  let count = 0;
  for (const name of names) if (/^\.blocked-[0-9a-f-]{36}$/u.test(name) && await isBlocked(join(target, name))) count++;
  return count;
}
async function flushWithConfig(config: Config, retryPermanent = false, scope?: MetricScope): Promise<FlushResult> {
  const { target, targetId } = await targetDirectory(config);
  const names = await withLock(target, async () => {
    const selected: string[] = [];
    // Scan the bounded 512-entry outbox before taking the batch; blocked entries
    // must not use up slots or starve later committed events.
    for (const name of (await readdir(target)).filter((entry) => entry.endsWith('.json')).sort()) {
      if (retryPermanent || !await isBlocked(blockedPath(target, name.slice(0, -5)))) selected.push(name);
      if (selected.length === MAX_BATCH) break;
    }
    return selected;
  });
  let sent = 0;
  let failed = 0;
  let unknown = false;
  for (const name of names) {
    if (scope?.closed) { unknown = true; break; }
    const path = join(target, name);
    const blocked = blockedPath(target, name.slice(0, -5));
    if (!retryPermanent && await isBlocked(blocked)) continue;
    let raw: string;
    let envelope: Envelope;
    try {
      raw = await readPrivate(path, MAX_RECORD);
      envelope = JSON.parse(raw) as Envelope;
      if (envelope.targetId !== targetId || envelope.endpoint !== new URL(config.endpoint).origin || envelope.namespace !== config.namespace || envelope.dataset !== config.dataset) throw new Error('target_mismatch');
      envelope.event = normalizeEvent(envelope.event);
      if (name !== `${envelope.event.eventId}.json`) throw new Error('event_path_mismatch');
    } catch { failed++; continue; }
    let token: string;
    try {
      token = (await readPrivate(config.writeTokenFile, 4096)).trim();
      if (!/^[!-~]{32,512}$/u.test(token)) throw new Error('invalid_token');
    } catch { failed++; continue; }
    const outcome = await postAndAck(config, envelope.event, token, scope);
    const { response, ack: ackText } = outcome;
    unknown ||= outcome.unknown;
    if (outcome.cancelled || scope?.closed) { unknown = true; break; }
    if (!response) { failed++; continue; }
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) {
        try {
          await withLock(target, async () => {
            if (scope?.closed) return;
            try { await writeExclusive(blocked, BLOCKED_MARKER); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !await isBlocked(blocked)) throw error; }
          });
        } catch { unknown = true; }
      }
      failed++; continue;
    }
    if (!ackText) { failed++; continue; }
    let ack: { eventId?: unknown; status?: unknown };
    try { ack = JSON.parse(ackText) as typeof ack; } catch { failed++; continue; }
    if (ack.eventId !== envelope.event.eventId || (ack.status !== 'accepted' && ack.status !== 'duplicate')) { failed++; continue; }
    try {
      let removed = false;
      await withLock(target, async () => {
        if (scope?.closed) return;
        const before = await lstat(path);
        const current = await readPrivate(path, MAX_RECORD);
        const after = await lstat(path);
        if (!scope?.closed && current === raw && before.dev === after.dev && before.ino === after.ino && after.isFile() && !after.isSymbolicLink()) {
          await unlink(path);
          removed = true;
          await clearBlocked(blocked);
        }
      });
      if (removed) sent++;
      else if (scope?.closed) unknown = true;
    } catch { unknown = true; failed++; }
  }
  const pending = (await readdir(target)).filter((name) => name.endsWith('.json')).length;
  return { sent, pending, failed, unknown };
}
function scheduleFlush(config: Config, scope?: MetricScope): Promise<FlushResult> {
  const targetId = canonicalTarget(config.endpoint, config.namespace, config.dataset);
  const flushes = scope?.flushes ?? backgroundFlushes;
  let state = flushes.get(targetId);
  if (state) { state.rerun = true; return state; }
  let passes = 0;
  const task = Promise.resolve().then(async () => {
    let result: FlushResult;
    do {
      task.rerun = false;
      result = await flushWithConfig(config, false, scope);
      diagnostic(targetId).failed += result.failed;
      diagnostic(targetId).unknown ||= result.unknown;
      passes++;
    } while (task.rerun && passes < 2 && !scope?.closed);
    return result;
  }).catch((error) => { diagnostic(targetId).failed++; diagnostic(targetId).unknown = true; throw error; }).finally(() => {
    if (flushes.get(targetId) === task) flushes.delete(targetId);
    if (task.rerun && !scope?.closed) void scheduleFlush(config, scope).catch(() => {});
  }) as FlushTask;
  task.rerun = false;
  flushes.set(targetId, task);
  return task;
}
export async function flushMetricQueue(retryPermanent = false): Promise<FlushResult | { sent: number; pending: null; failed: number; unknown: true }> {
  const config = await readConfig();
  if (!config) return { sent: 0, pending: null, failed: 0, unknown: true };
  return retryPermanent ? flushWithConfig(config, true) : scheduleFlush(config);
}
async function statusForConfig(config: Config) {
  const targetId = canonicalTarget(config.endpoint, config.namespace, config.dataset);
  const target = join(config.outboxDir, targetId);
  try {
    await inspectPath(config.outboxDir, 'directory');
    let names: string[];
    let blocked = 0;
    try {
      await inspectPath(target, 'directory');
      names = (await readdir(target)).filter((name) => name.endsWith('.json'));
      blocked = await blockedCount(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = [];
      else throw error;
    }
    return { enabled: config.enabled, targetId, pending: names.length, failed: diagnostic(targetId).failed + blocked, unknown: diagnostic(targetId).unknown || unattributedUnknown || names.length > 0 };
  } catch { return { enabled: config.enabled, targetId, pending: null, failed: diagnostic(targetId).failed, unknown: true }; }
}
export async function metricsStatus() {
  try {
    const config = await readConfig();
    if (!config) return { enabled: false, pending: null, failed: 0, unknown: true };
    return statusForConfig(config);
  } catch { return { enabled: false, pending: null, failed: 0, unknown: true }; }
}
type StatsFailureCode = 'stats_timeout' | 'stats_transport' | 'stats_unauthorized' | 'stats_http_error' | 'stats_invalid_response' | 'stats_body_too_large' | 'stats_configuration';
const statsFailures = new WeakMap<object, StatsFailureCode>();
function statsFailure(code: StatsFailureCode): Error {
  const error = new Error(code);
  statsFailures.set(error, code);
  return error;
}
// Only internally minted errors are classified. Never echo a thrown fetch error's
// message or a caller-controlled `.code` property to CLI stderr.
export function statsFailureCode(error: unknown): StatsFailureCode | null {
  try { return error !== null && typeof error === 'object' ? statsFailures.get(error) ?? null : null; }
  catch { return null; }
}
async function boundedJson(response: Response, controller: AbortController, onReader: (cancel: () => void) => void, limit = 2 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw statsFailure('stats_invalid_response');
  const reader = response.body.getReader();
  const cancel = () => {
    controller.abort();
    try { void reader.cancel().catch(() => {}); } catch { /* never await a non-cooperative reader */ }
  };
  onReader(cancel);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw statsFailure('stats_body_too_large');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    cancel();
    throw statsFailureCode(error) ? error : statsFailure('stats_invalid_response');
  }
}
export async function queryMetricStats(days = 7, datasetOverride?: Dataset): Promise<unknown> {
  if (!Number.isInteger(days) || days < 1 || days > 31 || (datasetOverride !== undefined && datasetOverride !== 'live' && datasetOverride !== 'validation')) throw statsFailure('stats_configuration');
  let config: Config;
  let token: string;
  try {
    const loaded = await readConfig();
    if (!loaded) throw statsFailure('stats_configuration');
    config = datasetOverride ? Object.freeze({ ...loaded, dataset: datasetOverride }) : loaded;
    token = (await readPrivate(config.readTokenFile, 4096)).trim();
    if (!/^[!-~]{32,512}$/u.test(token)) throw statsFailure('stats_configuration');
  } catch { throw statsFailure('stats_configuration'); }
  const url = new URL(`${config.endpoint.replace(/\/$/u, '')}/api/v1/project-stats`);
  url.searchParams.set('days', String(days));
  url.searchParams.set('dataset', config.dataset);
  const controller = new AbortController();
  let cancelReader: (() => void) | undefined;
  let timedOut = false;
  let deadlineTimer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      reject(statsFailure('stats_timeout'));
      controller.abort();
      cancelReader?.();
    }, 5000);
    deadlineTimer = timer;
  });
  const request = (async () => {
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'x-project-namespace': config.namespace },
      });
      // Even a fetch that ignores abort may later hand us a live HTTP body.
      if (controller.signal.aborted) { discardBody(response, controller); throw statsFailure('stats_timeout'); }
      if (!response.ok) {
        discardBody(response, controller);
        throw statsFailure(response.status === 401 || response.status === 403 ? 'stats_unauthorized' : 'stats_http_error');
      }
      const json = await boundedJson(response, controller, cancel => { cancelReader = cancel; });
      if (controller.signal.aborted) throw statsFailure('stats_timeout');
      try { return validateStatsResponse(json, config.dataset, days, token); }
      catch { throw statsFailure('stats_invalid_response'); }
    } catch (error) {
      if (timedOut) throw statsFailure('stats_timeout');
      if (statsFailureCode(error)) throw error;
      controller.abort();
      cancelReader?.();
      throw statsFailure('stats_transport');
    }
  })();
  let remote: Awaited<typeof request>;
  try { remote = await Promise.race([request, deadline]); }
  finally { clearTimeout(deadlineTimer); }
  return { ...remote, local: await statusForConfig(config) };
}
