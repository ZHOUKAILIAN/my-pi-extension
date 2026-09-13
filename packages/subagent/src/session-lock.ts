import { execFile as nodeExecFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

export interface LockHandle {
  readonly path: string;
  readonly token: string;
  markChildStarting(identity?: string, sessionPath?: string): Promise<void>;
  setChildProcess(child: { pid: number; identity: string; sessionPath?: string }): Promise<void>;
  release(): Promise<void>;
}

export interface ProcessInfo {
  pid: number;
  command: string;
}

interface ChildLockState {
  state: "idle" | "starting" | "running";
  pid?: number;
  identity?: string;
  sessionPath?: string;
  startedAt?: string;
}

interface LockRecord {
  host: string;
  pid: number;
  token: string;
  createdAt: string;
  child: ChildLockState;
}

export interface LockOptions {
  rootDir: string;
  key: string;
  pid?: number;
  /** Test seam; errors are treated as an unknown live owner. */
  processExists?: (pid: number) => Promise<boolean>;
  /** Test seam; undefined means process inspection was not conclusive. */
  listProcesses?: () => Promise<readonly ProcessInfo[] | undefined>;
  now?: () => Date;
  startingGraceMs?: number;
}

const DEFAULT_STARTING_GRACE_MS = 5_000;

async function processExists(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function listProcesses(): Promise<readonly ProcessInfo[] | undefined> {
  if (process.platform === "linux") {
    try {
      const entries = await fs.promises.readdir("/proc", { withFileTypes: true });
      const processes: ProcessInfo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        try {
          const command = (await fs.promises.readFile(path.join("/proc", entry.name, "cmdline"), "utf8")).replaceAll("\0", " ").trim();
          if (command) processes.push({ pid: Number(entry.name), command });
        } catch (error) {
          // A process exiting during the scan is harmless; any other unreadable
          // entry means the scan cannot prove that no matching child exists.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
        }
      }
      return processes;
    } catch {
      // Fall through to ps on systems exposing no readable /proc.
    }
  }
  return new Promise<readonly ProcessInfo[] | undefined>((resolve) => {
    nodeExecFile("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== "string") { resolve(undefined); return; }
      const processes: ProcessInfo[] = [];
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (match && match[2]) processes.push({ pid: Number(match[1]), command: match[2] });
      }
      resolve(processes);
    });
  });
}

function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function hasArgument(command: string, name: string, value: string): boolean {
  return new RegExp(`(?:^|\\s)${escaped(name)}(?:=|\\s+)${escaped(value)}(?=\\s|$)`).test(command);
}

function matchesChildProcess(processInfo: ProcessInfo, child: ChildLockState): boolean {
  if (!Number.isInteger(processInfo.pid) || processInfo.pid <= 0 || !/(?:^|\s)--mode(?:=|\s+)json(?:\s|$)/.test(processInfo.command)) return false;
  return (child.identity !== undefined && hasArgument(processInfo.command, "--session-id", child.identity)) ||
    (child.sessionPath !== undefined && hasArgument(processInfo.command, "--session", child.sessionPath));
}

function childState(value: unknown): ChildLockState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const child = value as Record<string, unknown>;
  if (child.state !== "idle" && child.state !== "starting" && child.state !== "running") return undefined;
  if (child.pid !== undefined && (!Number.isInteger(child.pid) || (child.pid as number) <= 0)) return undefined;
  if (child.identity !== undefined && (typeof child.identity !== "string" || child.identity.length === 0)) return undefined;
  if (child.sessionPath !== undefined && (typeof child.sessionPath !== "string" || !path.isAbsolute(child.sessionPath))) return undefined;
  if (child.startedAt !== undefined && (typeof child.startedAt !== "string" || !Number.isFinite(Date.parse(child.startedAt)))) return undefined;
  if (child.state === "running" && (typeof child.pid !== "number" || typeof child.identity !== "string")) return undefined;
  if (child.state !== "running" && child.pid !== undefined && child.identity === undefined) return undefined;
  return {
    state: child.state,
    ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
    ...(typeof child.identity === "string" ? { identity: child.identity } : {}),
    ...(typeof child.sessionPath === "string" ? { sessionPath: child.sessionPath } : {}),
    ...(typeof child.startedAt === "string" ? { startedAt: child.startedAt } : {}),
  };
}

async function readLock(file: string): Promise<LockRecord | undefined> {
  try {
    const value = JSON.parse(await fs.promises.readFile(file, "utf8")) as Record<string, unknown>;
    if (typeof value.host !== "string" || typeof value.pid !== "number" || typeof value.token !== "string" || typeof value.createdAt !== "string") return undefined;
    const child = childState(value.child);
    if (!child) return undefined;
    return { host: value.host, pid: value.pid, token: value.token, createdAt: value.createdAt, child };
  } catch {
    return undefined;
  }
}

async function updateLock(file: string, token: string, update: (record: LockRecord) => LockRecord): Promise<void> {
  const current = await readLock(file);
  if (!current || current.token !== token) return;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(update(current)), { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporary, file);
}

async function childMayExist(child: ChildLockState, options: LockOptions): Promise<boolean> {
  if (child.state === "idle") return false;
  // A starting child has a deliberate window in which spawn and PID/path
  // registration can be reordered. Never reclaim during that window.
  const startedAt = child.startedAt ? Date.parse(child.startedAt) : Number.NaN;
  const currentTime = (options.now ?? (() => new Date()))().getTime();
  if (child.state === "starting" && (!Number.isFinite(startedAt) || currentTime - startedAt < (options.startingGraceMs ?? DEFAULT_STARTING_GRACE_MS))) return true;

  const exists = options.processExists ?? processExists;
  if (child.pid !== undefined && await exists(child.pid)) return true;
  if (!child.identity && !child.sessionPath) return true;
  const processes = await (options.listProcesses ?? listProcesses)();
  // No process table is proof of nothing. Fail closed when inspection is
  // unavailable or incomplete.
  if (!processes) return true;
  return processes.some((processInfo) => matchesChildProcess(processInfo, child));
}

/** A lock is never removed merely because it is old. Its owner must be gone. */
export async function acquireIdentityLock(options: LockOptions): Promise<LockHandle | undefined> {
  const locksDir = path.join(options.rootDir, "locks");
  await fs.promises.mkdir(locksDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(locksDir, `${options.key}.lock`);
  const token = randomUUID();
  const now = options.now ?? (() => new Date());
  const payload = JSON.stringify({ host: os.hostname(), pid: options.pid ?? process.pid, token, createdAt: now().toISOString(), child: { state: "idle" } satisfies ChildLockState });
  try {
    const handle = await fs.promises.open(lockPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readLock(lockPath);
    // An unreadable/legacy lock is an unknown owner and therefore fail closed.
    const exists = options.processExists ?? processExists;
    if (!existing || existing.host !== os.hostname() || await exists(existing.pid)) return undefined;
    // Reclaim only after the owner is gone and child inspection proves there
    // is no matching Pi process. Unknown/legacy starting state stays busy.
    if (await childMayExist(existing.child, options)) return undefined;
    try {
      await fs.promises.unlink(lockPath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    try {
      const handle = await fs.promises.open(lockPath, "wx", 0o600);
      try { await handle.writeFile(payload, "utf8"); } finally { await handle.close(); }
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw retryError;
    }
  }

  return {
    path: lockPath,
    token,
    async markChildStarting(identity, sessionPath) {
      await updateLock(lockPath, token, (record) => ({
        ...record,
        child: {
          state: "starting",
          ...(identity ? { identity } : {}),
          ...(sessionPath ? { sessionPath: path.resolve(sessionPath) } : {}),
          startedAt: now().toISOString(),
        },
      }));
    },
    async setChildProcess(child) {
      if (!Number.isInteger(child.pid) || child.pid <= 0 || !child.identity) return;
      await updateLock(lockPath, token, (record) => ({
        ...record,
        child: {
          state: "running",
          pid: child.pid,
          identity: child.identity,
          ...(child.sessionPath ? { sessionPath: path.resolve(child.sessionPath) } : record.child.sessionPath ? { sessionPath: record.child.sessionPath } : {}),
          ...(record.child.startedAt ? { startedAt: record.child.startedAt } : { startedAt: now().toISOString() }),
        },
      }));
    },
    async release() {
      try {
        const current = await readLock(lockPath);
        if (current?.token !== token) return;
        await fs.promises.unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

export async function withIdentityLock<T>(options: LockOptions, fn: (lock: LockHandle) => Promise<T>): Promise<T | undefined> {
  const lock = await acquireIdentityLock(options);
  if (!lock) return undefined;
  try { return await fn(lock); } finally { await lock.release(); }
}
