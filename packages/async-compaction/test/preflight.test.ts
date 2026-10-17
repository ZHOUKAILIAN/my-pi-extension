import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";

const tick = () => new Promise(r => setTimeout(r, 10));
test("SDK threshold fallback commits natively while physical background slot is pending; late usage is accounted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "async-compact-preflight-")), agentDir = join(cwd, "agent"), dir = join(cwd, "sessions");
  mkdirSync(agentDir); mkdirSync(dir);
  const argv = process.argv;
  process.argv = ["node", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js"), "--no-extensions", "-e", resolve("packages/async-compaction/src/index.ts")];
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  let background = 0, foreground = 0;
  const errors: unknown[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:1", api: "fake-api", apiKey: "test-only", streamSimple: (model, context, options) => {
    const summary = JSON.stringify(context.messages).includes("Summarize the following effective conversation");
    if (summary && options?.signal) background++;
    if (!summary) foreground++;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      if (summary && options?.signal) await gate;
      const value = summary ? options?.signal ? "late cached" : "native without paths" : "answer ".repeat(40);
      const input = summary ? options?.signal ? 67 : 55 : [800, 2800, 3800][foreground - 1] ?? 30;
      const usage = { input, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: input + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const message = { role: "assistant" as const, content: [{ type: "text" as const, text: value }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop" as const, timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "text", contentIndex: 0, delta: value });
      stream.push({ type: "done", reason: "stop", message }); stream.end();
    })(); return stream;
  }, models: [{ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }] });
  const sm = SessionManager.create(cwd, dir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [extension] }); await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, model: runtime.getModel("fake", "m"), thinkingLevel: "off", modelRuntime: runtime, resourceLoader: loader, sessionManager: sm, settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }), noTools: true });
  await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, onTerminalInput: () => () => {} } as never, onError: e => errors.push(e) });
  try {
    await session.prompt("/async-compact on");
    const user = (n: number) => `user-${n} ` + "word ".repeat(160);
    await session.prompt(user(1)); await session.prompt(user(2));
    assert.equal(background, 1, JSON.stringify(errors));
    await session.prompt(user(3)); // bounded wait expires while the background request is still pending
    assert.ok(sm.getBranch().some(e => e.type === "compaction" && !e.fromHook), JSON.stringify(errors));
    assert.equal(background, 1);
    assert.equal(sm.getBranch().filter(e => e.type === "custom" && e.customType === "async-compact-usage").length, 0);
    await session.prompt(user(4));
    assert.equal(background, 1, "native commit did not release the physical background slot");
    release();
    for (let i = 0; i < 100 && !sm.getBranch().some(e => e.type === "custom" && e.customType === "async-compact-usage"); i++) await tick();
    const records = sm.getBranch().filter(e => e.type === "custom" && e.customType === "async-compact-usage");
    assert.equal(records.length, 1, JSON.stringify(errors));
    assert.equal(records[0].data.usage.input, 67);
    assert.equal(records[0].data.model, "m"); assert.equal(records[0].data.provider, "fake");
    assert.equal(records[0].data.includedInNativeTotals, false);
    assert.equal(background, 1);
    assert.deepEqual(errors, []);
  } finally { release(); session.dispose(); process.argv = argv; rmSync(cwd, { recursive: true, force: true }); }
});
