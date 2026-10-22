import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { Controller } from "../src/controller.ts";
import { isolatedSettingsFile } from "./test-settings.ts";
import { writeMachinePreference } from "../src/machine-settings.ts";

const usage = (input: number) => ({ input, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: input + 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const text = (message: { content: unknown }) => Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("") : String(message.content);

async function runPostHandlerEditScenario(candidateFailure: boolean, editAfterOffer = true, priorCandidate = false, laterCandidate = false, unfitCandidate = false) {
  const cwd = mkdtempSync(join(tmpdir(), "async-post-hook-failure-")), agentDir = join(cwd, "agent"), dir = join(cwd, "sessions");
  mkdirSync(agentDir); mkdirSync(dir);
  const previousArgv = process.argv, previousAgentDir = process.env.PI_CODING_AGENT_DIR, previousSettings = process.env.PI_MY_EXTENSIONS_SETTINGS_FILE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.argv = ["node", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js"), "--no-extensions", "-e", resolve("packages/async-compaction/src/index.ts")];
  const summaryRequests: string[] = [], hostNativeRequests: string[] = [];
  const originalSchedule = Controller.prototype.schedule;
  let foregroundNumber = 0, injectEdit = false, editApplied = false, priorCandidateReturns = 0;
  const errors: unknown[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:1", api: "fake-api", apiKey: "test-only", streamSimple: (model, context) => {
    const content = context.messages.map(text).join("\n");
    const summary = /Summarize the following effective conversation/.test(content);
    const hostNative = /The messages above are a conversation to summarize|The messages above are earlier context/.test(content);
    if (summary) {
      summaryRequests.push(content);
      if (candidateFailure && summaryRequests.length === 1) throw new Error("synthetic background failure");
    } else if (hostNative) hostNativeRequests.push(content);
    else foregroundNumber++;
    const input = summary || hostNative ? 100 : foregroundNumber === 1 ? 800 : foregroundNumber === 2 ? 2800 : 3800;
    const value = hostNative ? (content.includes("UPDATED_POST_HANDLER_CONSTRAINT") ? "SUMMARY_PRESERVED_UPDATED_CONSTRAINT" : "SUMMARY_MISSED_UPDATED_CONSTRAINT") : summary ? "ASYNC CANDIDATE SUMMARY" : `foreground-${foregroundNumber} ` + "answer ".repeat(40);
    const message = { role: "assistant" as const, content: [{ type: "text" as const, text: value }], api: model.api, provider: model.provider, model: model.id, usage: usage(input), stopReason: "stop" as const, timestamp: Date.now() };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "text", contentIndex: 0, delta: value });
    stream.push({ type: "done", reason: "stop", message }); stream.end();
    return stream;
  }, models: [{ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 512 }] });
  const sm = SessionManager.create(cwd, dir), settingsFile = isolatedSettingsFile(agentDir);
  await writeMachinePreference("asyncCompaction", true, settingsFile);
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [pi => {
    if (priorCandidate) pi.on("session_before_compact", event => {
      if (event.reason !== "threshold") return;
      priorCandidateReturns++;
      return { compaction: { summary: "PRECEDING_EXTENSION_CANDIDATE", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { kind: "fixture" } } };
    });
    extension(pi, { settingsFile, agentType: "main" });
    pi.on("session_before_compact", (event, ctx) => {
      if (!injectEdit || event.reason !== "threshold") return;
      injectEdit = false;
      const target = ctx.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("KEEP_ORIGINAL_CONTEXT_CONSTRAINT"));
      assert.ok(target, "the original constrained user turn is in the live branch before the later hook");
      ctx.sessionManager.appendContextEdit(target.id, { content: [{ type: "text", text: "UPDATED_POST_HANDLER_CONSTRAINT " + "preserve-new-context ".repeat(160) }] });
      editApplied = true;
    });
    if (laterCandidate) pi.on("session_before_compact", event => {
      if (event.reason !== "threshold") return;
      return { compaction: { summary: "LATER_EXTENSION_CANDIDATE", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { kind: "later-hook-fixture" } } };
    });
  }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, model: runtime.getModel("fake", "m"), thinkingLevel: "off", modelRuntime: runtime, resourceLoader: loader, sessionManager: sm,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }), noTools: true });
  await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, onTerminalInput: () => () => {} } as never, onError: error => errors.push(error) });
  if (!candidateFailure && !unfitCandidate) Controller.prototype.schedule = function() {};
  try {
    await session.prompt("/async-compact on");
    await session.prompt("KEEP_ORIGINAL_CONTEXT_CONSTRAINT " + "words ".repeat(160));
    const toolCall = { type: "toolCall" as const, id: "fixture-call", name: "fixture_read", arguments: { path: "history.ts" } };
    const secondCall = { ...toolCall, id: "fixture-call-2", name: "fixture_edit", arguments: { path: "changed.ts" } };
    sm.appendMessage({ role: "assistant", content: [toolCall, secondCall], api: "fake-api", provider: "fake", model: "m", usage: usage(10), stopReason: "toolUse", timestamp: Date.now() });
    sm.appendMessage({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text: "read" }], isError: false, timestamp: Date.now() });
    sm.appendMessage({ role: "toolResult", toolCallId: secondCall.id, toolName: secondCall.name, content: [{ type: "text", text: "edited" }], isError: false, timestamp: Date.now() });
    await session.prompt("user-2 " + "words ".repeat(160));
    assert.equal(summaryRequests.length, candidateFailure || unfitCandidate ? 1 : 0, candidateFailure ? "the first summary attempt is the background candidate and failed synchronously" : unfitCandidate ? "a background candidate started before the live tail made it unfit" : "no background candidate was scheduled");
    if (unfitCandidate) {
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      const latestUser = sm.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1)!;
      sm.appendContextEdit(latestUser.id, { content: [{ type: "text", text: "user-2 words ".repeat(160) }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] });
    }
    injectEdit = editAfterOffer;
    await session.prompt("user-3 " + "words ".repeat(160));
    assert.equal(editApplied, editAfterOffer, "the real SDK exercised the configured later-hook edit path");
    assert.equal(priorCandidateReturns, priorCandidate ? 1 : 0, "the earlier extension returned exactly one valid hook candidate when configured");
    const projection = sm.buildSessionProjection().messages.map(text).join("\n");
    assert.equal(summaryRequests.length, candidateFailure || unfitCandidate ? 1 : 0, candidateFailure ? "the failed background request does not retry" : unfitCandidate ? "an unfit candidate does not trigger a replacement summary request" : "the no-candidate path starts no background request");
    if (unfitCandidate) assert.ok(sm.getBranch().some(entry => entry.type === "custom" && entry.customType === "async-compact-schedule" && entry.data?.reason === "insufficient_fit"), "the live image tail rejects the minimum candidate before waiting");
    if (editAfterOffer) {
      assert.equal(hostNativeRequests.length, 0, "changed history cancels the stale native request after candidate failure or no-candidate offer");
      assert.equal(sm.getBranch().some(entry => entry.type === "compaction"), false, "stale preparation is not committed");
      assert.match(projection, /UPDATED_POST_HANDLER_CONSTRAINT/, "the final model-visible context retains the later valid constraint");
      assert.doesNotMatch(projection, /KEEP_ORIGINAL_CONTEXT_CONSTRAINT/, "the edited-away content is not reinstated from stale preparation");
    } else {
      const nativeEntry = sm.getBranch().filter(entry => entry.type === "compaction").at(-1);
      if (laterCandidate) {
        assert.ok(nativeEntry?.fromHook, "a later handler result retains the SDK's last-nonempty-result precedence");
        assert.equal(nativeEntry?.summary, "LATER_EXTENSION_CANDIDATE", "the later hook can override this extension's guard result");
        assert.equal(hostNativeRequests.length, 0, "the later handler supplied the selected result");
      } else {
        assert.ok(hostNativeRequests.length > 0, "with unchanged history, no-candidate native fallback still makes its summarization requests");
        assert.ok(nativeEntry && !nativeEntry.fromHook, "unchanged no-candidate fallback remains Pi-owned native compaction");
        assert.match(String(nativeEntry?.summary), /SUMMARY_MISSED_UPDATED_CONSTRAINT/, "the native result was actually committed");
        if (priorCandidate) assert.notEqual(nativeEntry?.summary, "PRECEDING_EXTENSION_CANDIDATE", "the final Async guard intentionally overrides a prior hook candidate");
      }
    }
    assert.equal(errors.length, 0, JSON.stringify(errors));
  } finally {
    session.dispose(); Controller.prototype.schedule = originalSchedule; process.argv = previousArgv;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSettings === undefined) delete process.env.PI_MY_EXTENSIONS_SETTINGS_FILE; else process.env.PI_MY_EXTENSIONS_SETTINGS_FILE = previousSettings;
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("SDK keeps a post-handler context edit when background candidate generation has failed", () => runPostHandlerEditScenario(true));
test("SDK keeps native fallback on unchanged history after candidate generation failure", () => runPostHandlerEditScenario(true, false));
test("SDK keeps a post-handler context edit when no background candidate was generated", () => runPostHandlerEditScenario(false));
test("SDK keeps native fallback on unchanged history when no background candidate exists", () => runPostHandlerEditScenario(false, false));
test("SDK final no-candidate guard overrides an earlier hook candidate but preserves native fallback", () => runPostHandlerEditScenario(false, false, true));
test("SDK final no-candidate guard cancels an earlier hook candidate after a later edit", () => runPostHandlerEditScenario(false, true, true));
test("a later hook result still overrides the Async final guard by SDK ordering", () => runPostHandlerEditScenario(false, false, false, true));
test("SDK guards native preparation when a live image tail makes the candidate unfit", () => runPostHandlerEditScenario(false, true, false, false, true));
