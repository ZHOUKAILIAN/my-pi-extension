import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentConfig } from "./agents.ts";
import { FastInheritanceConsumer } from "./fast-inheritance.ts";
import { DEFAULT_RETRY_DELAY_MS, findSessionFile, MAX_RETRIES_PER_MODEL, runPiAttempt, sanitizeAttemptResult, validateSessionFile, type AttemptResult, type AttemptSource, type FailureKind } from "./runner.ts";
import { isMatchingRegistry, isValidSessionRegistry, makeSessionIdentity, newLogicalHandle, type SessionIdentity, type SessionRegistry } from "./session-identity.ts";
import { withIdentityLock, type LockHandle } from "./session-lock.ts";

export interface DispatchRequest {
  parentSessionId: string;
  parentModel?: string;
  agent: AgentConfig;
  task: string;
  cwd: string;
  model?: string;
  session?: string;
  persistent?: boolean;
  defaultPersistent?: boolean;
  signal?: AbortSignal;
  onUpdate?: (attempt: AttemptResult) => void;
  fast?: FastInheritanceConsumer;
}

export interface DispatchResult {
  attempt: AttemptResult;
  attempts: AttemptResult[];
  persistent: boolean;
  handle?: string;
  status: "completed" | "recoverable_failed" | "failed" | "cancelled" | "session-busy" | "cleanup-pending" | "invalid";
  failureKind: FailureKind;
  error?: string;
}

export interface DispatchDependencies {
  rootDir: string;
  runAttempt?: (options: Parameters<typeof runPiAttempt>[0]) => Promise<AttemptResult>;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function safeReason(attempt: AttemptResult): string | undefined {
  return attempt.errorMessage;
}

function now(deps: DispatchDependencies): Date { return deps.now?.() ?? new Date(); }

function isWithinDirectory(file: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(temporary, file);
}

async function readRegistry(file: string): Promise<{ exists: boolean; registry?: SessionRegistry }> {
  try {
    const value: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"));
    return isValidSessionRegistry(value) ? { exists: true, registry: value } : { exists: true };
  } catch (error) {
    // Missing is the only state that permits first creation. Parse, permission,
    // and I/O failures are an existing-but-untrusted registry and fail closed.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    return { exists: true };
  }
}

const TOMBSTONE_PATTERN = /^([a-f0-9]{64})\.json\.tombstone-[A-Za-z0-9-]+$/;

async function tombstoneState(rootDir: string, key: string): Promise<"absent" | "present" | "unknown"> {
  try {
    const entries = await fs.promises.readdir(path.join(rootDir, "registry"), { withFileTypes: true });
    return entries.some((entry) => TOMBSTONE_PATTERN.test(entry.name) && entry.name.startsWith(`${key}.json.`)) ? "present" : "absent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return "unknown";
  }
}

async function quarantineRegistry(registryFile: string, registry: SessionRegistry, deps: DispatchDependencies): Promise<void> {
  registry.status = "quarantined";
  registry.lastActivityAt = now(deps).toISOString();
  try { await atomicWrite(registryFile, registry); } catch {
    // The original registry remains fail-closed even if the quarantine marker
    // cannot be persisted; the caller still must not spawn or resume it.
  }
}

function newRegistry(identity: SessionIdentity, childSessionId: string, date: Date): SessionRegistry {
  const timestamp = date.toISOString();
  return {
    version: 1,
    key: identity.key,
    parentSessionId: identity.parentSessionId,
    agentName: identity.agentName,
    handle: identity.handle,
    childSessionId,
    status: "creating",
    createdAt: timestamp,
    lastActivityAt: timestamp,
    attempts: [],
  };
}

function modelCandidates(request: DispatchRequest): Array<{ model?: string; source: AttemptSource }> {
  const raw: Array<{ model?: string; source: AttemptSource }> = [];
  if (request.model) raw.push({ model: request.model, source: "user_override" });
  else raw.push({ model: request.agent.model ?? request.parentModel, source: "initial" });
  for (const model of request.agent.fallbackModels ?? []) raw.push({ model, source: "fallback" });
  const seen = new Set<string>();
  return raw.filter((item) => {
    const key = item.model ?? "<default>";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function invalidResult(request: DispatchRequest, persistent: boolean, error: string, status: DispatchResult["status"] = "invalid"): DispatchResult {
  const attempt: AttemptResult = {
    agent: request.agent.name,
    agentSource: request.agent.source,
    exitCode: null,
    messages: [],
    toolResults: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    requestedModel: "unknown",
    actualModel: "unknown",
    source: "initial",
    attempt: 0,
    failureKind: "unknown_transport",
    errorMessage: error,
    cwdScope: "cwd:unknown",
  };
  const safeAttempt = sanitizeAttemptResult(attempt);
  return { attempt: safeAttempt, attempts: [safeAttempt], persistent, status, failureKind: "unknown_transport", error: safeAttempt.errorMessage };
}

export async function dispatchAgent(request: DispatchRequest, deps: DispatchDependencies): Promise<DispatchResult> {
  const persistent = request.persistent ?? request.agent.persistent ?? request.defaultPersistent ?? true;
  if (!persistent && request.session) return invalidResult(request, false, "persistent:false cannot be combined with session");

  const handle = request.session ?? (persistent ? newLogicalHandle() : undefined);
  const identity = persistent ? makeSessionIdentity({ parentSessionId: request.parentSessionId, cwd: request.cwd, agentName: request.agent.name, handle: handle! }) : undefined;
  await fs.promises.mkdir(deps.rootDir, { recursive: true, mode: 0o700 });
  const temporaryRoot = persistent ? undefined : await fs.promises.mkdtemp(path.join(deps.rootDir, "ephemeral-"));
  const actualIdentity = identity ?? makeSessionIdentity({ parentSessionId: request.parentSessionId, cwd: request.cwd, agentName: request.agent.name, handle: `ephemeral-${randomUUID()}` });
  const sessionDir = persistent ? path.join(deps.rootDir, "sessions", actualIdentity.key) : path.join(temporaryRoot!, "sessions");
  const registryFile = persistent ? path.join(deps.rootDir, "registry", `${actualIdentity.key}.json`) : undefined;
  const run = deps.runAttempt ?? runPiAttempt;
  const attempts: AttemptResult[] = [];

  const execute = async (lock?: LockHandle): Promise<DispatchResult> => {
    if (registryFile) {
      const tombstone = await tombstoneState(deps.rootDir, actualIdentity.key);
      if (tombstone !== "absent") {
        return invalidResult(request, persistent, tombstone === "present" ? "session cleanup pending" : "session cleanup state cannot be verified", "cleanup-pending");
      }
    }
    const registryState = registryFile ? await readRegistry(registryFile) : { exists: false };
    let registry = registryState.registry;
    if (registryState.exists && !registry) return invalidResult(request, persistent, "session registry is invalid");
    let childSessionId: string;
    let sessionFile: string | undefined;
    let firstLogicalChildSpawn = false;
    let sessionIntegrityFailed = false;

    if (registry) {
      if (!isMatchingRegistry(registry, actualIdentity)) {
        return invalidResult(request, persistent, "session registry is invalid");
      }
      // A partial/invalid initial JSONL is retained as a durable quarantine
      // marker. It is enumerable by GC, but never eligible for resume or a
      // fresh --session-id creation that would silently lose history.
      if (registry.status === "quarantined") {
        return invalidResult(request, persistent, "session is quarantined");
      }
      childSessionId = registry.childSessionId;
      sessionFile = await findSessionFile(sessionDir, childSessionId);
      if (!sessionFile || !isWithinDirectory(sessionFile, sessionDir)) {
        await quarantineRegistry(registryFile!, registry, deps);
        return invalidResult(request, persistent, "session file is missing");
      }
      const valid = await validateSessionFile(sessionFile, childSessionId, actualIdentity.cwd);
      if (!valid) {
        await quarantineRegistry(registryFile!, registry, deps);
        return invalidResult(request, persistent, "session JSONL is invalid");
      }
      registry.status = "running";
      registry.lastActivityAt = now(deps).toISOString();
      await atomicWrite(registryFile!, registry);
    } else {
      childSessionId = randomUUID();
      firstLogicalChildSpawn = true;
      if (registryFile) {
        registry = newRegistry(actualIdentity, childSessionId, now(deps));
        await atomicWrite(registryFile, registry);
      }
    }

    const candidates = modelCandidates(request);
    let attemptNumber = 0;
    let last: AttemptResult | undefined;
    try {
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const candidate = candidates[candidateIndex];
        for (let retry = 0; retry <= MAX_RETRIES_PER_MODEL; retry += 1) {
          if (request.signal?.aborted) {
            const cancelled = last ?? invalidResult(request, persistent, "cancelled").attempt;
            if (registry && registryFile) {
              registry.status = "cancelled";
              registry.lastActivityAt = now(deps).toISOString();
              await atomicWrite(registryFile, registry);
            }
            return { attempt: cancelled, attempts, persistent, handle, status: "cancelled", failureKind: "cancelled" };
          }
          const source: AttemptSource = retry > 0 ? "retry" : candidate.source;
          const firstAttempt = attemptNumber === 0;
          const task = retry === 0 && firstAttempt ? request.task : `Continue the same task. Preserve the existing work and respond to this instruction:\n${request.task}`;
          const env = request.fast?.environment(request.agent, firstLogicalChildSpawn && firstAttempt);
          await lock?.markChildStarting(childSessionId, sessionFile);
          const rawAttempt = await run({
            cwd: actualIdentity.cwd,
            agent: request.agent,
            task,
            model: candidate.model,
            attempt: ++attemptNumber,
            source,
            sessionDir,
            childSessionId,
            sessionFile,
            signal: request.signal,
            env,
            firstLogicalChildSpawn: firstLogicalChildSpawn && attemptNumber === 1,
            parentFastRequested: request.fast?.requestedFast ?? false,
            onChildProcess: (child) => lock?.setChildProcess(child),
            // Mocks and alternate runners are untrusted too; do not let their
            // progress callback bypass the same projection as the final result.
            onUpdate: (progress) => request.onUpdate?.(sanitizeAttemptResult(progress, candidate.model, [request.task, request.agent.systemPrompt])),
          });
          const attempt = sanitizeAttemptResult(rawAttempt, candidate.model, [request.task, request.agent.systemPrompt]);
          attempts.push(attempt);
          last = attempt;
          request.onUpdate?.(attempt);

          const discovered = await findSessionFile(sessionDir, childSessionId);
          if (discovered && await validateSessionFile(discovered, childSessionId, actualIdentity.cwd)) sessionFile = discovered;
          else if (!sessionFile || !(await validateSessionFile(sessionFile, childSessionId, actualIdentity.cwd))) sessionFile = undefined;
          if (!sessionFile) {
            // A transient marker from an injected/raw runner is not enough to
            // retry: without a validated child JSONL, retry would create or use
            // an empty session and lose session integrity. Quarantine an
            // existing registry immediately as well as on initial creation.
            attempt.failureKind = "unknown_transport";
            attempt.errorMessage = "session file is missing";
            sessionIntegrityFailed = true;
            if (registry && registryFile) await quarantineRegistry(registryFile, registry, deps);
          }
          if (registry && sessionFile) {
            registry.status = attempt.failureKind === "success" ? "settled" : "running";
            registry.lastActivityAt = now(deps).toISOString();
            registry.attempts.push({
              requestedModel: attempt.requestedModel,
              actualModel: attempt.actualModel,
              attempt: attempt.attempt,
              source,
              kind: attempt.failureKind,
              reason: safeReason(attempt),
              ...(attempt.diagnostics ? { diagnostics: attempt.diagnostics } : {}),
            });
            await atomicWrite(registryFile!, registry);
          }

          if (attempt.failureKind === "success") {
            return { attempt, attempts, persistent, handle, status: "completed", failureKind: "success" };
          }
          if (attempt.failureKind !== "transient_provider") {
            const status = attempt.failureKind === "cancelled" ? "cancelled" : persistent ? "recoverable_failed" : "failed";
            if (registry && !sessionIntegrityFailed) {
              registry.status = attempt.failureKind === "cancelled" ? "cancelled" : "failed";
              registry.lastActivityAt = now(deps).toISOString();
              await atomicWrite(registryFile!, registry);
            }
            return { attempt, attempts, persistent, handle, status, failureKind: attempt.failureKind };
          }
          if (retry < MAX_RETRIES_PER_MODEL) {
            try { await (deps.sleep ?? sleep)(DEFAULT_RETRY_DELAY_MS, request.signal); } catch {
              const cancelled = attempts.at(-1)!;
              if (registry && registryFile) {
                registry.status = "cancelled";
                registry.lastActivityAt = now(deps).toISOString();
                await atomicWrite(registryFile, registry);
              }
              return { attempt: cancelled, attempts, persistent, handle, status: "cancelled", failureKind: "cancelled" };
            }
        }
        }
        // The next candidate is a fallback, and gets its own initial+2 budget.
      }
      const exhausted = last ?? invalidResult(request, persistent, "no model candidate").attempt;
      if (registry) {
        registry.status = "recoverable_failed";
        registry.lastActivityAt = now(deps).toISOString();
        await atomicWrite(registryFile!, registry);
      }
      return { attempt: exhausted, attempts, persistent, handle, status: persistent ? "recoverable_failed" : "failed", failureKind: exhausted.failureKind };
    } finally {
      if (!persistent && temporaryRoot) await fs.promises.rm(temporaryRoot, { recursive: true, force: true });
      if (persistent && registryFile && registry && !sessionFile && firstLogicalChildSpawn && !sessionIntegrityFailed) {
        // Keep a valid, GC-discoverable record for a child directory that may
        // contain a partial JSONL. The marker is fail-closed for dispatch and
        // is deleted with the session directory after the normal retention.
        registry.status = "quarantined";
        registry.lastActivityAt = now(deps).toISOString();
        await atomicWrite(registryFile, registry);
      }
    }
  };

  if (!persistent) {
    const result = await execute();
    return {
      ...result,
      handle: undefined,
      attempt: { ...result.attempt, sessionId: undefined },
      attempts: result.attempts.map((attempt) => ({ ...attempt, sessionId: undefined })),
    };
  }
  const locked = await withIdentityLock({ rootDir: deps.rootDir, key: identity!.key }, async (lock) => execute(lock));
  if (locked) return locked;
  return invalidResult(request, true, "session-busy", "session-busy");
}
