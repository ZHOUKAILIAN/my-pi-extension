import test from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPiAttempt, validateSessionFile } from "../src/runner.ts";
import { dispatchAgent } from "../src/dispatcher.ts";
import { makeSessionIdentity } from "../src/session-identity.ts";
import type { AgentConfig } from "../src/agents.ts";

const agent: AgentConfig = { name: "investigator", description: "test", source: "user", filePath: "/unused.md", systemPrompt: "", model: "mock" };
const timestamp = "2026-01-01T00:00:00.000Z";
const header = (cwd: string, id = "child-1") => ({ type: "session", version: 3, id, cwd, timestamp });
const message = (stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text: "local result" }], api: "openai-completions", provider: "mock", model: "mock", stopReason, timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const tool = { type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "synthetic" }] }, isError: false };

async function fixture(t: any) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "subagent-cwd-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, "real"); const alias = path.join(root, "alias"); const other = path.join(root, "other");
  await fs.mkdir(real); await fs.mkdir(other); await fs.symlink(real, alias, "dir");
  return { root, real, alias, other };
}
function processFor(records: unknown[], code: number | null = 0, afterWrite?: () => Promise<void>): any {
  const proc = new EventEmitter() as any;
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.killed = false;
  proc.kill = () => { proc.killed = true; return true; };
  queueMicrotask(async () => {
    for (const record of records) proc.stdout.write(`${JSON.stringify(record)}\n`);
    await afterWrite?.();
    proc.stdout.end(); proc.stderr.end(); proc.emit("close", code);
  });
  return proc;
}
function run(root: string, cwd: string, records: unknown[], code: number | null = 0, afterWrite?: () => Promise<void>) {
  return runPiAttempt({ cwd, agent, task: "inspect", model: "mock", attempt: 1, source: "initial", sessionDir: root, childSessionId: "child-1", firstLogicalChildSpawn: true, parentFastRequested: false,
    spawn: () => processFor(records, code, afterWrite) });
}

test("cwd aliases retain complete streamed results in both directions", async (t) => {
  const { root, real, alias } = await fixture(t);
  for (const [requested, reported] of [[alias, real], [real, alias]]) {
    const result = await run(root, requested, [header(reported), tool, { type: "message_end", message: message() }]);
    assert.equal(result.failureKind, "success");
    assert.equal(result.actualModel, "mock");
    assert.equal(result.messages.length, 1);
    assert.equal(result.toolResults.length, 1);
    assert.deepEqual(result.diagnostics, { toolErrorCount: 0, providerErrorCount: 0 });
    assert.equal(JSON.stringify(result).includes(root), false, "cwd is not exposed");
  }
});

test("cwd alias acceptance does not mask invalid identity, protocol, terminal or exit status", async (t) => {
  const { root, real, alias, other } = await fixture(t);
  const missing = path.join(root, "missing");
  const dangling = path.join(root, "dangling"); await fs.symlink(missing, dangling, "dir");
  const scenarios: Array<{ name: string; cwd?: string; records: unknown[]; code?: number | null }> = [
    { name: "different directory", records: [header(other), { type: "message_end", message: message() }] },
    { name: "wrong session", records: [header(real, "wrong-child"), { type: "message_end", message: message() }] },
    { name: "relative cwd", records: [header("real"), { type: "message_end", message: message() }] },
    { name: "unknown header field", records: [{ ...header(real), unexpected: true }, { type: "message_end", message: message() }] },
    { name: "unknown event", records: [header(real), { type: "future_event" }, { type: "message_end", message: message() }] },
    { name: "missing terminal", records: [header(real), tool] },
    { name: "nonzero exit", records: [header(real), { type: "message_end", message: message() }], code: 1 },
    { name: "signal exit", records: [header(real), { type: "message_end", message: message() }], code: null },
    { name: "unresolvable alias", cwd: dangling, records: [header(missing), { type: "message_end", message: message() }] },
  ];
  for (const scenario of scenarios) {
    const result = await run(root, scenario.cwd ?? alias, scenario.records, scenario.code === undefined ? 0 : scenario.code);
    assert.equal(result.failureKind, "unknown_transport", scenario.name);
  }
  for (const [stopReason, kind] of [["length", "incomplete"], ["aborted", "cancelled"], ["error", "non_transient_provider"]]) {
    const result = await run(root, alias, [header(real), { type: "message_end", message: message(stopReason) }]);
    assert.equal(result.failureKind, kind, stopReason);
  }
  const settled = await run(root, alias, [header(real), { type: "message_end", message: message() }, { type: "agent_settled", aborted: true }]);
  assert.equal(settled.failureKind, "cancelled");
});

test("cwd alias is rechecked when the child exits", async (t) => {
  const { root, real, alias, other } = await fixture(t);
  const result = await run(root, alias, [header(real), { type: "message_end", message: message() }], 0, async () => {
    await fs.unlink(alias); await fs.symlink(other, alias, "dir");
  });
  assert.equal(result.failureKind, "unknown_transport");
});

test("persisted cwd aliases validate without relaxing file or session identity", async (t) => {
  const { root, real, alias, other } = await fixture(t);
  const file = path.join(root, "session.jsonl");
  for (const version of [1, 2, 3]) {
    await fs.writeFile(file, `${JSON.stringify({ ...header(real), version })}\n`, { mode: 0o600 });
    assert.equal(await validateSessionFile(file, "child-1", alias), true, `v${version} alias`);
    assert.equal(await validateSessionFile(file, "wrong-child", alias), false);
    assert.equal(await validateSessionFile(file, "child-1", other), false);
  }
  await fs.writeFile(file, `${JSON.stringify(header(alias))}\n`);
  assert.equal(await validateSessionFile(file, "child-1", real), true, "reverse alias");
  const link = path.join(root, "session-link.jsonl"); await fs.symlink(file, link);
  assert.equal(await validateSessionFile(link, "child-1", real), false, "session file symlink remains forbidden");
  await fs.appendFile(file, '{"type":');
  assert.equal(await validateSessionFile(file, "child-1", real), false, "truncated history remains forbidden");
});

test("dispatcher creates and resumes the same handle through a real Node child cwd alias", async (t) => {
  const { root, real, alias } = await fixture(t);
  const request = { parentSessionId: "parent", cwd: alias, task: "inspect", agent, session: "same-handle" };
  const seen: Array<{ childId: string; file?: string }> = [];
  let spawns = 0;
  const deps = {
    rootDir: path.join(root, "state"),
    runAttempt: async (options: Parameters<typeof runPiAttempt>[0]) => {
      seen.push({ childId: options.childSessionId, file: options.sessionFile });
      // Real OS cwd normalization, real pipes and close event; no Pi/model/network.
      const program = `const fs = require('node:fs');
        const h = ${JSON.stringify(header(real, options.childSessionId))}; h.cwd = process.cwd();
        fs.mkdirSync(${JSON.stringify(options.sessionDir)}, {recursive:true});
        const file = ${JSON.stringify(options.sessionFile ?? path.join(options.sessionDir, "session.jsonl"))};
        if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(h)+'\\n', {mode:0o600});
        const m = ${JSON.stringify(message())};
        fs.appendFileSync(file, JSON.stringify({type:'message', id:${JSON.stringify(`entry-${seen.length}`)}, parentId:null, timestamp:${JSON.stringify(timestamp)}, message:m})+'\\n');
        for (const record of [h, ${JSON.stringify(tool)}, {type:'message_end',message:m}]) process.stdout.write(JSON.stringify(record)+'\\n');`;
      return runPiAttempt({ ...options, spawn: (_command, _args, spawnOptions) => {
        spawns += 1;
        return nodeSpawn(process.execPath, ["-e", program], { cwd: spawnOptions.cwd, stdio: ["ignore", "pipe", "pipe"] }) as any;
      } });
    },
  };
  const first = await dispatchAgent(request, deps);
  assert.equal(first.status, "completed");
  assert.equal(first.attempt.actualModel, "mock");
  assert.equal(first.attempt.messages.length, 1);
  assert.equal(first.attempt.toolResults.length, 1);
  const resumed = await dispatchAgent({ ...request, task: "continue" }, deps);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.handle, first.handle);
  assert.equal(seen[0].file, undefined);
  assert.ok(seen[1].file, "resume uses validated disk session, not a new session");
  assert.equal(seen[0].childId, seen[1].childId);
  assert.equal(spawns, 2, "one spawn per explicit call; no automatic retry");
  const identity = makeSessionIdentity({ parentSessionId: request.parentSessionId, cwd: alias, agentName: agent.name, handle: request.session });
  const registry = JSON.parse(await fs.readFile(path.join(deps.rootDir, "registry", `${identity.key}.json`), "utf8"));
  assert.equal(registry.status, "settled");
  assert.equal(registry.childSessionId, seen[0].childId);
  assert.equal(identity.cwd, alias, "existing identity key semantics remain stable");
});
