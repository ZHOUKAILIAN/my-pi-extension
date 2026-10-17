import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Controller } from "../src/controller.ts";
import { committedFiles, filesIn, fits, plan, settings, withFiles } from "../src/compaction.ts";

const usage = { input: 18, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 27, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = (id = "m") => ({ provider: "fake", id, api: "fake-api", contextWindow: 4096 });
const tick = () => new Promise(r => setTimeout(r, 0));
function fixture() {
  const sm = SessionManager.inMemory("/tmp/async-compact-test");
  const append = (role: "user" | "assistant", n: number) => sm.appendMessage(role === "user" ? { role, content: [{ type: "text", text: `user-${n} ` + "word ".repeat(160) }], timestamp: Date.now() } : { role, content: [{ type: "text", text: `answer-${n} ` + "answer ".repeat(40) }], timestamp: Date.now(), api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage });
  append("user", 1); append("assistant", 1); append("user", 2); append("assistant", 2);
  let current = model(), pending = false, raw: unknown = { enabled: true, reserveTokens: 512, keepRecentTokens: 1 };
  let resolve!: (response: unknown) => void;
  const entries: { kind: string; data: any; session: string }[] = [], notices: string[] = [];
  const pi = {
    getSettings: () => ({ compaction: raw }), getAllTools: () => [], getActiveTools: () => [],
    registerEntryRenderer() {}, appendEntry: (kind: string, data: unknown) => entries.push({ kind, data, session: sm.getSessionId() }),
  } as any;
  const ctx = {
    sessionManager: sm, mode: "tui", ui: { notify: (message: string) => notices.push(message) }, model: current, thinkingLevel: "off", getSystemPrompt: () => "system",
    hasPendingMessages: () => pending, getContextUsage: () => ({ tokens: 2900, contextWindow: 4096 }),
    modelRegistry: { streamSimple: () => ({ result: () => new Promise(r => resolve = r) }) },
  } as any;
  const response = (value = "summary", u: unknown = usage, stopReason = "stop") => resolve({ role: "assistant", stopReason, content: [{ type: "text", text: value }], usage: u, errorMessage: "private provider body", headers: { authorization: "secret" } });
  return { sm, append, pi, ctx, entries, notices, response, respondBlocks: (content: unknown[], reason = "stop") => resolve({ role: "assistant", content, stopReason: reason, usage, api: "fake-api", provider: "fake", model: "m", timestamp: Date.now() }), setModel: (id: string) => ctx.model = model(id), setRaw: (value: unknown) => raw = value, setPending: (value: boolean) => pending = value };
}
const prep = { tokensBefore: 2900, firstKeptEntryId: "unused", isSplitTurn: false, settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } };

test("effective defaults, partial overrides, invalid values and virtual never send", () => {
  const f = fixture();
  f.setRaw(undefined); assert.equal(settings(f.pi, f.ctx), null, "4096 model cannot fit the default 16384 reserve");
  f.ctx.model.contextWindow = 128000;
  assert.deepEqual(settings(f.pi, f.ctx), { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 });
  f.setRaw({ modelOverrides: { "fake/m": { reserveTokens: 2000 } } });
  assert.deepEqual(settings(f.pi, f.ctx), { enabled: true, reserveTokens: 2000, keepRecentTokens: 20000 });
  f.setRaw({ enabled: false }); assert.equal(settings(f.pi, f.ctx), null);
  f.setRaw({ reserveTokens: -1 }); assert.equal(settings(f.pi, f.ctx), null);
  f.ctx.model.api = "pi-virtual"; f.setRaw({ reserveTokens: 512, keepRecentTokens: 1 });
  const c = new Controller(f.pi); c.set(true, f.ctx); c.schedule(f.ctx);
  assert.equal(f.entries.length, 0);
});

test("ordinary effective defaults can actually start background generation without explicit token settings", async () => {
  const f = fixture(); f.setRaw(undefined);
  f.ctx.model.contextWindow = 128000;
  f.ctx.getContextUsage = () => ({ tokens: 90000, contextWindow: 128000 });
  f.sm.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(100000) }], timestamp: Date.now() });
  f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "y".repeat(100000) }], timestamp: Date.now(), api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage });
  const c = new Controller(f.pi); c.set(true, f.ctx); c.schedule(f.ctx);
  assert.equal(f.entries.filter(e => e.kind === "async-compact-progress").length, 1);
  c.set(false, f.ctx); f.response("late"); await tick();
});
test("planning selects a useful complete prefix after a tiny first round; skips known non-text and impossible candidates", () => {
  const f = fixture();
  const first = f.sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!;
  f.sm.appendContextEdit(first.id, { content: [{ type: "text", text: "tiny" }] });
  f.ctx.model.contextWindow = 128_000;
  f.ctx.getContextUsage = () => ({ tokens: 94_000, contextWindow: 128_000 });
  f.setRaw({ enabled: true, reserveTokens: 1024, keepRecentTokens: 2000 });
  for (let n = 3; n <= 145; n++) {
    f.sm.appendMessage({ role: "user", content: [{ type: "text", text: "history ".repeat(550) }], timestamp: Date.now() });
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer ".repeat(110) }], timestamp: Date.now(), api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage });
  }
  const snapshot = plan(f.pi, f.ctx, 0)!;
  assert.ok(snapshot && snapshot.tokens > 20_000, "a tiny first turn must not determine the cut");
  assert.ok(snapshot.ids.length > 100);
  const c = new Controller(f.pi); c.set(true, f.ctx); c.schedule(f.ctx);
  assert.equal(f.entries.filter(e => e.kind === "async-compact-progress").length, 1);
  c.set(false, f.ctx); f.response();
  const g = fixture();
  g.sm.appendMessage({ role: "user", content: [{ type: "text", text: "tail ".repeat(20_000) }], timestamp: Date.now() });
  g.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "tail" }], timestamp: Date.now(), api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage });
  assert.equal(plan(g.pi, g.ctx, 0), null, "even an empty summary cannot fit the tail");
  const noCall = new Controller(g.pi); noCall.set(true, g.ctx); noCall.schedule(g.ctx);
  assert.equal(g.entries.length, 0);
  const h = fixture();
  h.sm.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: Date.now() });
  assert.equal(plan(h.pi, h.ctx, 0), null);
  const noImageCall = new Controller(h.pi); noImageCall.set(true, h.ctx); noImageCall.schedule(h.ctx);
  assert.equal(h.entries.length, 0, "known image must not produce a paid request");
});

test("persisted system checkpoint and known file labels are budgeted before any model request", async () => {
  for (const [systemLength, firstLength, oversizedFile] of [[12_000, 10, false], [4_000, 10_000, false], [4_000, 10_000, true]] as const) {
    const sm = SessionManager.inMemory("/tmp/async-compact-system-budget");
    const systemPrompt = "s".repeat(systemLength);
    sm.appendMessage({ role: "system", content: "", sections: { preamble: systemPrompt }, timestamp: Date.now() });
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "u".repeat(firstLength) }], timestamp: Date.now() });
    const callsBeforeCut = oversizedFile ? [{ type: "toolCall" as const, id: "r", name: "read", arguments: { path: "p".repeat(20_000) } }] : [{ type: "text" as const, text: "a".repeat(80) }];
    sm.appendMessage({ role: "assistant", content: callsBeforeCut, api: "fake-api", provider: "fake", model: "m", stopReason: oversizedFile ? "toolUse" : "stop", usage, timestamp: Date.now() });
    if (oversizedFile) sm.appendMessage({ role: "toolResult", toolCallId: "r", toolName: "read", content: [{ type: "text", text: "read" }], isError: false, timestamp: Date.now() });
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "t".repeat(2000) }], timestamp: Date.now() });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "a".repeat(80) }], api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage, timestamp: Date.now() });
    let calls = 0; let settle!: (value: unknown) => void;
    const pi = { getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 256 } }), getAllTools: () => [], getActiveTools: () => [], registerEntryRenderer() {}, appendEntry() {} } as any;
    const ctx = { sessionManager: sm, mode: "tui", model: { ...model(), contextWindow: 8192 }, thinkingLevel: "off", getSystemPrompt: () => systemPrompt,
      getContextUsage: () => ({ tokens: oversizedFile ? 7000 : 5500, contextWindow: 8192 }), hasPendingMessages: () => false, ui: { notify() {} },
      modelRegistry: { streamSimple: () => { calls++; return { result: () => new Promise(resolve => settle = resolve) }; } } } as any;
    assert.equal(sm.buildSessionProjection().messages[0]?.role, "system", "use a persisted system entry, not only ctx.getSystemPrompt");
    const snapshot = plan(pi, ctx, 0);
    if (firstLength === 10 || oversizedFile) assert.equal(snapshot, null, "no smallest legal summary can meet the native fit check");
    else { assert.ok(snapshot); assert.ok(fits(pi, ctx, snapshot, withFiles("x", snapshot.files), 5500)); }
    const c = new Controller(pi); c.set(true, ctx); c.schedule(ctx);
    assert.equal(calls, firstLength === 10 || oversizedFile ? 0 : 1);
    if (calls) { c.set(false, ctx); settle({ stopReason: "error", content: [], usage }); await tick(); }
  }
});

test("a legal thinking + final text response offers text only, while tool calls and incomplete shapes fail", async () => {
  for (const blocks of [
    [{ type: "thinking", thinking: "private thought", thinkingSignature: "signature" }, { type: "thinking", thinking: "private thought 2" }, { type: "text", text: "public summary" }],
    [{ type: "text", text: "public summary" }, { type: "toolCall", id: "one", name: "read", arguments: {} }],
    [{ type: "thinking", thinking: "private thought" }],
    [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: "public summary" }],
  ]) {
    const f = fixture(), c = new Controller(f.pi); c.set(true, f.ctx); c.schedule(f.ctx);
    f.respondBlocks(blocks); await tick();
    const offered = await c.offer(f.ctx, prep, new AbortController().signal);
    assert.equal(!!offered, blocks === undefined ? false : blocks.length === 3 && blocks[0].type === "thinking");
    if (offered) { assert.match(offered.summary, /public summary/); assert.doesNotMatch(offered.summary, /private thought|signature/); }
    else assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.outcome, "failed");
  }
});

test("file lists accumulate from effective tool calls, nested results and prior hooked details", () => {
  const f = fixture();
  const snap = plan(f.pi, f.ctx, 0)!;
  assert.ok(snap);
  const messages = [...snap.messages, { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "a.ts" } }, { type: "toolCall", name: "edit", arguments: { path: "b.ts" } }] }, { role: "toolResult", content: [], nestedCalls: { calls: [{ name: "write", arguments: { path: "a.ts" } }] } }] as any;
  const files = filesIn(messages, { readFiles: ["old.ts"], modifiedFiles: ["base.ts"] });
  assert.deepEqual(files, { readFiles: ["old.ts"], modifiedFiles: ["a.ts", "b.ts", "base.ts"] });
  assert.match(withFiles("summary", files), /<modified-files>\na.ts/);
  assert.equal(filesIn([{ ...messages[0], content: [{ type: "text", text: "read(a.ts)" }] }] as any).readFiles.length, 0, "do not mistake text for tool calls");
  assert.deepEqual(committedFiles({ fromHook: true, details: { kind: "async-compact", version: 1, attemptId: "one", ...files } }), files);
  for (const entry of [{ fromHook: true, details: files }, { fromHook: true, details: { kind: "other", version: 1, attemptId: "one", ...files } }, { fromHook: true, details: { kind: "async-compact", version: 1, attemptId: "one", readFiles: [1], modifiedFiles: [] } }]) assert.equal(committedFiles(entry), null);
});

test("ready survives generation deadline, uses new branch record even when event points to an older identical summary", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), c = new Controller(f.pi);
  c.set(true, f.ctx); c.schedule(f.ctx); f.response("same"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(120_001);
  const first = await c.offer(f.ctx, { ...prep }, new AbortController().signal);
  assert.ok(first);
  // Actual host searches the first matching summary for its event. The active branch is authoritative.
  f.sm.appendCompaction(first.summary, first.firstKeptEntryId, first.tokensBefore, first.details, true, first.usage);
  const old = f.sm.getBranch().filter(e => e.type === "compaction").at(-1)!;
  c.compact(f.ctx, old);
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.outcome, "adopted");
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").length, 1);
  // Native event duplicated: cannot record twice.
  c.compact(f.ctx, old);
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").length, 1);
  // Independent next generation, same summary, with the previous details retained by the projection.
  f.append("user", 3); f.append("assistant", 3); f.append("user", 4); f.append("assistant", 4);
  const next = new Controller(f.pi); next.set(true, f.ctx); next.schedule(f.ctx); f.response("same"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  const second = await next.offer(f.ctx, { ...prep }, new AbortController().signal);
  assert.ok(second);
  f.sm.appendCompaction(second.summary, second.firstKeptEntryId, second.tokensBefore, second.details, true, second.usage);
  next.compact(f.ctx, old);
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.outcome, "adopted");
  assert.equal(f.sm.getBranch().filter(e => e.type === "compaction").length, 2);
});

test("cancel, late response, off/on, switch, failure and model ownership are independently accounted", async () => {
  const f = fixture(), c = new Controller(f.pi);
  c.set(true, f.ctx); c.schedule(f.ctx);
  c.set(false, f.ctx); c.set(true, f.ctx);
  f.setModel("new-model"); f.response("late"); await tick();
  const old = f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data;
  assert.equal(old.outcome, "cancelled"); assert.equal(old.model, "m"); assert.deepEqual(old.usage, usage);
  assert.equal(await c.offer(f.ctx, prep, new AbortController().signal), undefined);
  c.leave(f.ctx);
  const g = fixture(), next = new Controller(g.pi);
  next.set(true, g.ctx); next.schedule(g.ctx);
  next.leave(g.ctx); const before = g.entries.filter(e => e.kind === "async-compact-usage");
  assert.equal(before[0].data.usage, null, "unknown persisted before leaving");
  g.sm.newSession(); g.response("old-result"); await tick();
  assert.equal(g.entries.filter(e => e.kind === "async-compact-usage").length, 1);
  assert.equal(g.entries.filter(e => e.kind === "async-compact-usage")[0].session, before[0].session);
  const h = fixture(), failed = new Controller(h.pi);
  failed.set(true, h.ctx); failed.schedule(h.ctx); h.response(""); await tick();
  assert.equal(h.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.outcome, "failed");
});

test("generation timeout keeps physical slot until settlement; late result cannot revive it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(), c = new Controller(f.pi);
  c.set(true, f.ctx); c.schedule(f.ctx);
  t.mock.timers.tick(120_001);
  assert.equal(await c.offer(f.ctx, prep, new AbortController().signal), undefined);
  c.schedule(f.ctx);
  assert.equal(f.entries.filter(e => e.kind === "async-compact-progress").length, 2, "no second background request while old physical slot remains open");
  f.response("too late"); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.outcome, "cancelled");
  assert.equal(await c.offer(f.ctx, prep, new AbortController().signal), undefined);
});
test("native preflight fallback retains a pending physical slot and records late known usage once", async () => {
  const f = fixture(), c = new Controller(f.pi);
  let calls = 0;
  const stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (...args: unknown[]) => { calls++; return stream(...args); };
  c.set(true, f.ctx); c.schedule(f.ctx);
  assert.equal(calls, 1);
  // Native threshold actually commits while the summary request is still pending.
  f.sm.appendCompaction("native", f.sm.getBranch().find(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("user-2"))!.id, prep.tokensBefore, {}, false);
  c.compact(f.ctx, f.sm.getBranch().at(-1)! as any);
  c.schedule(f.ctx);
  assert.equal(calls, 1, "old physical request still owns the slot");
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").length, 0, "no premature unknown entry");
  f.setModel("changed"); f.response("late", usage); await tick();
  const records = f.entries.filter(e => e.kind === "async-compact-usage");
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].data.usage, usage);
  assert.equal(records[0].data.model, "m"); assert.equal(records[0].data.provider, "fake");
  assert.equal(records[0].data.outcome, "cancelled");
  c.compact(f.ctx, f.sm.getBranch().at(-1)! as any);
  assert.equal(records.length, f.entries.filter(e => e.kind === "async-compact-usage").length);
});
test("settled error survives an unrelated native commit; unknown compressed baseline needs cooldown and new growth", async t => {
  let now = 1_000_000, tokens: number | null = 45_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const sm = SessionManager.inMemory("/tmp/async-compact-native-error");
  const append = (role: "user" | "assistant", text: string) => sm.appendMessage(role === "user" ?
    { role, content: [{ type: "text", text }], timestamp: now } :
    { role, content: [{ type: "text", text }], api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage, timestamp: now });
  append("user", "u".repeat(80_000)); append("assistant", "a".repeat(80));
  const kept = append("user", "v".repeat(80_000)); append("assistant", "b".repeat(80));
  let settle!: (result: unknown) => void;
  const records: any[] = [];
  const pi = { getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 20_000 } }),
    getAllTools: () => [], getActiveTools: () => [], registerEntryRenderer() {}, appendEntry: (kind: string, data: unknown) => { if (kind === "async-compact-usage") records.push(data); } } as any;
  const ctx = { sessionManager: sm, mode: "tui", model: { ...model(), contextWindow: 64_000 }, thinkingLevel: "off", getSystemPrompt: () => "system",
    getContextUsage: () => ({ tokens, contextWindow: 64_000 }), hasPendingMessages: () => false, ui: { notify() {} },
    modelRegistry: { streamSimple: () => { calls++; return { result: () => new Promise(resolve => settle = resolve) }; } } } as any;
  const c = new Controller(pi); c.set(true, ctx); c.schedule(ctx); assert.equal(calls, 1);
  append("user", "w".repeat(36_000)); append("assistant", "c".repeat(80));
  now += 61_000; tokens = 54_000;
  settle({ role: "assistant", content: [], stopReason: "error", usage }); await tick();
  assert.equal(records.length, 1); assert.equal(records[0].outcome, "failed");
  tokens = null;
  sm.appendCompaction("native", kept, 54_000, {}, false);
  const native = sm.getBranch().at(-1)!;
  c.compact(ctx, native as any); c.compact(ctx, native as any);
  append("user", "x".repeat(45_000)); append("assistant", "d".repeat(80));
  tokens = 42_000; c.schedule(ctx); assert.equal(calls, 1, "native commit cannot erase the failure clock");
  now += 59_999; c.schedule(ctx); assert.equal(calls, 1);
  now++; c.schedule(ctx); assert.equal(calls, 1, "unknown post-native usage first establishes a new baseline");
  tokens = 49_999; c.schedule(ctx); assert.equal(calls, 1);
  tokens = 50_000;
  assert.ok(plan(pi, ctx, 1), "post-native history has a useful complete user cut");
  c.schedule(ctx); assert.equal(calls, 2, "fresh 8000 tokens and 60 seconds allow the next generation");
  c.set(false, ctx); settle({ role: "assistant", content: [], stopReason: "aborted", usage }); await tick();
  assert.equal(records.length, 2, "physical attempts are each accounted once");
});

test("successful native adoption starts a fresh generation immediately; duplicate event cannot cancel its next physical request", async () => {
  const f = fixture(), c = new Controller(f.pi);
  let calls = 0, nextSignal: AbortSignal | undefined;
  const stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (...args: unknown[]) => { calls++; nextSignal = (args[2] as { signal: AbortSignal }).signal; return stream(...args); };
  c.set(true, f.ctx); c.schedule(f.ctx); f.response(); await tick();
  const offered = await c.offer(f.ctx, prep, new AbortController().signal); assert.ok(offered);
  f.sm.appendCompaction(offered.summary, offered.firstKeptEntryId, offered.tokensBefore, offered.details, true, offered.usage);
  const entry = f.sm.getBranch().at(-1)!;
  c.compact(f.ctx, entry as any);
  f.append("user", 3); f.append("assistant", 3); f.append("user", 4); f.append("assistant", 4);
  c.schedule(f.ctx); assert.equal(calls, 2, "adoption does not impose failure cooldown");
  c.compact(f.ctx, entry as any);
  assert.equal(nextSignal?.aborted, false, "duplicate native event cannot invalidate the next generation");
  c.set(false, f.ctx); f.response("late"); await tick();
});

test("native fallback fences retries from late settlement and compressed-context growth", async t => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const f = fixture(), c = new Controller(f.pi);
  let tokens = 30_000, calls = 0;
  f.ctx.model.contextWindow = 32_000;
  f.ctx.getContextUsage = () => ({ tokens, contextWindow: 32_000 });
  const stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (...args: unknown[]) => { calls++; return stream(...args); };
  c.set(true, f.ctx); c.schedule(f.ctx);
  assert.equal(calls, 1);
  f.sm.appendCompaction("native", f.sm.getBranch().find(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("user-2"))!.id, 30_000, {}, false);
  c.compact(f.ctx, f.sm.getBranch().at(-1)! as any);
  tokens = 14_000;
  f.append("user", 3); f.append("assistant", 3); f.append("user", 4); f.append("assistant", 4);
  now += 300_000; tokens = 22_000; c.schedule(f.ctx);
  assert.equal(calls, 1, "pending physical request blocks new calls even after elapsed time and growth");
  f.response("late", usage); await tick();
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").length, 1);
  now += 59_999; c.schedule(f.ctx);
  assert.equal(calls, 1, "growth alone cannot bypass settlement cooldown");
  now++; tokens = 29_999; c.schedule(f.ctx);
  assert.equal(calls, 1, "elapsed time alone cannot bypass compressed-context growth fence");
  tokens = 30_000; c.schedule(f.ctx);
  assert.equal(calls, 2, "both gates allow a new generation despite the old high-water mark");
  f.response(); await tick(); c.set(false, f.ctx);
});

test("ordinary error, timeout and unknown settlement baseline require time AND fresh growth", async t => {
  for (const failure of ["error", "unknown"] as const) {
    let now = 1_000_000, tokens: number | null = 45_000, calls = 0;
    t.mock.method(Date, "now", () => now);
    const f = fixture(), c = new Controller(f.pi);
    f.ctx.model.contextWindow = 64_000;
    f.ctx.getContextUsage = () => ({ tokens, contextWindow: 64_000 });
    const stream = f.ctx.modelRegistry.streamSimple;
    f.ctx.modelRegistry.streamSimple = (...args: unknown[]) => { calls++; return stream(...args); };
    c.set(true, f.ctx); c.schedule(f.ctx); assert.equal(calls, 1);
    now += 61_000;
    tokens = failure === "unknown" ? null : 54_000;
    f.response("", usage, "error"); await tick();
    tokens = 54_000; c.schedule(f.ctx); assert.equal(calls, 1, `${failure}: settlement cannot retry immediately`);
    now += 59_999; c.schedule(f.ctx); assert.equal(calls, 1);
    now++; c.schedule(f.ctx); assert.equal(calls, 1, `${failure}: old growth cannot count after settlement`);
    tokens = 62_000; c.schedule(f.ctx);
    assert.equal(calls, 2, `${failure}: only growth after the settlement baseline permits retry`);
    c.set(false, f.ctx); f.response(); await tick();
    t.mock.restoreAll();
  }
});

test("failed native submission of an offered summary fences retries from failure time", async t => {
  let now = 1_000_000, tokens = 45_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const f = fixture(), c = new Controller(f.pi);
  f.ctx.model.contextWindow = 64_000;
  f.ctx.getContextUsage = () => ({ tokens, contextWindow: 64_000 });
  const stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (...args: unknown[]) => { calls++; return stream(...args); };
  c.set(true, f.ctx); c.schedule(f.ctx); f.response(); await tick();
  assert.ok(await c.offer(f.ctx, prep, new AbortController().signal));
  now += 61_000; tokens = 54_000; c.failed(f.ctx);
  c.schedule(f.ctx); assert.equal(calls, 1);
  now += 60_000; c.schedule(f.ctx); assert.equal(calls, 1);
  tokens = 62_000; c.schedule(f.ctx); assert.equal(calls, 2);
  c.set(false, f.ctx); f.response(); await tick();
});

test("cleared offering failure and settled cancellation keep their fence across native compaction", async t => {
  for (const outcome of ["offered-failed", "cancelled"] as const) {
    let now = 1_000_000, tokens: number | null = 45_000, calls = 0;
    t.mock.method(Date, "now", () => now);
    const f = fixture(), c = new Controller(f.pi);
    f.ctx.model.contextWindow = 64_000;
    f.ctx.getContextUsage = () => ({ tokens, contextWindow: 64_000 });
    const stream = f.ctx.modelRegistry.streamSimple;
    f.ctx.modelRegistry.streamSimple = (...args: unknown[]) => { calls++; return stream(...args); };
    c.set(true, f.ctx); c.schedule(f.ctx); f.response(); await tick();
    if (outcome === "offered-failed") {
      assert.ok(await c.offer(f.ctx, prep, new AbortController().signal));
      now += 61_000; c.failed(f.ctx); // clears the settled offered attempt
    } else { now += 61_000; c.stop(f.ctx); }
    tokens = null;
    const kept = f.sm.getBranch().find(e => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes("user-2"))!;
    f.sm.appendCompaction("native", kept.id, 45_000, {}, false);
    c.compact(f.ctx, f.sm.getBranch().at(-1)! as any);
    f.append("user", 3); f.append("assistant", 3); f.append("user", 4); f.append("assistant", 4);
    tokens = 45_000; c.schedule(f.ctx); assert.equal(calls, 1, `${outcome}: no immediate retry`);
    now += 60_000; c.schedule(f.ctx); assert.equal(calls, 1);
    tokens = 53_000; c.schedule(f.ctx); assert.equal(calls, 2, `${outcome}: only post-native growth allows retry`);
    c.set(false, f.ctx); f.response(); await tick();
    t.mock.restoreAll();
  }
});

test("physical timeout settlement begins a new cooldown, not the original request deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000_000, tokens = 45_000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const f = fixture(), c = new Controller(f.pi);
  f.ctx.model.contextWindow = 64_000;
  f.ctx.getContextUsage = () => ({ tokens, contextWindow: 64_000 });
  const stream = f.ctx.modelRegistry.streamSimple;
  f.ctx.modelRegistry.streamSimple = (...args: unknown[]) => { calls++; return stream(...args); };
  c.set(true, f.ctx); c.schedule(f.ctx);
  now += 120_001; t.mock.timers.tick(120_001);
  tokens = 54_000; f.response("late", usage);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  c.schedule(f.ctx); assert.equal(calls, 1);
  now += 60_000; c.schedule(f.ctx); assert.equal(calls, 1, "growth before settlement is not fresh growth");
  tokens = 62_000; c.schedule(f.ctx); assert.equal(calls, 2);
  c.set(false, f.ctx); f.response();
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

test("SDK zero error/abort and missing metering remain unknown; positive error is partial, complete late and adopted usage are reported", async () => {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const reason of ["error", "aborted", "stop"] as const) {
    const f = fixture(), c = new Controller(f.pi); c.set(true, f.ctx); c.schedule(f.ctx);
    f.response(reason === "stop" ? "valid summary" : "", zero, reason); await tick();
    if (reason === "stop") { assert.ok(await c.offer(f.ctx, prep, new AbortController().signal)); c.failed(f.ctx); }
    const data = f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data;
    assert.equal(data?.metering, "unknown");
    assert.equal(data?.usage, null);
  }
  for (const reason of ["error", "aborted", "length", "toolUse"] as const) {
    const f = fixture(), c = new Controller(f.pi); c.set(true, f.ctx); c.schedule(f.ctx);
    f.response("", usage, reason); await tick();
    const data = f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data;
    assert.equal(data.metering, reason === "error" || reason === "aborted" ? "partial" : "reported");
    assert.deepEqual(data.usage, usage);
    assert.equal(JSON.stringify(data).includes("private provider body"), false);
    assert.equal(JSON.stringify(data).includes("secret"), false);
  }
  const f = fixture(), c = new Controller(f.pi); c.set(true, f.ctx); c.schedule(f.ctx);
  c.set(false, f.ctx); f.response("late", usage); await tick();
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.metering, "reported", "terminal success, not local Off, determines metering completeness");
  const g = fixture(), adopted = new Controller(g.pi); adopted.set(true, g.ctx); adopted.schedule(g.ctx); g.response(); await tick();
  const offered = await adopted.offer(g.ctx, prep, new AbortController().signal); assert.ok(offered);
  g.sm.appendCompaction(offered.summary, offered.firstKeptEntryId, offered.tokensBefore, offered.details, true, offered.usage);
  adopted.compact(g.ctx, g.sm.getBranch().at(-1)! as any);
  const data = g.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data;
  assert.equal(data.metering, "reported"); assert.deepEqual(data.usage, usage);
  assert.equal(data.includedInNativeTotals, true);
  assert.deepEqual(g.sm.getBranch().filter(e => e.type === "compaction").at(-1)?.usage, usage);
});

test("pending or changed input and native override/failure cannot adopt an offered candidate", async () => {
  const f = fixture(), c = new Controller(f.pi);
  c.set(true, f.ctx); c.schedule(f.ctx); f.response(); await tick();
  f.setPending(true);
  assert.equal(await c.offer(f.ctx, prep, new AbortController().signal), undefined);
  f.setPending(false);
  const offered = await c.offer(f.ctx, prep, new AbortController().signal); assert.ok(offered);
  f.sm.appendCompaction("other handler summary", offered.firstKeptEntryId, offered.tokensBefore, {}, true);
  c.compact(f.ctx, f.sm.getBranch().filter(e => e.type === "compaction").at(-1)!);
  assert.equal(f.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.outcome, "discarded");
  const g = fixture(), next = new Controller(g.pi);
  next.set(true, g.ctx); next.schedule(g.ctx); g.response(); await tick();
  assert.ok(await next.offer(g.ctx, prep, new AbortController().signal));
  next.failed(g.ctx);
  assert.equal(g.entries.filter(e => e.kind === "async-compact-usage").at(-1)?.data.outcome, "discarded");
});
test("simulation refuses image or huge incremental content; known text budget simulates a candidate", () => {
  const f = fixture(), snap = plan(f.pi, f.ctx, 0)!;
  assert.equal(fits(f.pi, f.ctx, snap, "summary", 2900), true);
  f.sm.appendMessage({ role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: Date.now() });
  assert.equal(fits(f.pi, f.ctx, snap, "summary", 2900), false, "image size cannot be established from text heuristic");
  f.append("user", 3); f.append("assistant", 3);
  const recent = f.sm.getBranch().filter(e => e.type === "message").at(-1)!;
  f.sm.appendContextEdit(recent.id, { content: [{ type: "text", text: "x".repeat(20000) }] });
  assert.equal(fits(f.pi, f.ctx, snap, "summary", 2900), false);
});
