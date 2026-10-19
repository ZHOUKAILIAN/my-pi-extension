import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

type LockHandle = { release(): Promise<void> };
type LockSyncHandle = { release(): void };
type LockApi = { lock(file: string, options: Record<string, unknown>): Promise<() => Promise<void>>; lockSync(file: string, options: Record<string, unknown>): () => void };
const lockfile = createRequire(import.meta.url)('proper-lockfile') as LockApi;

export type MachineExtensionSettings = { fast?: boolean; asyncCompaction?: boolean; [key: string]: unknown };
export type MachineSettingsDocument = { [key: string]: unknown; myPiExtensions?: MachineExtensionSettings };
export type MachinePreference = 'fast' | 'asyncCompaction';
const MAX_BYTES = 1024 * 1024;
const LOCK_OPTIONS = { stale: 5000, update: 1000, retries: { retries: 8, minTimeout: 20, maxTimeout: 125 } };
const LOCK_SYNC_OPTIONS = { ...LOCK_OPTIONS, retries: { retries: 0 } };

export function settingsFile(explicit?: string): string {
  const candidate = explicit ?? process.env.PI_MY_EXTENSIONS_SETTINGS_FILE ?? `${getAgentDir()}/settings.json`;
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate) throw new Error('unsafe_settings_path');
  return candidate;
}
function validateMode(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function preferenceValue(document: MachineSettingsDocument, preference: MachinePreference): boolean | undefined {
  const value = document.myPiExtensions?.[preference];
  return validateMode(value);
}
function parseDocument(text: string): MachineSettingsDocument | undefined {
  if (Buffer.byteLength(text) > MAX_BYTES) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const document = value as Record<string, unknown>;
    if (document.myPiExtensions !== undefined && (!document.myPiExtensions || typeof document.myPiExtensions !== 'object' || Array.isArray(document.myPiExtensions) || Object.getPrototypeOf(document.myPiExtensions) !== Object.prototype)) return undefined;
    return document as MachineSettingsDocument;
  } catch { return undefined; }
}
function validatePath(file: string, allowMissing = true): void {
  if (!isAbsolute(file) || resolve(file) !== file) throw new Error('unsafe_settings_path');
  const parent = dirname(file);
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('unsafe_settings_parent');
  if (!allowMissing) {
    const fileStat = lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error('unsafe_settings_file');
    if (process.getuid && fileStat.uid !== process.getuid()) throw new Error('unsafe_settings_owner');
  }
}
async function ensureParent(file: string): Promise<void> {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('unsafe_settings_parent');
}
function ensureSyncParent(file: string): void {
  const parent = dirname(file); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) throw new Error('unsafe_settings_parent');
}
async function readUnlocked(file: string): Promise<MachineSettingsDocument | undefined> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES || (process.getuid && info.uid !== process.getuid())) return undefined;
      return parseDocument(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch { return undefined; }
}
function readUnlockedSync(file: string): MachineSettingsDocument | undefined {
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_BYTES || (process.getuid && info.uid !== process.getuid())) return undefined;
      return parseDocument(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
  } catch { return undefined; }
}
async function withLock<T>(file: string, operation: () => Promise<T>, create = false): Promise<T> {
  let exists = true;
  try { await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
  if (!exists && !create) return operation();
  if (!exists) {
    await ensureParent(file);
    const marker = `${file}.creation-lock`;
    try { await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).then(handle => handle.close()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const markerRelease = await lockfile.lock(marker, LOCK_OPTIONS);
    try {
      try { await lstat(file); } catch { /* still absent; operation creates it */ }
      return await operation();
    } finally { await markerRelease(); }
  }
  const release = await lockfile.lock(file, LOCK_OPTIONS);
  try { return await operation(); } finally { await release(); }
}
function withLockSync<T>(file: string, operation: () => T, create = false): T {
  let exists = true;
  try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; exists = false; }
  if (!exists && !create) return operation();
  if (!exists) {
    ensureSyncParent(file);
    const marker = `${file}.creation-lock`;
    try { const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const release = lockfile.lockSync(marker, LOCK_SYNC_OPTIONS);
    try { return operation(); } finally { release(); }
  }
  const release = lockfile.lockSync(file, LOCK_SYNC_OPTIONS);
  try { return operation(); } finally { release(); }
}
async function atomicWrite(file: string, document: MachineSettingsDocument): Promise<void> {
  const originalMode = await lstat(file).then(stat => stat.mode & 0o777).catch(() => 0o600);
  const text = JSON.stringify(document);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('settings_too_large');
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  if (originalMode !== 0o600) await chmod(file, originalMode);
}
function atomicWriteSync(file: string, document: MachineSettingsDocument): void {
  const originalMode = (() => { try { return statSync(file).mode & 0o777; } catch { return 0o600; } })();
  const text = JSON.stringify(document);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('settings_too_large');
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text, 'utf8'); } finally { closeSync(fd); }
  renameSync(temporary, file); if (originalMode !== 0o600) chmodSync(file, originalMode);
}
export async function readMachinePreference(preference: MachinePreference, explicit?: string): Promise<{ value?: boolean; valid: boolean }> {
  let file: string;
  try { file = settingsFile(explicit); } catch { return { valid: false }; }
  try {
    return await withLock(file, async () => { const document = await readUnlocked(file); const value = document ? preferenceValue(document, preference) : undefined; return { value, valid: document !== undefined && (document.myPiExtensions?.[preference] === undefined || value !== undefined) }; });
  } catch { return { valid: false }; }
}
export function readMachinePreferenceSync(preference: MachinePreference, explicit?: string): { value?: boolean; valid: boolean } {
  let file: string;
  try { file = settingsFile(explicit); } catch { return { valid: false }; }
  try {
    return withLockSync(file, () => { const document = readUnlockedSync(file); const value = document ? preferenceValue(document, preference) : undefined; return { value, valid: document !== undefined && (document.myPiExtensions?.[preference] === undefined || value !== undefined) }; });
  } catch { return { valid: false }; }
}
export async function writeMachinePreference(preference: MachinePreference, value: boolean, explicit?: string): Promise<void> {
  if (typeof value !== 'boolean') throw new Error('invalid_preference');
  const file = settingsFile(explicit);
  await withLock(file, async () => {
    const exists = await lstat(file).then(() => true).catch(() => false);
    const current = await readUnlocked(file);
    if (current === undefined && exists) throw new Error('invalid_settings');
    const extensions = current?.myPiExtensions && typeof current.myPiExtensions === 'object' ? { ...current.myPiExtensions } : {};
    extensions[preference] = value;
    await atomicWrite(file, { ...(current ?? {}), myPiExtensions: extensions });
  }, true);
}
export function writeMachinePreferenceSync(preference: MachinePreference, value: boolean, explicit?: string): void {
  if (typeof value !== 'boolean') throw new Error('invalid_preference');
  const file = settingsFile(explicit);
  withLockSync(file, () => {
    const exists = (() => { try { lstatSync(file); return true; } catch { return false; } })();
    const current = readUnlockedSync(file);
    if (current === undefined && exists) throw new Error('invalid_settings');
    const extensions = current?.myPiExtensions && typeof current.myPiExtensions === 'object' ? { ...current.myPiExtensions } : {};
    extensions[preference] = value;
    atomicWriteSync(file, { ...(current ?? {}), myPiExtensions: extensions });
  }, true);
}
export async function updateMachinePreference(preference: MachinePreference, value: boolean, explicit?: string): Promise<{ saved: boolean }> { try { await writeMachinePreference(preference, value, explicit); return { saved: true }; } catch { return { saved: false }; } }
export function machineAgentType(value = process.env.PI_MY_EXTENSIONS_AGENT_TYPE): 'main' | 'subagent' | 'unknown' { return value === 'main' || value === 'subagent' ? value : 'unknown'; }
