import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export const OWNER_ONLY_FILE = 0o600;
export const OWNER_ONLY_DIR = 0o700;
const O_NOFOLLOW = nodeFs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = nodeFs.constants.O_DIRECTORY ?? 0;

export function ownerOwned(stat: nodeFs.Stats): boolean {
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  return typeof getuid === "function" && stat.uid === getuid();
}
export function ownerReadableFileSync(file: string): nodeFs.Stats | undefined {
  try { const stat = nodeFs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || !ownerOwned(stat) || stat.nlink !== 1 || (stat.mode & 0o022) !== 0) return undefined; return stat; } catch { return undefined; }
}
export interface StableOwnerFile { stat: nodeFs.Stats; realpath: string; content: string; digest: string; }
export function readStableOwnerFileSync(file: string): StableOwnerFile | undefined {
  let fd: number | undefined;
  try {
    fd = nodeFs.openSync(file, nodeFs.constants.O_RDONLY | O_NOFOLLOW);
    const before = nodeFs.fstatSync(fd); const pathBefore = nodeFs.lstatSync(file); if (!ownerReadableFileSync(file) || !sameIdentity(before, pathBefore)) return undefined;
    const content = nodeFs.readFileSync(fd, "utf8"); const after = nodeFs.fstatSync(fd); const pathAfter = nodeFs.lstatSync(file); if (!sameIdentity(before, after) || !sameIdentity(after, pathAfter) || !ownerReadableFileSync(file)) return undefined;
    const realpath = nodeFs.realpathSync(file); return { stat: after, realpath, content, digest: createHash("sha256").update(content).digest("hex") };
  } catch { return undefined; } finally { if (fd !== undefined) try { nodeFs.closeSync(fd); } catch {} }
}
export function ownerFileSync(file: string): nodeFs.Stats | undefined {
  try { const stat = nodeFs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || !ownerOwned(stat) || stat.nlink !== 1 || (stat.mode & 0o777) !== OWNER_ONLY_FILE) return undefined; return stat; } catch { return undefined; }
}
export function trustedDirectorySync(directory: string): { stat: nodeFs.Stats; realpath: string } | undefined { try { const stat = nodeFs.lstatSync(directory); const realpath = nodeFs.realpathSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOwned(stat) || (stat.mode & 0o022) !== 0 || !path.isAbsolute(realpath)) return undefined; return { stat, realpath }; } catch { return undefined; } }
export function ownerDirectorySync(directory: string): { stat: nodeFs.Stats; realpath: string } | undefined {
  try { const stat = nodeFs.lstatSync(directory); const realpath = nodeFs.realpathSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || !ownerOwned(stat) || (stat.mode & 0o777) !== OWNER_ONLY_DIR || !path.isAbsolute(realpath)) return undefined; return { stat, realpath }; } catch { return undefined; }
}
export async function syncDirectory(directory: string): Promise<void> { const handle = await fs.open(directory, nodeFs.constants.O_RDONLY | O_DIRECTORY); try { await handle.sync(); } finally { await handle.close(); } }
export async function ensureOwnerDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIR });
  if (!ownerDirectorySync(directory)) throw new Error("owner-only directory identity cannot be proven");
}
export function sameIdentity(a: nodeFs.Stats, b: nodeFs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
export async function openOwnerFile(file: string, flags: number, mode = OWNER_ONLY_FILE): Promise<fs.FileHandle> {
  let before: nodeFs.Stats | undefined;
  try { before = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (before && !ownerFileSync(file)) throw new Error("owner-only file identity cannot be proven");
  const handle = await fs.open(file, flags | O_NOFOLLOW, mode);
  try { const after = await handle.stat(); const pathStat = await fs.lstat(file); if (!ownerFileSync(file) || !sameIdentity(after, pathStat)) throw new Error("owner-only file path identity changed"); return handle; } catch (error) { await handle.close(); throw error; }
}
export function readOwnerJsonSync<T>(file: string): T | undefined { try { const stat = ownerFileSync(file); if (!stat) return undefined; return JSON.parse(nodeFs.readFileSync(file, "utf8")) as T; } catch { return undefined; } }
export function atomicOwnerJsonSync(file: string, value: unknown): void {
  const parent = path.dirname(file); if (!ownerDirectorySync(parent)) throw new Error("owner-only parent directory cannot be proven"); const serialized = JSON.stringify(value); const pending = `${file}.pending`; let fd: number | undefined;
  try { fd = nodeFs.openSync(pending, nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL, OWNER_ONLY_FILE); nodeFs.writeFileSync(fd, serialized, "utf8"); nodeFs.fsyncSync(fd); nodeFs.closeSync(fd); fd = undefined; nodeFs.renameSync(pending, file); const dirfd = nodeFs.openSync(parent, nodeFs.constants.O_RDONLY | O_DIRECTORY); try { nodeFs.fsyncSync(dirfd); } finally { nodeFs.closeSync(dirfd); } if (!ownerFileSync(file)) throw new Error("atomic owner-only file identity cannot be proven"); } catch (error) { if (fd !== undefined) try { nodeFs.closeSync(fd); } catch {} throw error; }
}
export async function atomicOwnerJson(file: string, value: unknown): Promise<void> {
  const parent = path.dirname(file); await ensureOwnerDirectory(parent); const serialized = JSON.stringify(value); const pending = `${file}.pending`;
  try {
    const pendingHandle = await openOwnerFile(pending, nodeFs.constants.O_RDONLY);
    const existing = await pendingHandle.readFile("utf8"); await pendingHandle.close();
    if (existing !== serialized) { await fs.unlink(pending); } else { await fs.rename(pending, file); await syncDirectory(parent); return; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const handle = await openOwnerFile(pending, nodeFs.constants.O_WRONLY | nodeFs.constants.O_CREAT | nodeFs.constants.O_EXCL);
  try { await handle.writeFile(serialized, "utf8"); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(pending, file); await syncDirectory(parent); if (!ownerFileSync(file)) throw new Error("atomic owner-only file identity cannot be proven");
}
