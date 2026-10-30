import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { writeMachinePreference } from "../src/machine-settings.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
const text = (m: any) => Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : String(m.content);

for (const streamingBehavior of ["steer", "followUp"] as const) for (const interleaving of ["consumed", "overlapping-input", "input-during-offer", "initial-input", "edit-during-wait", "edit-after-wait"] as const) {
  test(`real SDK ${streamingBehavior}: ${interleaving} input fencing`, { timeout: 15000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "async-consumed-input-"));
    const agentDir = join(root, "agent"); mkdirSync(agentDir);
    const oldArgv = process.argv;
    process.argv = ["node", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js")];
    const foregroundGate = deferred(), foregroundStarted = deferred(), summaryGate = deferred();
    const lateInputGate = deferred(), lateInputEntered = deferred();
    let lateInput: Promise<unknown> | undefined;
    let enqueueLate!: () => Promise<unknown>;
    let constraintId: string;
    const editConstraint = () => sm.appendContextEdit(constraintId, { content: "UPDATED_CONSTRAINT_MUST_SURVIVE" });
    let foreground = 0, background = 0, native = 0, starts = 0;
    const errors: unknown[] = [];
    const runtime = await ModelRuntime.create({ authPath: join(root, "no-auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:1", api: "fake-api", apiKey: "local-only", streamSimple: (model, context) => {
      const isBackground = context.messages.some(m => /Summarize the following effective conversation/.test(text(m)));
      const isNative = !isBackground && context.messages.some(m => /[Ss]ummariz|[Cc]ompact/.test(text(m)));
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (isBackground) { background++; await summaryGate.promise; }
        else if (isNative) native++;
        else { foreground++; if (foreground === 4) { foregroundStarted.resolve(); await foregroundGate.promise; } }
        const input = isBackground || isNative ? 100 : foreground <= 2 ? 1000 : foreground === 5 ? 16000 : 12000;
        const message = { role: "assistant" as const, content: [{ type: "text" as const, text: isBackground ? "BACKGROUND RESULT" : isNative ? "NATIVE RESULT" : `answer-${foreground}` }], api: model.api, provider: model.provider, model: model.id,
          usage: { input, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: input + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() };
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: "stop", message }); stream.end();
      })();
      return stream;
    }, models: [{ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 512 }] });
    const sm = SessionManager.inMemory(root);
    await writeMachinePreference("asyncCompaction", true, join(agentDir, "settings.json"));
    const loader = new DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [pi => {
      pi.on("agent_start", async () => {
        starts++;
        if (interleaving === "initial-input" && starts === 4) { lateInput = enqueueLate(); await lateInputEntered.promise; }
      });
      pi.on("session_before_compact", (event, ctx) => {
        if (event.reason === "threshold" && foreground === 5) {
          assert.equal(ctx.hasPendingMessages(), false);
          assert.ok(sm.getBranch().some(e => e.type === "message" && e.message.role === "user" && text(e.message) === "queued requirement"));
          // Release only after Async enters its hook, exercising an in-flight
          // candidate rather than merely returning an already-ready result.
          setImmediate(() => {
            if (["input-during-offer", "edit-during-wait", "edit-after-wait"].includes(interleaving)) {
              lateInput = enqueueLate();
              void lateInputEntered.promise.then(() => {
                if (interleaving === "edit-during-wait") editConstraint();
                summaryGate.resolve();
              });
            } else summaryGate.resolve();
          });
        }
      });
      extension(pi, { settingsFile: join(agentDir, "settings.json"), submitMetric: async () => ({ status: "disabled" }) as any });
      pi.on("session_before_compact", () => {
        if (interleaving === "edit-after-wait" && foreground === 5) editConstraint();
      });
      pi.on("input", async (event) => {
        if (event.text === "late unmaterialized input") { lateInputEntered.resolve(); await lateInputGate.promise; }
      });
    }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: root, agentDir, model: runtime.getModel("fake", "m"), thinkingLevel: "off", modelRuntime: runtime, resourceLoader: loader, sessionManager: sm,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }) });
    await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, onTerminalInput: () => () => {} } as never, onError: error => errors.push(error) });
    enqueueLate = () => session[streamingBehavior]("late unmaterialized input");
    let run: Promise<void> | undefined;
    try {
      await session.prompt("history one " + "constraint ".repeat(800));
      constraintId = sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!.id;
      await session.prompt("history two " + "constraint ".repeat(800));
      await session.prompt("start background");
      assert.equal(background, 1);
      run = session.prompt("keep working");
      await foregroundStarted.promise;
      const startsBefore = starts;
      await session.prompt("queued requirement", { streamingBehavior });
      assert.equal(sm.getBranch().some(e => e.type === "message" && e.message.role === "user" && text(e.message) === "queued requirement"), false, "queued input is not yet persisted");
      if (interleaving === "overlapping-input") {
        lateInput = enqueueLate();
        await lateInputEntered.promise;
      }
      foregroundGate.resolve();
      await run;
      assert.equal(starts, startsBefore, "steering/follow-up stays in the same agent run");
      assert.equal(background, 1, "no replacement summary request");
      const compact = sm.getBranch().filter(e => e.type === "compaction").at(-1);
      if (interleaving === "edit-during-wait" || interleaving === "edit-after-wait") {
        assert.equal(compact, undefined, "stale preparation must not be committed");
        assert.equal(native, 0, "stale preparation must not trigger native generation");
        assert.ok(sm.buildSessionProjection().messages.some(m => text(m).includes("UPDATED_CONSTRAINT_MUST_SURVIVE")));
      } else if (interleaving === "consumed") {
        assert.ok(compact);
        assert.equal(native, 0, "consumed input must not force native fallback");
        assert.match(compact.summary, /BACKGROUND RESULT/);
        assert.ok(sm.getBranch().some(e => e.type === "custom" && e.customType === "async-compact-progress" && (e.data as any)?.phase === "waiting"));
        assert.ok(sm.buildSessionProjection().messages.some(m => m.role === "user" && text(m) === "queued requirement"), "new requirement survives compaction");
      } else {
        assert.ok(compact);
        assert.ok(native > 0, "unmaterialized late input must preserve native ownership");
        assert.notEqual((compact.details as any)?.kind, "async-compact");
        assert.equal(sm.getBranch().some(e => e.type === "message" && e.message.role === "user" && text(e.message) === "late unmaterialized input"), false);
      }
      assert.deepEqual(errors, []);
    } finally {
      foregroundGate.resolve(); summaryGate.resolve(); lateInputGate.resolve();
      if (lateInput) await lateInput.catch(() => {});
      if (run) await run.catch(() => {});
      session.dispose(); process.argv = oldArgv; rmSync(root, { recursive: true, force: true });
    }
  });
}
