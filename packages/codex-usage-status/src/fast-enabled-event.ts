import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

async function verifyDirectoryTree(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Unsafe Fast event directory');
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe Fast event directory');
  }
}
// Verify every parent without following links, then create only the package-owned leaf.
async function ensurePrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Unsafe Fast event directory');
  await verifyDirectoryTree(dirname(path));
  try { await mkdir(path, { mode: DIRECTORY_MODE }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe Fast event directory');
}

/** One complete file per user activation; callers must not use this for restoring requested intent. */
export type FastEnabledRecord = { schemaVersion: 1; eventId: string; occurredAt: string; source: 'user_command' };
export function captureFastEnabledEvent(newId = randomUUID, now = () => new Date().toISOString()): FastEnabledRecord {
  const eventId = newId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(eventId)) throw new Error('Invalid Fast event ID');
  return Object.freeze({ schemaVersion: 1, eventId, occurredAt: now(), source: 'user_command' });
}
export async function writeFastEnabledEvent(agentDir = getAgentDir(), newId = randomUUID): Promise<FastEnabledRecord> {
  return commitFastEnabledEvent(captureFastEnabledEvent(newId), agentDir);
}
export async function commitFastEnabledEvent(committed: FastEnabledRecord, agentDir = getAgentDir()): Promise<FastEnabledRecord> {
  // The already captured fact, not a later observation of requested state or wall time.
  if (committed.schemaVersion !== 1 || committed.source !== 'user_command' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(committed.eventId) || !Number.isFinite(Date.parse(committed.occurredAt)) || new Date(committed.occurredAt).toISOString() !== committed.occurredAt) throw new Error('Invalid Fast event');
  const metrics = join(agentDir, 'metrics');
  const extensionDir = join(metrics, 'codex-fast-enabled');
  const eventDir = join(extensionDir, 'v1');
  await ensurePrivateDirectory(metrics);
  await ensurePrivateDirectory(extensionDir);
  await ensurePrivateDirectory(eventDir);

  const eventId = committed.eventId;
  const record = JSON.stringify({ schemaVersion: 1, eventId, occurredAt: committed.occurredAt, source: 'user_command' });
  const pending = join(eventDir, `.${eventId}.${randomUUID()}.tmp`);
  const destination = join(eventDir, `${eventId}.json`);
  // The final name is visible only after the complete, synced temporary file is linked.
  // link() fails with EEXIST rather than replacing an existing file or symlink.
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== FILE_MODE || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe Fast event file');
      await file.writeFile(record, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await link(pending, destination);
    return committed;
  } finally {
    // A crash can leave a .tmp file, which is never a committed event.
    await unlink(pending).catch(() => {});
  }
}
