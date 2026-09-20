import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicOwnerJsonSync, ownerDirectorySync, ownerFileSync, readOwnerJsonSync } from "./secure-fs.ts";

export interface SessionBranchEntry {
  id?: string;
  parentId?: string;
  type?: string;
}

export interface PiLineageSessionManager {
  getSessionId(): string;
  getSessionFile?: () => string | undefined;
  getLeafId?: () => string | null | undefined;
  getBranch?: (fromId?: string) => readonly unknown[];
  getEntries?: () => readonly unknown[];
}

export interface ActiveLineage {
  parentSessionId: string;
  parentSessionFile?: string;
  activeLineageId: string;
  activeBranchAnchor: string;
  currentLeafId: string;
  branchIds: string[];
  persistence: "restart-durable" | "in_process_only";
}

function entryId(entry: unknown): string | undefined {
  const id = (entry as SessionBranchEntry | undefined)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
function ids(branch: readonly unknown[]): string[] { return branch.map(entryId).filter((id): id is string => !!id); }
function stableHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function durableSessionFile(file: string): { realpath: string; identity: string } | undefined {
  try {
    const stat = ownerFileSync(file);
    if (!stat || (stat.mode & 0o077) !== 0) return undefined;
    const realpath = fs.realpathSync(file);
    if (!path.isAbsolute(realpath)) return undefined;
    return { realpath, identity: stableHash([realpath, stat.dev, stat.ino]) };
  } catch { return undefined; }
}

/**
 * Derives a restart-stable lineage from the durable parent session tree. The
 * anchor is the selected child at the latest tree fork; linear appends retain
 * it, while a sibling branch selects a different anchor. Without both the
 * complete entry tree and a trusted session file, persistence is downgraded.
 */
export class ActiveLineageTracker {
  capture(manager: PiLineageSessionManager): ActiveLineage {
    const parentSessionId = manager.getSessionId();
    const parentSessionFile = manager.getSessionFile?.();
    const currentLeafId = manager.getLeafId?.() ?? "root";
    let branch: readonly unknown[] = [];
    let entries: readonly unknown[] = [];
    try {
      if (typeof manager.getBranch !== "function" || typeof manager.getEntries !== "function") throw new Error("active branch API unavailable");
      branch = manager.getBranch(currentLeafId);
      entries = manager.getEntries();
    } catch {
      branch = [];
      entries = [];
    }
    const branchIds = ids(branch);
    const session = typeof parentSessionFile === "string" ? durableSessionFile(parentSessionFile) : undefined;
    const tree = new Map<string, SessionBranchEntry>(); let validTree = branch.length === branchIds.length && entries.length > 0;
    for (const raw of entries) { const id = entryId(raw); if (!id || tree.has(id)) validTree = false; else tree.set(id, raw as SessionBranchEntry); }
    if (branchIds.length === 0 || branchIds.at(-1) !== currentLeafId || new Set(branchIds).size !== branchIds.length) validTree = false;
    for (let index = 0; index < branch.length; index += 1) { const entry = branch[index] as SessionBranchEntry; if (!tree.has(branchIds[index]) || (index === 0 ? entry.parentId !== undefined : entry.parentId !== branchIds[index - 1])) validTree = false; }
    for (const entry of tree.values()) {
      if (entry.parentId && !tree.has(entry.parentId)) validTree = false;
      const seen = new Set<string>(); let cursor: string | undefined = entry.id;
      while (cursor) { if (seen.has(cursor)) { validTree = false; break; } seen.add(cursor); cursor = tree.get(cursor)?.parentId; }
    }
    const children = new Map<string, string[]>();
    if (validTree) for (const entry of tree.values()) if (entry.parentId) children.set(entry.parentId, [...(children.get(entry.parentId) ?? []), entry.id!]);
    let anchor = branchIds.at(-1) ?? currentLeafId;
    let durable = false;
    if (session && validTree && tree.has(anchor)) {
      const sidecar = `${session.realpath}.subagent-lineage.json`;
      const parentDir = ownerDirectorySync(path.dirname(session.realpath));
      type Persisted = { version: 1; sessionIdentity: string; records: Array<{ id: string; anchor: string; branchIds: string[] }> };
      const persisted = parentDir ? readOwnerJsonSync<Persisted>(sidecar) : undefined;
      const records = persisted?.version === 1 && persisted.sessionIdentity === session.identity && Array.isArray(persisted.records) ? persisted.records.filter((record) => typeof record.id === "string" && typeof record.anchor === "string" && Array.isArray(record.branchIds) && record.branchIds.length > 0) : [];
      const prefix = (short: string[], long: string[]) => short.every((id, index) => long[index] === id);
      const reusable = records.filter((record) => {
        if (!branchIds.includes(record.anchor)) return false;
        if (prefix(record.branchIds, branchIds)) {
          const boundary = record.branchIds.at(-1); const next = branchIds[record.branchIds.length];
          return next === undefined || (children.get(boundary!) ?? []).length <= 1;
        }
        return prefix(branchIds, record.branchIds);
      }).sort((a, b) => b.branchIds.length - a.branchIds.length)[0];
      if (reusable) anchor = reusable.anchor;
      const id = reusable?.id ?? stableHash(["subagent-lineage-v3", session.identity, anchor]);
      try {
        if (!reusable) records.push({ id, anchor, branchIds: [...branchIds] });
        else if (prefix(reusable.branchIds, branchIds)) reusable.branchIds = [...branchIds];
        if (!parentDir) throw new Error("lineage sidecar parent cannot be proven");
        atomicOwnerJsonSync(sidecar, { version: 1, sessionIdentity: session.identity, records }); durable = true;
      } catch { durable = false; }
      return { parentSessionId, parentSessionFile: session.realpath, activeLineageId: id, activeBranchAnchor: anchor, currentLeafId, branchIds, persistence: durable ? "restart-durable" : "in_process_only" };
    }
    const activeLineageId = stableHash(["subagent-lineage-v3", parentSessionId, session?.identity ?? "", validTree ? anchor : branchIds]);
    return { parentSessionId, ...(session ? { parentSessionFile: session.realpath } : {}), activeLineageId, activeBranchAnchor: anchor, currentLeafId, branchIds, persistence: "in_process_only" };
  }
}

export function lineageMatches(expected: Pick<ActiveLineage, "parentSessionId" | "activeLineageId" | "activeBranchAnchor">, current: ActiveLineage): boolean {
  return expected.parentSessionId === current.parentSessionId && expected.activeLineageId === current.activeLineageId && current.branchIds.includes(expected.activeBranchAnchor);
}

export function projectLineage(lineage: ActiveLineage): Record<string, unknown> {
  return { parentSessionId: lineage.parentSessionId, activeLineageId: lineage.activeLineageId, activeBranchAnchor: lineage.activeBranchAnchor, persistence: lineage.persistence };
}
