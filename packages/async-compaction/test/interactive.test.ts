import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSessionRuntime, InteractiveMode, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";

const tick = () => new Promise(r => setTimeout(r, 10));
const usage = (n: number) => ({ input: n, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: n + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function terminal() {
  let onInput!: (data: string) => void;
  const writes: string[] = [];
  return {
    writes, input: (data: string) => onInput(data),
    start(cb: (data: string) => void) { onInput = cb; }, stop() {}, async drainInput() {},
    write(data: string) { writes.push(data); }, get columns() { return 100; }, get rows() { return 40; },
    get kittyProtocolActive() { return false; },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {},
    setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
}
const strip = (value: string) => value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
for (const action of ["complete", "cancel", "cancel-kitty", "cancel-csiu", "no-candidate", "preflight"] as const) test(`real InteractiveMode + Terminal redraws progress on ${action}`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "async-compact-ui-"));
  const agentDir = join(cwd, "agent"), dir = join(cwd, "sessions"); mkdirSync(agentDir); mkdirSync(dir);
  const argv = process.argv, previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  process.argv = ["node", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js"), "--no-extensions", "-e", resolve("packages/async-compaction/src/index.ts")];
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
  let release!: () => void;
  let gate = new Promise<void>(r => release = r);
  let releaseNative!: () => void;
  const nativeGate = new Promise<void>(r => releaseNative = r);
  let calls = 0, background = 0, backgroundSignal: AbortSignal | undefined;
  runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:1", api: "fake-api", apiKey: "test-only", streamSimple: (model, context, options) => {
    const backgroundRequest = context.messages.some(m => JSON.stringify(m.content).includes("Summarize the following effective conversation"));
    const summary = backgroundRequest || context.messages.some(m => JSON.stringify(m.content).includes("<conversation>"));
    const stream = createAssistantMessageEventStream();
    void (async () => {
      if (backgroundRequest) { background++; backgroundSignal = options?.signal; await gate; }
      if (summary && !backgroundRequest && !action.startsWith("cancel")) await nativeGate;
      const value = summary ? "cached summary" : `assistant-${++calls} ` + "answer ".repeat(40);
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: value }], api: model.api, provider: model.provider, model: model.id, usage: usage(summary ? 30 : [action === "preflight" ? 3000 : 800, 2800, 3800][calls - 1] ?? 30), stopReason: "stop" as const, timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } }); stream.push({ type: "text", contentIndex: 0, delta: value }); stream.push({ type: "done", reason: "stop", message }); stream.end();
    })(); return stream;
  }, models: [{ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }] });
  const sm = SessionManager.create(cwd, dir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [extension] }); await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, model: runtime.getModel("fake", "m"), thinkingLevel: "off", modelRuntime: runtime, resourceLoader: loader, sessionManager: sm, settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }), noTools: true });
  const host = new AgentSessionRuntime(session, { agentDir } as never, async () => { throw new Error("session replacement not expected"); });
  const tty = terminal(), mode = new InteractiveMode(host, { terminal: tty as never, verbose: false });
  const view = () => strip(mode.chatContainer.render(100).join("\n"));
  const phase = () => view().split("\n").map(line => line.trim()).find(line => /^async-compact (generating|waiting for background summary|native fallback)$/.test(line));
  const progress = () => !!phase();
  try {
    await mode.init();
    await session.prompt("/async-compact on");
    if (action === "preflight") sm.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: Date.now() });
    const user = (n: number) => `user-${n} ` + "words ".repeat(160);
    await session.prompt(user(1));
    if (action === "no-candidate") {
      const firstUser = sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!;
      sm.appendContextEdit(firstUser.id, { content: [{ type: "text", text: user(1) }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
    }
    if (action === "preflight") {
      await session.prompt(user(2));
      assert.equal(background, 0, "known non-text history cannot produce a candidate");
      const pending = session.prompt(user(3));
      for (let i = 0; i < 100 && phase() !== "async-compact native fallback"; i++) await tick();
      assert.equal(phase(), "async-compact native fallback", view());
      assert.equal(background, 0, "preflight must not send a background request");
      releaseNative(); await pending;
      for (let i = 0; i < 80 && progress(); i++) await tick();
      assert.equal(progress(), false, "preflight native terminal event clears phase");
      assert.ok(sm.getBranch().some(e => e.type === "compaction" && !e.fromHook));
      return;
    }
    await session.prompt(user(2));
    if (action === "no-candidate") {
      assert.equal(background, 0);
      const pending = session.prompt(user(3));
      for (let i = 0; i < 100 && phase() !== "async-compact native fallback"; i++) await tick();
      assert.equal(phase(), "async-compact native fallback", view());
      releaseNative(); await pending;
      for (let i = 0; i < 80 && progress(); i++) await tick();
      assert.equal(progress(), false, "native terminal event clears no-candidate phase");
      assert.equal(sm.getBranch().filter(e => e.type === "compaction").length, 1);
      return;
    }
    assert.equal(background, 1);
    mode.ui.renderNow(); assert.equal(phase(), "async-compact generating", view());
    const before = tty.writes.length;
    if (action === "complete") {
      const pending = session.prompt(user(3));
      for (let i = 0; i < 100 && phase() !== "async-compact waiting for background summary"; i++) await tick();
      assert.equal(phase(), "async-compact waiting for background summary", view());
      for (let i = 0; i < 300 && phase() !== "async-compact native fallback"; i++) await tick();
      assert.equal(phase(), "async-compact native fallback", view());
      release(); await tick(); await tick();
      assert.equal(phase(), "async-compact native fallback", "late background settlement cannot clear native phase");
      releaseNative(); await pending;
      for (let i = 0; i < 80 && progress(); i++) await tick();
      assert.equal(progress(), false, "native terminal event clears phase without user input");
    }
    if (action.startsWith("cancel")) {
      assert.equal(backgroundSignal?.aborted, false);
      tty.input("x"); tty.input("\u001b[200~paste\u001b[201~");
      assert.equal(backgroundSignal?.aborted, false, "ordinary input and paste do not cancel the background request");
      tty.input(action === "cancel" ? "\u001b" : action === "cancel-kitty" ? "\u001b[27u" : "\u001b[27;1u");
      assert.equal(backgroundSignal?.aborted, true, "the original SDK background signal is cancelled on Esc");
      mode.ui.renderNow(); assert.equal(progress(), false, view());
    }
    release(); for (let i = 0; i < 80 && (progress() || action.startsWith("cancel") && !sm.getBranch().some(e => e.type === "custom" && e.customType === "async-compact-usage")); i++) await tick();
    mode.ui.renderNow();
    assert.equal(progress(), false, view());
    assert.ok(tty.writes.length > before, "terminal redraws without another user event");
    await session.prompt("/async-compact off");
    assert.equal(sm.getBranch().filter(e => e.type === "compaction").length, action === "complete" ? 1 : 0);
    const records = sm.getBranch().filter(e => e.type === "custom" && e.customType === "async-compact-usage");
    assert.equal(records.at(-1)?.data.outcome, "cancelled");
    assert.equal(records.length, 1, "late provider usage is recorded once after stopping");
    assert.equal(sm.getBranch().filter(e => e.type === "compaction" && e.fromHook).length, 0, "stopped candidate is never adopted");
  } finally {
    release(); releaseNative(); session.dispose(); mode.ui.stop(); process.argv = argv; if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(cwd, { recursive: true, force: true });
  }
});
