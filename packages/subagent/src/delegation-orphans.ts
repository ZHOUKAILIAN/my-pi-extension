/** Internal private-payload orphan reconciliation. */
import * as fs from "node:fs/promises";
import * as nodeFs from "node:fs";
import * as path from "node:path";
import { withIdentityLock } from "./session-lock.ts";
import { ensureOwnerDirectory, ownerFileSync } from "./secure-fs.ts";
import { readWal } from "./wal-replay.ts";
import { WAL_CONTEXT, dirs, ensureStore } from "./delegation-context.ts";
import type { OrphanReconciliationResult } from "./delegation-types.ts";

function orphanFailure(reasonCode: OrphanReconciliationResult["reasonCode"], isolatedCallIds: string[] = []): OrphanReconciliationResult { return { state: "paused_integrity", reasonCode, isolatedCallIds: [...new Set(isolatedCallIds)], deletedPayloads: 0 }; }
export async function reconcilePrivateOrphansUnlocked(rootDir: string): Promise<OrphanReconciliationResult> {
  const d = await ensureStore(rootDir); const keep = new Set<string>(); let walFiles: nodeFs.Dirent[];
  try { walFiles = await fs.readdir(d.wal, { withFileTypes: true }); } catch { return orphanFailure("orphan_wal_untrusted"); }
  const isolated: string[] = [];
  for (const entry of walFiles) {
    const file = path.join(d.wal, entry.name); const callId = entry.name.endsWith(".jsonl") ? entry.name.slice(0, -6) : entry.name;
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".jsonl") || !/^[0-9a-f]{64}$/.test(callId) || !ownerFileSync(file)) return orphanFailure("orphan_wal_untrusted", [callId]);
    try {
      const realpath = nodeFs.realpathSync(file); const walRoot = nodeFs.realpathSync(d.wal); if (path.dirname(realpath) !== walRoot || path.basename(realpath) !== entry.name) return orphanFailure("orphan_wal_untrusted", [callId]);
      const loaded = await readWal(file, WAL_CONTEXT);
      for (const event of loaded.events) {
        if (event.type === "call_admitted" && typeof event.data.privatePayloadRef === "string") keep.add(`${event.data.privatePayloadRef.slice("private:".length)}.json`);
        if (["delegation_reserved", "call_delegation_reference_added", "delegation_admitted"].includes(event.type) && event.delegationId) keep.add(`${event.delegationId}.json`);
        if (["delegation_bound", "config_revision_accepted"].includes(event.type) && event.delegationId) { keep.add(`binding-${event.delegationId}.json`); if (typeof event.data.auditRef === "string") keep.add(`${event.data.auditRef.slice("private:".length)}.json`); if (typeof event.data.revisionRef === "string") keep.add(`${event.data.revisionRef.slice("private:".length)}.json`); }
        if (event.type === "delegation_paused" && event.delegationId && typeof event.data.auditRef === "string") keep.add(`${event.data.auditRef.slice("private:".length)}.json`);
      }
    } catch { isolated.push(callId); return orphanFailure("orphan_wal_untrusted", isolated); }
  }
  let privateFiles: nodeFs.Dirent[];
  try { privateFiles = await fs.readdir(d.private, { withFileTypes: true }); } catch { return orphanFailure("orphan_private_untrusted"); }
  for (const entry of privateFiles) { const file = path.join(d.private, entry.name); if (!entry.isFile() || entry.isSymbolicLink() || !ownerFileSync(file)) return orphanFailure("orphan_private_untrusted"); }
  let deletedPayloads = 0;
  for (const entry of privateFiles) { const base = entry.name.endsWith(".pending") ? entry.name.slice(0, -".pending".length) : entry.name; if (!/^(call-[0-9a-f]{64}|[0-9a-f]{64}|binding-[0-9a-f]{64}|audit-[0-9a-f]{64}|revision-[0-9a-f]{64}-[0-9]+)\.json$/.test(base)) continue; if (!keep.has(base)) { await fs.unlink(path.join(d.private, entry.name)); deletedPayloads += 1; } }
  return { state: "clean", isolatedCallIds: [], deletedPayloads };
}
async function withOrphanCoordination<T>(rootDir: string, fn: () => Promise<T>): Promise<T | undefined> { const d = await ensureStore(rootDir); return withIdentityLock({ rootDir: d.root, key: "private-orphan-reconcile" }, fn); }
export async function reconcilePrivateOrphans(rootDir: string): Promise<OrphanReconciliationResult> { try { const result = await withOrphanCoordination(rootDir, async () => reconcilePrivateOrphansUnlocked(rootDir)); return result ?? { state: "busy", isolatedCallIds: [], deletedPayloads: 0 }; } catch { return orphanFailure("orphan_wal_untrusted"); } }
