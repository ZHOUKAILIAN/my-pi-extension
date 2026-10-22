import { after, before, test } from "node:test";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from "node:assert/strict";
import extension, { isolatedProfile, supportedHost } from "../src/index.ts";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js");
import { Reporting } from "../src/reporting.ts";
import { settings } from "../src/compaction.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { writeMachinePreference } from "../src/machine-settings.ts";
import { Controller } from "../src/controller.ts";
import { isolatedSettingsFile } from "./test-settings.ts";

const entry = "/tmp/repo/packages/async-compaction/src/index.ts";
let agentDir: string;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
before(() => { agentDir = mkdtempSync(join(tmpdir(), 'async-guards-agent-')); process.env.PI_CODING_AGENT_DIR = agentDir; });
after(() => { if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; rmSync(agentDir, { recursive: true, force: true }); });
test("only an explicit isolated invocation can offer a candidate", () => {
  assert.equal(isolatedProfile(["node", "pi", "--no-extensions", "-e", entry]), true);
  for (const argv of [
    ["node", "pi", "-e", entry], ["node", "pi", "-ne", "-e", entry, "-e", "other.ts"],
    ["node", "pi", "-ne", "-e", "other.ts"], ["node", "pi", "-ne", "-e"],
  ]) assert.equal(isolatedProfile(argv), false);
});
test("command validation, idempotence, mode rejection and session reset", async () => {
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  const events = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = { registerCommand: (_name: string, command: { handler: typeof handler }) => handler = command.handler, registerEntryRenderer() {}, appendEntry() {}, on: (name: string, callback: (event: unknown, ctx: unknown) => void) => events.set(name, callback) };
  extension(pi as never, { settingsFile: isolatedSettingsFile(agentDir) });
  const notices: string[] = [];
  const ctx = (mode: string) => ({ mode, ui: { notify: (s: string) => notices.push(s), onTerminalInput: () => () => {} }, sessionManager: { getSessionId: () => "a" } });
  for (const args of ["", "ON", "on extra", "reset", "on/off"]) await handler(args, ctx("tui"));
  assert.equal(notices.length, 5);
  await handler("on", ctx("print"));
  assert.match(notices.at(-1)!, /main TUI/);
  const argv = process.argv;
  process.argv = ["node", cli, "-ne", "-e", entry];
  try {
    assert.equal(supportedHost(), true);
    await events.get("session_start")!({}, ctx("tui"));
    await handler("on", ctx("tui")); await handler("on", ctx("tui"));
    await handler("off", ctx("tui")); await handler("off", ctx("tui"));
    assert.deepEqual(notices.slice(-4), ["async-compact preference is On; current model or automatic compaction is unsupported, native compaction remains active", "async-compact preference is On; current model or automatic compaction is unsupported, native compaction remains active", "async-compact off", "async-compact off"]);
    events.get("session_shutdown")!({}, ctx("tui"));
    assert.equal(supportedHost(["node", "pi"]), false);
  } finally { process.argv = argv; }
});
test("terminal escape observer leaves ordinary keys and paste unconsumed, and detaches on Off or leave", async () => {
  let handler!: (args: string, ctx: any) => Promise<void>;
  let listener: ((data: string) => unknown) | undefined;
  let detaches = 0;
  const events = new Map<string, (event: unknown, ctx: any) => unknown>();
  extension({ registerCommand: (_name: string, command: { handler: typeof handler }) => handler = command.handler,
    registerEntryRenderer() {}, appendEntry() {}, on: (name: string, cb: (event: unknown, ctx: any) => unknown) => events.set(name, cb) } as never, { settingsFile: isolatedSettingsFile(agentDir) });
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "observer" },
    ui: { notify() {}, onTerminalInput: (cb: (data: string) => unknown) => { listener = cb; return () => { detaches++; listener = undefined; }; } } };
  const argv = process.argv; process.argv = ["node", cli, "-ne", "-e", entry];
  try {
    await handler("on", ctx);
    for (const data of ["x", "\u001b[200~paste\u001b[201~", "\u001b", "\u001b[27u", "\u001b[27;1u"]) assert.equal(listener?.(data), undefined);
    await handler("off", ctx); assert.equal(listener, undefined); assert.equal(detaches, 1);
    await handler("on", ctx); assert.ok(listener);
    assert.equal(events.has("session_before_switch"), false, 'cancellable before-navigation hooks do not tear down the active preference');
    assert.ok(listener, 'the active Escape observer remains attached until a committed scope exit or Off');
    await events.get("session_shutdown")!({}, ctx);
    assert.equal(listener, undefined); assert.equal(detaches, 2);
  } finally { process.argv = argv; }
});

test("enabled threshold input preflight preserves native ownership and shows/clears fallback; manual and Off stay silent", async () => {
  const events = new Map<string, (event: any, ctx: any) => unknown>();
  const entries: { kind: string; data: any }[] = [];
  let handler!: (args: string, ctx: any) => Promise<void>;
  let renderer!: (entry: { data: { attemptId: string; revision: number } }) => { render(width: number): string[] };
  const pi = {
    registerCommand: (_name: string, command: { handler: typeof handler }) => handler = command.handler,
    registerEntryRenderer: (name: string, callback: typeof renderer) => { if (name === "async-compact-progress") renderer = callback; },
    appendEntry: (kind: string, data: unknown) => entries.push({ kind, data }),
    on: (name: string, cb: (event: any, ctx: any) => unknown) => events.set(name, cb),
  };
  extension(pi as never, { settingsFile: isolatedSettingsFile(agentDir) });
  const ctx = { mode: "tui", ui: { notify() {}, onTerminalInput: () => () => {} }, sessionManager: { getSessionId: () => "a", getBranch: () => [] } };
  const argv = process.argv; process.argv = ["node", cli, "-ne", "-e", entry];
  const event = (reason: string) => ({ reason, signal: new AbortController().signal, preparation: { fileOps: { read: new Set(), edited: new Set(), written: new Set() } } });
  try {
    await handler("on", ctx);
    events.get("agent_end")!({ messages: [] }, ctx);
    await events.get("input")!({ type: "input", text: "/skill:large-prompt", source: "interactive" }, ctx);
    assert.equal(await events.get("session_before_compact")!(event("threshold"), ctx), undefined);
    assert.equal(entries.filter(e => e.kind === "async-compact-timing").length, 0, "the sample is persisted at the matching terminal hook, not at start");
    assert.equal(entries.filter(e => e.kind === "async-compact-progress").length, 1, "preflight bypass shows fallback without offering");
    const progress = entries.find(e => e.kind === "async-compact-progress")!;
    assert.deepEqual(renderer(progress).render(80), ["async-compact native fallback"], `entries=${JSON.stringify(entries)}`);
    events.get("session_compact")!({ compactionEntry: {} }, ctx);
    assert.equal(entries.filter(e => e.kind === "async-compact-timing").length, 1, "threshold input preflight still records a stage without a background attempt");
    assert.equal(entries.find(e => e.kind === "async-compact-timing")?.data.kind, "foreground_compaction");
    assert.deepEqual(renderer(progress).render(80), [], "terminal native event clears it without new input");
    assert.equal(await events.get("session_before_compact")!(event("manual"), ctx), undefined);
    assert.equal(entries.filter(e => e.kind === "async-compact-progress").length, 2, "manual does not add a fallback phase");
    await handler("off", ctx);
    assert.equal(await events.get("session_before_compact")!(event("threshold"), ctx), undefined);
    assert.equal(entries.filter(e => e.kind === "async-compact-progress").length, 2, "Off remains silent");
    assert.equal(entries.filter(e => e.kind === "async-compact-timing").length, 1, "Off and unsupported opportunities do not create a foreground sample");
  } finally { process.argv = argv; }
});
test("ready candidate can be offered at next-turn threshold; preflight/manual/overflow preserve native ownership", async () => {
  const argv = process.argv; process.argv = ["node", cli, "-ne", "-e", entry];
  const originalOffer = Controller.prototype.offer;
  const offered: unknown[] = [];
  Controller.prototype.offer = async function(ctx, preparation, signal) {
    const result = await originalOffer.call(this, ctx, preparation, signal);
    offered.push(result);
    return result;
  };
  try {
    for (const reason of ["allowed", "mid-run", "preflight", "manual", "overflow"] as const) {
      await writeMachinePreference("asyncCompaction", true, join(agentDir, "settings.json"));
      const sm = SessionManager.inMemory(agentDir);
      const usage = { input: 18, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 27, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      for (let n = 1; n <= 2; n++) {
        sm.appendMessage({ role: "user", content: [{ type: "text", text: `user-${n} ` + "word ".repeat(160) }], timestamp: Date.now() });
        sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `answer-${n} ` + "answer ".repeat(40) }], api: "fake-api", provider: "fake", model: "m", stopReason: "stop", timestamp: Date.now(), usage });
      }
      let settle!: (value: unknown) => void;
      let backgroundSignal!: AbortSignal;
      const entries: { kind: string; data: any }[] = [], handlers = new Map<string, Function>();
      let command!: (args: string, ctx: any) => Promise<void>;
      const pi: any = {
        registerCommand: (_name: string, options: any) => command = options.handler,
        registerEntryRenderer() {}, appendEntry: (kind: string, data: any) => entries.push({ kind, data }),
        getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }), getAllTools: () => [], getActiveTools: () => [],
        on: (name: string, callback: Function) => { handlers.set(name, callback); },
      };
      extension(pi, { settingsFile: join(agentDir, "settings.json"), agentType: "main" });
      const ctx: any = {
        mode: "tui", model: { provider: "fake", id: "m", api: "fake-api", contextWindow: 4096 }, thinkingLevel: "off", sessionManager: sm,
        hasPendingMessages: () => false, getSystemPrompt: () => "system", getContextUsage: () => ({ tokens: 2900, contextWindow: 4096 }),
        modelRegistry: { streamSimple: (_model: unknown, _messages: unknown, options: { signal: AbortSignal }) => { backgroundSignal = options.signal; return { result: () => new Promise(resolve => settle = resolve) }; } },
        ui: { notify() {}, onTerminalInput: () => () => {} },
      };
      await handlers.get("session_start")!({}, ctx);
      await command("on", ctx);
      handlers.get("agent_end")!({ messages: [] }, ctx);
      await handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "stop" } }, ctx);
      assert.equal(typeof settle, "function", "the setup produced a real scheduled candidate request");
      settle({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ready summary" }], usage, api: "fake-api", provider: "fake", model: "m", timestamp: Date.now() });
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      const generating = entries.find(entry => entry.kind === "async-compact-progress")?.data;
      assert.ok(generating, "candidate generation started before exercising its consumer gate");
      if (reason === "mid-run") handlers.get("agent_start")!({}, ctx);
      if (reason === "preflight") {
        handlers.get("agent_end")!({ messages: [] }, ctx);
        await handlers.get("input")!({ type: "input", text: "next prompt", source: "interactive" }, ctx);
      }
      const before = { reason: reason === "manual" || reason === "overflow" ? reason : "threshold", signal: new AbortController().signal,
        preparation: { tokensBefore: 2900, firstKeptEntryId: "unused", isSplitTurn: false, settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, fileOps: { read: new Set(), edited: new Set(), written: new Set() } } };
      const offersBefore = offered.length;
      const result = await handlers.get("session_before_compact")!(before, ctx);
      if (reason === "allowed" || reason === "mid-run") {
        assert.ok(result, `${reason} ready candidate with complete preparation is offered`);
        assert.equal(offered.length, offersBefore + 1);
        assert.ok(offered.at(-1), "the offer spy observed a usable candidate");
      } else {
        assert.equal(result, undefined, `${reason} must leave the native compaction path in control`);
        assert.equal(offered.length, offersBefore, `${reason} must not call Controller.offer`);
      }
      if (reason === "manual" || reason === "overflow") {
        assert.equal(backgroundSignal.aborted, true, `${reason} cancels the candidate and retains native ownership`);
        assert.equal(entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "native", `${reason} retires only the async candidate and is not attributed to a user`);
      }
      else if (reason === "preflight") assert.ok(entries.some(entry => entry.kind === "async-compact-progress" && entry.data.attemptId !== generating.attemptId), `${reason} signals native fallback rather than returning the candidate`);
      assert.equal(sm.getBranch().some(entry => entry.type === "compaction"), false, "the extension never commits compaction itself");
      handlers.get("session_shutdown")!({}, ctx);
    }
  } finally { Controller.prototype.offer = originalOffer; process.argv = argv; }
});

test("schedule diagnostics are structured, deduplicated, bounded, and non-visible", () => {
  const entries: { kind: string; data: any }[] = [];
  const report = new Reporting({ registerEntryRenderer() {}, appendEntry: (kind: string, data: any) => entries.push({ kind, data }) } as never);
  const sample = { reason: "below_threshold" as const, trigger: "assistant_stop" as const, generation: 1, entry: "tui", tokens: 100, window: 1000, reserve: 100, threshold: 585, hardLimit: 900, enabled: true };
  report.schedule(sample); report.schedule(sample);
  assert.equal(entries.length, 1, "identical repeated gate decisions are deduplicated");
  assert.deepEqual(entries[0].data, { schemaVersion: 1, ...sample });
  for (let n = 0; n < 100; n++) report.schedule({ ...sample, tokens: n });
  assert.equal(entries.length, 1, "token fluctuations during low-pressure polling do not consume diagnostic slots");
  for (const reason of ["pending_input", "preference_off", "effective_settings_unavailable"] as const) report.schedule({ ...sample, reason, tokens: 900 });
  assert.deepEqual(entries.slice(1).map(entry => entry.data.reason), ["pending_input", "preference_off", "effective_settings_unavailable"], "later high-pressure and gate failures remain observable after repeated low-pressure checks");
  for (let n = 0; n < 70; n++) report.schedule({ ...sample, reason: "slot_busy", window: 1000 + n });
  assert.equal(entries.filter(entry => entry.data.reason === "slot_busy").length, 60, "distinct busy diagnostics remain bounded by the per-generation ceiling");
  assert.equal(entries.at(-1)?.data.reason, "diagnostics_saturated", "omitted diagnostics leave one explicit bounded saturation marker");
  assert.equal(entries.at(-1)?.data.suppressedReason, "slot_busy");
  const saturatedCount = entries.length;
  report.schedule({ ...sample, reason: "slot_busy", window: 9999 });
  assert.equal(entries.length, saturatedCount, "repeated busy decisions after saturation do not emit repeated markers");
  const beforeGeneration = entries.length;
  report.schedule({ ...sample, generation: 2 });
  assert.equal(entries.length, beforeGeneration + 1, "a new controller generation opens a fresh bounded diagnostic scope");
  assert.equal(entries.at(-1)?.data.reason, "below_threshold");
  assert.equal(entries.some(entry => entry.kind === "async-compact-progress"), false, "schedule explanations do not create visible progress");
});

test("effective compaction settings respect auto-disabled and model override", () => {
  const ctx = { model: { provider: "fake", id: "m", contextWindow: 4096 } };
  const pi = (compaction: unknown) => ({ getSettings: () => ({ compaction }) });
  assert.equal(settings(pi({ enabled: false }) as never, ctx as never), null);
  assert.deepEqual(settings(pi({ enabled: true, reserveTokens: 100, keepRecentTokens: 200, modelOverrides: { "fake/m": { reserveTokens: 512, keepRecentTokens: 1 } } }) as never, ctx as never), { enabled: true, reserveTokens: 512, keepRecentTokens: 1 });
  assert.equal(settings(pi({ enabled: true, reserveTokens: 4096, keepRecentTokens: 1 }) as never, ctx as never), null);
});
test("progress renders only while active; usage entries are deduplicated and contain no original prompt", () => {
  const entries: { kind: string; data: unknown }[] = [];
  let renderer!: (entry: { data: { attemptId: string } }) => { render(width: number): string[] };
  let usageRenderer!: (entry: { data: unknown }, options: unknown, theme: { fg: (color: string, text: string) => string }) => { render(width: number): string[] };
  const pi = { appendEntry: (kind: string, data: unknown) => entries.push({ kind, data }), registerEntryRenderer: (kind: string, fn: typeof renderer) => { if (kind === "async-compact-progress") renderer = fn; else if (kind === "async-compact-usage") usageRenderer = fn as typeof usageRenderer; } };
  const report = new Reporting(pi as never);
  report.start("a");
  assert.equal(entries.find(entry => entry.kind === "async-compact-progress")?.data.phase, "generating", "persisted progress identifies the actual phase, not only its revision");
  assert.deepEqual(renderer({ data: { attemptId: "a", revision: 1 } }).render(80), ["async-compact generating"]);
  report.phase("a", "waiting");
  assert.equal(entries.filter(entry => entry.kind === "async-compact-progress").at(-1)?.data.phase, "waiting");
  assert.deepEqual(renderer({ data: { attemptId: "a", revision: 1 } }).render(80), []);
  assert.deepEqual(renderer({ data: { attemptId: "a", revision: 2 } }).render(80), ["async-compact waiting for background summary"]);
  report.phase("native", "fallback");
  report.hide("a", true);
  assert.deepEqual(renderer({ data: { attemptId: "native", revision: 1 } }).render(80), ["async-compact native fallback"]);
  report.hide("native", true);
  report.finish({ attemptId: "a", model: "m", provider: "p", outcome: "discarded", metering: "unknown", usage: null, includedInNativeTotals: false });
  report.finish({ attemptId: "a", model: "m", provider: "p", outcome: "discarded", metering: "unknown", usage: null, includedInNativeTotals: false });
  assert.deepEqual(renderer({ data: { attemptId: "a" } }).render(80), []);
  assert.deepEqual(renderer({ data: { attemptId: "old" } }).render(80), []);
  assert.equal(entries.filter(e => e.kind === "async-compact-usage").length, 1);
  const theme = { fg: (_color: string, text: string) => text };
  for (const [metering, expected] of [["unknown", "usage unknown"], ["partial", "usage partial (remainder unknown)"], ["reported", "usage reported"]] as const) {
    const data = { outcome: "failed", metering, includedInNativeTotals: false, usage: metering === "unknown" ? null : { input: 1234, output: 90, reasoning: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 10, totalTokens: 1394, cost: { input: .02, output: .01, cacheRead: .001, cacheWrite: .002, total: .033 } } };
    const normal = usageRenderer({ data }, {}, theme).render(1000).join("");
    assert.match(normal, new RegExp(expected.replace(/[()]/g, "\\$&")));
    if (metering === "unknown") assert.doesNotMatch(normal, /tokens 0|\$0/);
    else {
      assert.match(normal, /1,394.*input 1,234.*output 90.*cache read 30.*cache write 40.*SDK estimated cost \$0\.033000/);
      const expanded = usageRenderer({ data }, { expanded: true }, theme).render(1000).join("");
      assert.match(expanded, /reasoning 20 \(included in output\).*1h cache write 10 \(included in cache write\)/);
      assert.doesNotMatch(normal, /reasoning 20/);
    }
  }
  assert.match(usageRenderer({ data: { outcome: "adopted", metering: "reported", includedInNativeTotals: true, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: .1 } } } }, {}, theme).render(1000).join(""), /native totals.*tokens 3/);
  assert.equal(JSON.stringify(entries).includes("prompt"), false);
});
