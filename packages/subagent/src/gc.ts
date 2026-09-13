import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withIdentityLock } from "./session-lock.ts";
import { isValidSessionRegistry, type SessionRegistry } from "./session-identity.ts";

export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function readRegistry(file: string): Promise<SessionRegistry | undefined> {
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"));
    return isValidSessionRegistry(value) ? value : undefined;
  } catch { return undefined; }
}

export interface GcOptions {
  rootDir: string;
  now?: Date;
  retentionMs?: number;
}

export interface GcResult {
  scanned: number;
  removed: number;
  skippedBusy: number;
  skippedFresh: number;
}

const TOMBSTONE_PATTERN = /^([a-f0-9]{64})\.json\.tombstone-[A-Za-z0-9-]+$/;

/**
 * GC is deliberately registry-driven. It never scans or removes ordinary Pi sessions.
 * The registry is renamed to a tombstone while holding the same identity lock used by dispatch.
 */
export async function garbageCollect(options: GcOptions): Promise<GcResult> {
  const result: GcResult = { scanned: 0, removed: 0, skippedBusy: 0, skippedFresh: 0 };
  const registryDir = path.join(options.rootDir, "registry");
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(registryDir, { withFileTypes: true }); } catch { return result; }
  const cutoff = (options.now ?? new Date()).getTime() - (options.retentionMs ?? DEFAULT_RETENTION_MS);

  // A crash after rename leaves only a tombstone. Recover those first so a
  // later pass cannot silently accumulate abandoned metadata.
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = TOMBSTONE_PATTERN.exec(entry.name);
    if (!match) continue;
    result.scanned += 1;
    const key = match[1];
    const tombstone = path.join(registryDir, entry.name);
    const locked = await withIdentityLock({ rootDir: options.rootDir, key }, async () => {
      const currentRegistryFile = path.join(registryDir, `${key}.json`);
      try {
        // A tombstone is a deletion transaction, not evidence that a newer
        // registry is safe. Dispatch blocks this identity while it exists;
        // recovery therefore removes the session and all metadata first.
        await fs.promises.rm(path.join(options.rootDir, "sessions", key), { recursive: true, force: true });
        await fs.promises.rm(currentRegistryFile, { force: true });
        await fs.promises.rm(tombstone, { force: true });
        return true;
      } catch {
        // Keep the tombstone as the durable retry marker for the next GC pass.
        return false;
      }
    });
    if (locked === undefined) result.skippedBusy += 1;
    else if (locked) result.removed += 1;
    else result.skippedFresh += 1;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    result.scanned += 1;
    const key = entry.name.slice(0, -5);
    const registryFile = path.join(registryDir, entry.name);
    const locked = await withIdentityLock({ rootDir: options.rootDir, key }, async () => {
      const registry = await readRegistry(registryFile);
      if (!registry || registry.key !== key) return false;
      const lastActivity = Date.parse(registry.lastActivityAt);
      if (!Number.isFinite(lastActivity) || lastActivity > cutoff) return false;
      const tombstone = `${registryFile}.tombstone-${randomUUID()}`;
      await fs.promises.rename(registryFile, tombstone);
      try {
        await fs.promises.rm(path.join(options.rootDir, "sessions", key), { recursive: true, force: true });
        await fs.promises.rm(tombstone, { force: true });
        return true;
      } catch {
        // Do not delete the tombstone on a partial failure. The next GC pass
        // will safely resume deletion while holding the same identity lock.
        return false;
      }
    });
    if (locked === undefined) result.skippedBusy += 1;
    else if (locked) result.removed += 1;
    else result.skippedFresh += 1;
  }
  return result;
}

