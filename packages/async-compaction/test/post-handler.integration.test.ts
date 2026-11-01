import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { isolatedSettingsFile } from "./test-settings.ts";
import { writeMachinePreference } from "../src/machine-settings.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const usage = (input: number) => ({ input, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: input + 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const text = (message: { content: unknown }) => Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("") : String(message.content);

test("SDK cancels native compaction when a later hook edits the prepared model projection", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "async-post-hook-projection-")), agentDir = join(cwd, "agent"), dir = join(cwd, "sessions");
  mkdirSync(agentDir); mkdirSync(dir);
  const previousArgv = process.argv, previousAgentDir = process.env.PI_CODING_AGENT_DIR, previousSettings = process.env.PI_MY_EXTENSIONS_SETTINGS_FILE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.argv = ["node", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js"), "--no-extensions", "-e", resolve("packages/async-compaction/src/index.ts")];
  const calls: { summary: boolean; content: string }[] = [];
  let injectEdit = false, editApplied = false;
  let hookProjectionAfter = "";
  const hookReasons: string[] = [];
  const errors: unknown[] = [];
  let releaseCandidate!: () => void;
  const candidateGate = new Promise<void>(resolve => releaseCandidate = resolve);
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:1", api: "fake-api", apiKey: "test-only", streamSimple: (model, context) => {
    const content = context.messages.map(text).join("\n");
    const summary = /Summarize the following effective conversation/.test(content);
    calls.push({ summary, content });
    const foregroundNumber = calls.filter(call => !call.summary).length;
    const input = summary ? 100 : foregroundNumber === 1 ? 800 : foregroundNumber === 2 ? 2800 : 3800;
    const value = summary ? "ASYNC CANDIDATE SUMMARY" : `foreground-${calls.filter(call => !call.summary).length} ` + "answer ".repeat(40);
    const message = { role: "assistant" as const, content: [{ type: "text" as const, text: value }], api: model.api, provider: model.provider, model: model.id, usage: usage(input), stopReason: "stop" as const, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    void (async () => {
      if (summary) await candidateGate;
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "text", contentIndex: 0, delta: value });
      stream.push({ type: "done", reason: "stop", message }); stream.end();
    })();
    return stream;
  }, models: [{ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }] });
  const sm = SessionManager.create(cwd, dir);
  const settingsFile = isolatedSettingsFile(agentDir);
  await writeMachinePreference("asyncCompaction", true, settingsFile);
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [pi => {
    extension(pi, { settingsFile, agentType: "main" });
    pi.on("session_before_compact", (event, ctx) => {
      hookReasons.push(event.reason);
      if (!injectEdit || event.reason !== "threshold") return;
      injectEdit = false;
      const target = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("KEEP_ORIGINAL_CONTEXT_CONSTRAINT"));
      assert.ok(target, "the prepared history contains the original constrained user turn");
      ctx.sessionManager.appendContextEdit(target.id, { content: [{ type: "text", text: "UPDATED_POST_HANDLER_CONSTRAINT " + "preserve-new-context ".repeat(160) }] });
      hookProjectionAfter = JSON.stringify(ctx.sessionManager.buildSessionProjection().messages);
      editApplied = true;
    });
  }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, model: runtime.getModel("fake", "m"), thinkingLevel: "off", modelRuntime: runtime, resourceLoader: loader, sessionManager: sm,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }), noTools: true });
  await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, onTerminalInput: () => () => {} } as never, onError: error => errors.push(error) });
  try {
    await session.prompt("/async-compact on");
    await session.prompt("KEEP_ORIGINAL_CONTEXT_CONSTRAINT " + "words ".repeat(160));
    const toolCall = { type: "toolCall" as const, id: "fixture-call", name: "fixture_read", arguments: { path: "history.ts" } };
    const secondCall = { ...toolCall, id: "fixture-call-2", name: "fixture_edit", arguments: { path: "changed.ts" } };
    const assistant = { role: "assistant" as const, content: [toolCall, secondCall], api: "fake-api", provider: "fake", model: "m", usage: usage(10), stopReason: "toolUse" as const, timestamp: Date.now() };
    const assistantId = sm.appendMessage(assistant);
    const result = { role: "toolResult" as const, toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text" as const, text: "read" }], isError: false, timestamp: Date.now() };
    const resultId = sm.appendMessage(result);
    sm.appendMessage({ ...result, toolCallId: secondCall.id, toolName: secondCall.name, content: [{ type: "text" as const, text: "edited" }] });
    await session.prompt("user-2 " + "words ".repeat(160));
    for (let i = 0; i < 100 && calls.filter(call => call.summary).length < 1; i++) await tick();
    assert.equal(calls.filter(call => call.summary).length, 1, "exactly one background candidate request was generated before threshold compaction");
    assert.ok(sm.getBranch().some(entry => entry.type === "message" && entry.id === assistantId));
    assert.ok(sm.getBranch().some(entry => entry.type === "message" && entry.id === resultId));

    injectEdit = true;
    const pending = session.prompt("user-3 " + "words ".repeat(160));
    for (let i = 0; i < 100 && !sm.getBranch().some(entry => entry.type === "custom" && entry.customType === "async-compact-progress" && entry.data?.phase === "waiting"); i++) await tick();
    assert.ok(sm.getBranch().some(entry => entry.type === "custom" && entry.customType === "async-compact-progress" && entry.data?.phase === "waiting"), `the SDK entered the same-candidate wait; usage=${JSON.stringify(session.getContextUsage())} calls=${calls.length} hooks=${JSON.stringify(hookReasons)} branch=${JSON.stringify(sm.getBranch().map(entry => entry.type === "message" ? [entry.message.role, entry.message.stopReason] : entry.type))}`);
    releaseCandidate(); await pending;
    assert.equal(editApplied, true, `a later SDK hook edited model-visible context after the Async handler returned; hookReasons=${JSON.stringify(hookReasons)} usage=${JSON.stringify(session.getContextUsage())}; calls=${JSON.stringify(calls.map(call => ({ summary: call.summary, content: call.content.slice(0, 120) })))}; branch=${JSON.stringify(sm.getBranch().map(entry => entry.type === "message" ? [entry.type, entry.message.role, entry.message.stopReason] : entry.type))}`);
    const projection = sm.buildSessionProjection().messages.map(text).join("\n");
    assert.match(hookProjectionAfter, /UPDATED_POST_HANDLER_CONSTRAINT/, "the later SDK hook's edit is model-visible immediately");
    assert.match(projection, /UPDATED_POST_HANDLER_CONSTRAINT/, "the active projection retains the later valid constraint");
    assert.doesNotMatch(projection, /KEEP_ORIGINAL_CONTEXT_CONSTRAINT/, "the edited-away content was not reinstated from stale preparation");
    assert.equal(sm.getBranch().some(entry => entry.type === "compaction"), false, "stale preparation is cancelled rather than submitted natively");
    assert.equal(calls.length, 4, `no native compaction provider call was made; expected three foreground requests and one candidate; calls: ${JSON.stringify(calls.map(call => ({ summary: call.summary, length: call.content.length })))}`);
    assert.deepEqual(calls.map(call => call.summary), [false, false, true, false], "the only non-foreground call is the one background candidate; no native summarization request follows the edit");
    assert.equal(errors.length, 0, JSON.stringify(errors));
  } finally {
    releaseCandidate(); session.dispose(); process.argv = previousArgv;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSettings === undefined) delete process.env.PI_MY_EXTENSIONS_SETTINGS_FILE; else process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = previousSettings;
    rmSync(cwd, { recursive: true, force: true });
  }
});
