import { test } from "node:test";
import assert from "node:assert/strict";
import extension, { isolatedProfile, supportedHost } from "../src/index.ts";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js");
import { Reporting } from "../src/reporting.ts";
import { settings } from "../src/compaction.ts";

const entry = "/tmp/repo/packages/async-compaction/src/index.ts";
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
  extension(pi as never);
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
    events.get("session_start")!({}, ctx("tui"));
    await handler("on", ctx("tui")); await handler("on", ctx("tui"));
    await handler("off", ctx("tui")); await handler("off", ctx("tui"));
    assert.deepEqual(notices.slice(-4), ["async-compact on", "async-compact on", "async-compact off", "async-compact off"]);
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
    registerEntryRenderer() {}, appendEntry() {}, on: (name: string, cb: (event: unknown, ctx: any) => unknown) => events.set(name, cb) } as never);
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "observer" },
    ui: { notify() {}, onTerminalInput: (cb: (data: string) => unknown) => { listener = cb; return () => { detaches++; listener = undefined; }; } } };
  const argv = process.argv; process.argv = ["node", cli, "-ne", "-e", entry];
  try {
    await handler("on", ctx);
    for (const data of ["x", "\u001b[200~paste\u001b[201~", "\u001b", "\u001b[27u", "\u001b[27;1u"]) assert.equal(listener?.(data), undefined);
    await handler("off", ctx); assert.equal(listener, undefined); assert.equal(detaches, 1);
    await handler("on", ctx); assert.ok(listener);
    events.get("session_before_switch")!({}, ctx);
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
  extension(pi as never);
  const ctx = { mode: "tui", ui: { notify() {}, onTerminalInput: () => () => {} }, sessionManager: { getSessionId: () => "a", getBranch: () => [] } };
  const argv = process.argv; process.argv = ["node", cli, "-ne", "-e", entry];
  const event = (reason: string) => ({ reason, signal: new AbortController().signal, preparation: { fileOps: { read: new Set(), edited: new Set(), written: new Set() } } });
  try {
    await handler("on", ctx);
    events.get("agent_end")!({ messages: [] }, ctx);
    events.get("input")!({ type: "input", text: "/skill:large-prompt", source: "interactive" }, ctx);
    assert.equal(await events.get("session_before_compact")!(event("threshold"), ctx), undefined);
    assert.equal(entries.filter(e => e.kind === "async-compact-timing").length, 0, "the sample is persisted at the matching terminal hook, not at start");
    assert.equal(entries.filter(e => e.kind === "async-compact-progress").length, 1, "preflight bypass shows fallback without offering");
    const progress = entries[0];
    assert.deepEqual(renderer(progress).render(80), ["async-compact native fallback"]);
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
  assert.deepEqual(renderer({ data: { attemptId: "a", revision: 1 } }).render(80), ["async-compact generating"]);
  report.phase("a", "waiting");
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
