import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

// Check each owned component independently; recursive mkdir can traverse a pre-existing symlink.
async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await lstat(path);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== DIRECTORY_MODE) {
    throw new Error('Unsafe Fast event directory');
  }
}

/** One complete file per user activation; callers must not use this for restoring requested intent. */
export async function writeFastEnabledEvent(agentDir = getAgentDir(), newId = randomUUID): Promise<void> {
  const metrics = join(agentDir, 'metrics');
  const extensionDir = join(metrics, 'codex-fast-enabled');
  const eventDir = join(extensionDir, 'v1');
  await ensurePrivateDirectory(metrics);
  await ensurePrivateDirectory(extensionDir);
  await ensurePrivateDirectory(eventDir);

  const eventId = newId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(eventId)) {
    throw new Error('Invalid Fast event ID');
  }
  const record = JSON.stringify({
    schemaVersion: 1,
    eventId,
    occurredAt: new Date().toISOString(),
    source: 'user_command',
  });
  const pending = join(eventDir, `.${eventId}.${randomUUID()}.tmp`);
  const destination = join(eventDir, `${eventId}.json`);
  // The final name is visible only after the complete, synced temporary file is linked.
  // link() fails with EEXIST rather than replacing an existing file or symlink.
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o777) !== FILE_MODE) throw new Error('Unsafe Fast event file');
      await file.writeFile(record, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await link(pending, destination);
  } finally {
    // A crash can leave a .tmp file, which is never a committed event.
    await unlink(pending).catch(() => {});
  }
}
