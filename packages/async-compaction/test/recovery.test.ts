import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSessionRuntime, InteractiveMode, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { isolatedSettingsFile } from "./test-settings.ts";
import { readMachinePreference, writeMachinePreference } from "../src/machine-settings.ts";

const tick = () => new Promise(r => setTimeout(r, 10));
const usage = { input: 800, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 820, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
test("real JSONL reopen initializes InteractiveMode with committed context, no stale progress or new background work", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "async-compact-resume-")), agentDir = join(cwd, "agent"), dir = join(cwd, "sessions");
  mkdirSync(agentDir); mkdirSync(dir);
  const externalDir = join(cwd, "external-settings"); mkdirSync(externalDir);
  const externalSettings = join(externalDir, "settings.json"), fixtureSettings = isolatedSettingsFile(agentDir);
  const externalSentinel = Buffer.from('{"sentinel":"recovery-fixture-only","myPiExtensions":{"fast":true,"asyncCompaction":true}}\n');
  const parsedSentinel = JSON.parse(externalSentinel.toString("utf8"));
  assert.equal(parsedSentinel.myPiExtensions.asyncCompaction, true, "the original sentinel bytes are valid JSON with On enabled");
  writeFileSync(externalSettings, externalSentinel);
  const assertExternalUnchanged = () => assert.deepEqual(readFileSync(externalSettings), externalSentinel, "external sentinel bytes remain unchanged");
  await writeMachinePreference("asyncCompaction", false, externalSettings); // Negative control: only this synthetic temp file is deliberately changed.
  assert.deepEqual(await readMachinePreference("asyncCompaction", externalSettings), { value: false, valid: true });
  assert.throws(assertExternalUnchanged, (error: unknown) => (error as NodeJS.ErrnoException).code === "ERR_ASSERTION", "the sentinel regression assertion detects a valid external rewrite");
  writeFileSync(externalSettings, externalSentinel);
  assert.deepEqual(await readMachinePreference("asyncCompaction", externalSettings), { value: true, valid: true }, "the restored sentinel is accepted by the machine-settings reader");
  const argv = process.argv, previousAgentDir = process.env.PI_CODING_AGENT_DIR, previousSettingsOverride = process.env.PI_MY_EXTENSIONS_SETTINGS_FILE;
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = externalSettings;
  process.argv = ["node", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js"), "--no-extensions", "-e", resolve("packages/async-compaction/src/index.ts")];
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  let background = 0, foreground = 0;
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:1", api: "fake-api", apiKey: "test-only", streamSimple: (model, context, options) => {
    const summary = JSON.stringify(context.messages).includes("Summarize the following effective conversation");
    if (!summary) foreground++;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      if (summary && options?.signal) { background++; await gate; }
      const value = summary ? "late summary" : "answer ".repeat(40);
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: value }], api: model.api, provider: model.provider, model: model.id, usage: { ...usage, input: summary ? 25 : foreground === 1 ? 800 : 2800, totalTokens: summary ? 45 : foreground === 1 ? 820 : 2820 }, stopReason: "stop" as const, timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "text", contentIndex: 0, delta: value });
      stream.push({ type: "done", reason: "stop", message }); stream.end();
    })(); return stream;
  }, models: [{ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }] });
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [pi => extension(pi, { settingsFile: fixtureSettings })] }); await loader.reload();
  const options = { cwd, agentDir, model: runtime.getModel("fake", "m"), thinkingLevel: "off" as const, modelRuntime: runtime, resourceLoader: loader, settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }), noTools: true };
  const sm = SessionManager.create(cwd, dir);
  const { session: old } = await createAgentSession({ ...options, sessionManager: sm });
  await old.bindExtensions({ mode: "tui", uiContext: { notify() {}, onTerminalInput: () => () => {} } as never });
  let mode: InteractiveMode | undefined;
  try {
    await old.prompt("/async-compact on");
    assertExternalUnchanged();
    assert.equal((await readMachinePreference("asyncCompaction", fixtureSettings)).value, true, "On writes only the explicit fixture file");
    await old.prompt("/async-compact off");
    assertExternalUnchanged();
    assert.equal((await readMachinePreference("asyncCompaction", fixtureSettings)).value, false, "Off updates only the explicit fixture file");
    await old.prompt("/async-compact on");
    const user = (n: number) => `user-${n} ` + "word ".repeat(160);
    await old.prompt(user(1)); await old.prompt(user(2));
    assert.equal(background, 1, JSON.stringify({ foreground, usage: old.getContextUsage(), branch: sm.getBranch().map(e => e.type) }));
    const id = sm.getSessionId(), file = sm.getSessionFile()!;
    const tail = sm.getBranch().filter(e => e.type === "message" && e.message.role === "user").at(-1)!;
    sm.appendCompaction("committed summary", tail.id, 2900, { kind: "async-compact", version: 1, attemptId: "committed", readFiles: [], modifiedFiles: [] }, true, usage);
    sm.appendCustomEntry("async-compact-progress", { attemptId: "stale-progress" });
    await old.prompt("/async-compact off"); // invalidates the old candidate, still physically pending
    old.dispose();
    // Reopen the on-disk JSONL, not an in-memory clone or renderer-only fixture.
    const reopened = SessionManager.open(file, dir, cwd);
    assert.equal(reopened.getSessionId(), id);
    const { session: restored } = await createAgentSession({ ...options, sessionManager: reopened });
    const host = new AgentSessionRuntime(restored, { agentDir } as never, async () => { throw new Error("unexpected replacement"); });
    const tty = { start() {}, stop() {}, async drainInput() {}, write() {}, columns: 100, rows: 40, get kittyProtocolActive() { return false; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {} };
    mode = new InteractiveMode(host, { terminal: tty as never, verbose: false });
    await mode.init();
    const view = mode.chatContainer.render(100).join("\n").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    assert.match(view, /Compacted from 2,900 tokens/);
    assert.match(view, /user-2/);
    assert.doesNotMatch(view, /(?:^|\n)async-compact(?:\n|$)/);
    assert.equal(reopened.getSessionId(), id);
    const projection = reopened.buildSessionProjection().messages.map(m => JSON.stringify(m)).join("\n");
    assert.match(projection, /committed summary/); assert.match(projection, /user-2/); assert.match(projection, /answer/);
    release(); await tick(); await tick();
    assert.equal(background, 1, "restoring Off does not schedule another request");
    assert.equal(reopened.getBranch().filter(e => e.type === "compaction").length, 1);
    assert.equal(reopened.getBranch().filter(e => e.type === "custom" && e.customType === "async-compact-usage").length, 0, "old instance must not write into reopened session");
    assert.equal(SessionManager.open(file, dir, cwd).getBranch().filter(e => e.type === "custom" && e.customType === "async-compact-usage").length, 0, "old late response must not append to restored JSONL");
    restored.dispose();
  } finally { release(); old.dispose(); mode?.stop(); process.argv = argv; if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; if (previousSettingsOverride === undefined) delete process.env.PI_MY_EXTENSIONS_SETTINGS_FILE; else process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = previousSettingsOverride; rmSync(cwd, { recursive: true, force: true }); }
});
