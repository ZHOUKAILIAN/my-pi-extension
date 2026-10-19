import { test, after } from "node:test";
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from "node:assert/strict";
import { Timing } from "../src/timing.ts";
import { Controller } from "../src/controller.ts";
import extension from "../src/index.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js");
const usage = { input: 18, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 27, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const response = (stopReason = "stop", text = "summary") => ({ role: "assistant", stopReason, content: text ? [{ type: "text", text }] : [], usage, errorMessage: "private provider body", headers: { authorization: "secret" } });
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const preferenceDirs: string[] = [];
after(() => { for (const path of preferenceDirs) rmSync(path, { recursive: true, force: true }); });
function timingFixture() {
  let mono = 10, utc = 1_000; const records: any[] = [], renderers = new Map<string, Function>();
  const pi = { registerEntryRenderer: (n: string, r: Function) => renderers.set(n, r), appendEntry: (type: string, data: unknown) => records.push({ type, data }) } as any;
  return { timing: new Timing(pi, { monotonic: () => mono, utc: () => utc }), records, renderers, advance: (m: number, u = 0) => { mono += m; utc += u; } };
}
function controllerFixture(options: { failAppend?: (type: string, data: any) => boolean; failNotify?: boolean } = {}) {
  const sm = SessionManager.inMemory("/tmp/async-compact-timing-controller");
  for (let n = 0; n < 2; n++) {
    sm.appendMessage({ role: "user", content: [{ type: "text", text: `user ${n} ${"word ".repeat(160)}` }], timestamp: Date.now() });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "response " + "answer ".repeat(40) }], api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage, timestamp: Date.now() });
  }
  let mono = 100, lastClockRead = Number.NaN, callStart = Number.NaN, resolve!: (r: unknown) => void, reject!: (e: unknown) => void, calls = 0;
  const entries: any[] = [], attempts: any[] = [], notices: string[] = [];
  const pi = { getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }), getAllTools: () => [], getActiveTools: () => [], registerEntryRenderer() {}, appendEntry: (type: string, data: any) => { mono += 10; attempts.push({ type, data }); if (options.failAppend?.(type, data)) throw Error("private append"); entries.push({ type, data }); } } as any;
  const ctx = { sessionManager: sm, mode: "tui", model: { provider: "fake", id: "m", api: "fake-api", contextWindow: 4096 }, thinkingLevel: "off", getSystemPrompt: () => "system", hasPendingMessages: () => false, getContextUsage: () => { mono += 5; return { tokens: 2900, contextWindow: 4096 }; }, ui: { notify: (m: string) => { notices.push(m); if (options.failNotify) throw Error("private notification"); } }, modelRegistry: { streamSimple: () => { calls++; callStart = mono; return { result: () => new Promise((r, j) => { resolve = r; reject = j; }) }; } } } as any;
  const c = new Controller(pi, { monotonic: () => { lastClockRead = mono; return mono; }, utc: () => 1000 });
  return { c, sm, ctx, entries, attempts, notices, resolve: (r: unknown) => resolve(r), reject: (e: unknown) => reject(e), setMono: (n: number) => mono = n, callStart: () => callStart, lastClockRead: () => lastClockRead, calls: () => calls };
}
const prep = { tokensBefore: 2900, firstKeptEntryId: "unused", isSplitTurn: false, settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } };

test("controlled background stamps bracket streamSimple and resolve classification, not preparation or later adoption", async () => {
  const f = controllerFixture(); f.c.set(true, f.ctx); f.c.schedule(f.ctx);
  assert.equal(f.lastClockRead(), f.callStart(), "start stamp is the final operation immediately before streamSimple");
  f.setMono(f.callStart() + 775); const result = response();
  Object.defineProperty(result, "stopReason", { get() { f.setMono(f.callStart() + 875); return "stop"; } });
  f.resolve(result); await tick();
  let sample = f.entries.find(e => e.type === "async-compact-timing")?.data;
  assert.equal(sample.durationMs, 775); assert.equal(sample.outcome, "completed");
  f.setMono(90_000); assert.ok(await f.c.offer(f.ctx, prep, new AbortController().signal));
  sample = f.entries.find(e => e.type === "async-compact-timing")?.data; assert.equal(sample.durationMs, 775, "ready wait and adoption are outside the interval");
});

test("raw result rejection captures end before an already queued microtask", async () => {
  const f = controllerFixture(); f.c.set(true, f.ctx); f.c.schedule(f.ctx); f.setMono(f.callStart() + 25);
  f.reject(Error("private reject")); queueMicrotask(() => f.setMono(f.callStart() + 925)); await tick();
  const sample = f.entries.find(e => e.type === "async-compact-timing")?.data;
  assert.equal(sample.outcome, "failed"); assert.equal(sample.durationMs, 25);
  assert.doesNotMatch(JSON.stringify(f.entries), /private reject|authorization/);
});

test("wall-clock jumps do not change monotonic duration; invalid clocks and unknown causes persist null", () => {
  const f = timingFixture(), x = f.timing.begin("background_generation", "m", "p"); f.advance(1250, -90_000); x.finish("completed"); x.finish("failed");
  assert.equal(f.records[0].data.durationMs, 1250); assert.equal(f.records[0].data.startedAtUTC, new Date(1000).toISOString()); assert.equal(f.records.length, 1);
  let reads = 0; const records: any[] = [];
  const broken = new Timing({ registerEntryRenderer() {}, appendEntry: (_k: string, d: unknown) => records.push(d) } as any, { monotonic: () => { if (++reads === 1) throw Error(); return 44; }, utc: () => { throw Error(); } });
  broken.begin("foreground_compaction", null, null).finish("completed");
  assert.equal(records[0].startedAtUTC, null); assert.equal(records[0].durationMs, null); assert.equal(records[0].outcome, "unknown"); assert.doesNotMatch(JSON.stringify(records[0]), /1970/);
  const t = new Timing({ registerEntryRenderer() {}, appendEntry: (_k: string, d: unknown) => records.push(d) } as any, { monotonic: () => 5, utc: () => 1 });
  t.begin("background_generation", null, null).finish("completed", "scope_left");
  assert.equal(records[1].durationMs, null); assert.equal(records[1].outcome, "unknown"); assert.equal(records[1].unknownReason, "scope_left");
});

test("renderer validates full persisted schema, known values, unknown and malformed history", () => {
  const f = timingFixture(), renderer: any = f.renderers.get("async-compact-timing");
  const render = (data: unknown, theme = { fg: (_c: string, s: string) => s }) => renderer({ data }, {}, theme).render(120).join("");
  const base = { schemaVersion: 1, sampleId: "sample", startedAtUTC: new Date(1000).toISOString(), model: "m", provider: "p" };
  assert.match(render({ ...base, kind: "background_generation", durationMs: 1234, outcome: "completed" }), /后台生成耗时: 1\.234s \(completed\)/);
  assert.match(render({ ...base, kind: "foreground_compaction", durationMs: 2500, outcome: "failed" }), /前台压缩阶段耗时: 2\.500s \(failed\)/);
  assert.match(render({ ...base, kind: "foreground_compaction", startedAtUTC: null, durationMs: null, outcome: "unknown" }), /前台压缩阶段耗时: 未知 \(unknown\)/);
  assert.match(render({ ...base, kind: "foreground_compaction", durationMs: -500, outcome: "completed" }), /前台压缩阶段耗时: 未知 \(unknown\)/);
  assert.match(render({ kind: "forged", durationMs: 500, outcome: "completed" }), /async-compact 耗时: 未知 \(unknown\)/);
  assert.doesNotThrow(() => render({ ...base, kind: "background_generation", durationMs: 300, outcome: "completed" }, { fg: () => { throw Error("theme private"); } }));
});

test("timing submits one terminal DTO independently of local append; stale scope and UUID failure never invent a remote ID",async()=>{const submitted:any[]=[],entries:any[]=[];let remoteIdCalls=0;const pi={registerEntryRenderer(){},appendEntry:(type:string,data:any)=>{entries.push({type,data});if(type==='async-compact-timing')throw Error('local append failed');}} as any;const t=new Timing(pi,{monotonic:()=>10,utc:()=>1000},{idFactory:()=>{remoteIdCalls++;return '4a19dc3b-8397-4d74-834f-a19ec67e891c';},submitMetric:async e=>{submitted.push(e);}});const sample=t.begin('background_generation','m','p');assert.equal(remoteIdCalls,0,'remote ID is not allocated before the terminal hook');sample.finish('completed');assert.equal(remoteIdCalls,1);sample.finish('failed');await tick();assert.equal(submitted.length,1);assert.notEqual(submitted[0].eventId,sample.sampleId,'remote ID is separately generated at the terminal boundary');assert.deepEqual(submitted[0],{schemaVersion:1,eventId:'4a19dc3b-8397-4d74-834f-a19ec67e891c',kind:'background_generation',occurredAt:new Date(1000).toISOString(),durationMs:0,outcome:'completed',model:'m',provider:'p',agentType:'unknown',dataset:'live'});const old=t.begin('foreground_compaction',null,null);t.invalidate();old.finish('unknown','scope_left');assert.equal(submitted.length,1);const noId=new Timing(pi,{monotonic:()=>10,utc:()=>1000},{idFactory:()=>{throw Error('uuid failure');},submitMetric:async e=>{submitted.push(e);}});noId.begin('background_generation',null,null).finish('completed');await tick();assert.equal(submitted.length,1);assert.match(entries.at(-1).data.sampleId,/^[0-9a-f-]{36}$/u,'local diagnostic ID remains distinct from the missing remote ID');});

test('Async metric submit is not awaited by the terminal hook; sync throw and unresolved promise leave diagnostics intact', async () => {
  for (const submitMetric of [() => { throw new Error('sync metric failure'); }, () => new Promise<void>(() => {})]) {
    const entries: unknown[] = [];
    const timing = new Timing({ registerEntryRenderer() {}, appendEntry: (_type: string, data: unknown) => entries.push(data) } as any,
      { monotonic: () => 10, utc: () => 1000 }, { submitMetric: submitMetric as any });
    const begin = timing.begin('background_generation', 'm', 'p');
    assert.doesNotThrow(() => begin.finish('completed'));
    assert.equal(entries.length, 1);
    assert.deepEqual((entries[0] as { outcome: string }).outcome, 'completed');
    timing.closeMetricScope();
  }
});

test("timing UUID, clock and append failures are isolated", () => {
  const renderers = new Map<string, Function>(); let calls = 0;
  const t = new Timing({ registerEntryRenderer: (n: string, r: Function) => renderers.set(n, r), appendEntry: () => { throw Error("private append"); } } as any, { monotonic: () => { if (++calls === 1) throw Error(); return 5; }, utc: () => 1 });
  assert.doesNotThrow(() => t.begin("background_generation", null, null).finish("completed"));
  const renderer: any = renderers.get("async-compact-timing"); assert.doesNotThrow(() => renderer({ data: null }, {}, { fg: () => { throw Error(); } }));
});

test("physical response outcomes, Off-late-stop, reject and duplicates are classified once", async () => {
  for (const [reason, text, outcome] of [["stop", "summary", "completed"], ["aborted", "", "cancelled"], ["error", "", "failed"], ["stop", "", "failed"]] as const) {
    const f = controllerFixture(); f.c.set(true, f.ctx); f.c.schedule(f.ctx); f.resolve(response(reason, text)); await tick();
    assert.equal(f.entries.find(e => e.type === "async-compact-timing")?.data.outcome, outcome); assert.equal(f.entries.filter(e => e.type === "async-compact-timing").length, 1);
    if (reason === "stop" && text) assert.equal(f.entries.filter(e => e.type === "async-compact-failure").length, 0, "valid successful response has no failure diagnostic");
  }
  const f = controllerFixture(); f.c.set(true, f.ctx); f.c.schedule(f.ctx); f.c.set(false, f.ctx); f.resolve(response()); await tick();
  assert.equal(f.entries.find(e => e.type === "async-compact-timing")?.data.outcome, "completed");
  assert.equal(f.entries.filter(e => e.type === "async-compact-failure").length, 0, "Off followed by a late physical success does not create a failure diagnostic");
});

test("failure diagnostics classify bounded response shape and never persist injected provider secrets", async () => {
  for (const [responseValue, expected] of [
    [response("length", "cut"), ["non_stop", "length"]],
    [response("toolUse", ""), ["non_stop", "toolUse"]],
    [response("error", ""), ["non_stop", "error"]],
    [response("aborted", ""), ["non_stop", "aborted"]],
    [response("future-stop-reason", ""), ["non_stop", "other"]],
    [response("stop", ""), ["empty_text", "stop"]],
  ] as const) {
    const f = controllerFixture(); f.c.set(true, f.ctx); f.c.schedule(f.ctx); f.resolve(responseValue); await tick();
    const diagnostic = f.entries.find(e => e.type === "async-compact-failure")?.data;
    assert.ok(diagnostic, `missing failure diagnostic for ${JSON.stringify(expected)}; entries=${JSON.stringify(f.entries)}`);
    assert.deepEqual([diagnostic.reason, diagnostic.stopReason], expected);
    assert.equal(diagnostic.schemaVersion, 1); assert.equal(typeof diagnostic.attemptId, "string");
    assert.doesNotMatch(JSON.stringify(f.entries), /private provider body|authorization|secret|summary|headers|errorMessage/);
  }
  const f = controllerFixture(); f.c.set(true, f.ctx); f.c.schedule(f.ctx);
  f.resolve({ stopReason: "stop", content: [{ type: "thinking", thinking: "private thought" }], usage }); await tick();
  assert.equal(f.entries.find(e => e.type === "async-compact-failure")?.data.reason, "thinking_only");
  const malformedText = controllerFixture(); malformedText.c.set(true, malformedText.ctx); malformedText.c.schedule(malformedText.ctx);
  malformedText.resolve({ stopReason: "stop", content: [{ type: "text", text: 123 }, { type: "text", text: "ok" }], usage }); await tick();
  assert.equal(malformedText.entries.find(e => e.type === "async-compact-failure")?.data.reason, "malformed_response");
  assert.equal(await malformedText.c.offer(malformedText.ctx, prep, new AbortController().signal), undefined, "non-string text cannot become a summary or be offered");
  const unexpectedOnly = controllerFixture(); unexpectedOnly.c.set(true, unexpectedOnly.ctx); unexpectedOnly.c.schedule(unexpectedOnly.ctx);
  unexpectedOnly.resolve({ stopReason: "stop", content: [{ type: "vendor-block", raw: "private" }], usage }); await tick();
  assert.equal(unexpectedOnly.entries.find(e => e.type === "async-compact-failure")?.data.reason, "unexpected_content");
  const g = controllerFixture(); g.c.set(true, g.ctx); g.c.schedule(g.ctx);
  g.resolve({ stopReason: "stop", content: [{ type: "text", text: "secret text" }, { type: "toolCall", name: "private tool name", arguments: { secret: true } }, { type: "new-provider-block", raw: "secret" }], usage }); await tick();
  const d = g.entries.find(e => e.type === "async-compact-failure")?.data;
  assert.equal(d.reason, "unexpected_content"); assert.deepEqual(d.content.types, { text: 1, toolCall: 1, unknown: 1 }); assert.equal(d.content.textLength, 11);
  assert.doesNotMatch(JSON.stringify(g.entries), /secret text|private tool name|new-provider-block|secret/);
  const bounded = controllerFixture(); bounded.c.set(true, bounded.ctx); bounded.c.schedule(bounded.ctx);
  bounded.resolve({ stopReason: "stop", content: [...Array.from({ length: 300 }, () => ({ type: "text", text: "ignored" })), { type: "untrusted-block" }], usage }); await tick();
  const boundedDiagnostic = bounded.entries.find(e => e.type === "async-compact-failure")?.data;
  assert.equal(boundedDiagnostic.content.count, null); assert.equal(boundedDiagnostic.content.truncated, true); assert.equal(boundedDiagnostic.content.textLength, null);
});

test("sync throws, promise rejection and malformed response processing have distinct safe diagnostics", async () => {
  for (const [stage, reason] of [["stream_simple", "sync_throw"], ["result", "sync_throw"], ["result_value", "sync_throw"]] as const) {
    const f = controllerFixture(); f.c.set(true, f.ctx);
    f.ctx.modelRegistry.streamSimple = () => { if (stage === "stream_simple") throw Object.assign(Error("secret body"), { code: "ECONNRESET", status: 503 }); return { result: () => { if (stage === "result") throw Error("secret stack"); if (stage === "result_value") return { not: "a promise" }; throw Error("unexpected"); } }; };
    f.c.schedule(f.ctx);
    const d = f.entries.find(e => e.type === "async-compact-failure")?.data;
    assert.equal(d.stage, stage === "result_value" ? "result" : stage); assert.equal(d.reason, reason);
    if (stage === "stream_simple") { assert.equal(d.errorCategory, "ECONNRESET"); assert.equal(d.httpStatus, 503); }
    assert.doesNotMatch(JSON.stringify(f.entries), /secret body|secret stack/);
  }
  const rejected = controllerFixture(); rejected.c.set(true, rejected.ctx); rejected.c.schedule(rejected.ctx); rejected.reject(Object.assign(Error("secret rejection"), { code: "UNKNOWN_PRIVATE_CODE", status: 700 })); await tick();
  const rejectedDiagnostic = rejected.entries.find(e => e.type === "async-compact-failure")?.data;
  assert.equal(rejectedDiagnostic.stage, "result"); assert.equal(rejectedDiagnostic.reason, "promise_rejected"); assert.equal(rejectedDiagnostic.errorCategory, "unknown"); assert.equal(rejectedDiagnostic.httpStatus, null);
  const malformed = controllerFixture(); malformed.c.set(true, malformed.ctx); malformed.c.schedule(malformed.ctx);
  malformed.resolve({ get stopReason() { throw Error("secret getter"); }, content: [] }); await tick();
  const malformedDiagnostic = malformed.entries.find(e => e.type === "async-compact-failure")?.data;
  assert.equal(malformedDiagnostic.stage, "response_processing"); assert.equal(malformedDiagnostic.reason, "processing_error");
  assert.doesNotMatch(JSON.stringify(malformed.entries), /secret rejection|secret getter|UNKNOWN_PRIVATE_CODE/);
  const appendFailure = controllerFixture({ failAppend: type => type === "async-compact-failure" });
  appendFailure.c.set(true, appendFailure.ctx); appendFailure.c.schedule(appendFailure.ctx);
  appendFailure.resolve(response("length", "truncated")); await tick();
  assert.ok(appendFailure.attempts.some(e => e.type === "async-compact-failure"), "diagnostic append failure was injected");
  assert.equal(appendFailure.entries.find(e => e.type === "async-compact-usage")?.data.outcome, "failed", "usage accounting continues when the separate diagnostic cannot persist");
  assert.doesNotThrow(() => appendFailure.c.schedule(appendFailure.ctx), "diagnostic write failure does not throw into scheduling/cooldown callers");

  const revoked = controllerFixture(); revoked.c.set(true, revoked.ctx); revoked.c.schedule(revoked.ctx);
  const revocable = Proxy.revocable([], {}); revocable.revoke();
  revoked.resolve({ stopReason: "stop", content: revocable.proxy, usage }); await tick();
  assert.ok(revoked.entries.some(e => e.type === "async-compact-failure" && e.data.content === null && e.data.stopReason === "unknown" && e.data.reason === "processing_error"), "revoked Proxy falls back to a minimal unknown diagnostic");
  assert.ok(revoked.entries.some(e => e.type === "async-compact-usage"), "diagnostic extraction failure cannot block attempt finalization");

  const postProcess = controllerFixture(); postProcess.c.set(true, postProcess.ctx); postProcess.c.schedule(postProcess.ctx);
  let textReads = 0;
  const changingBlock = { type: "text", get text() { if (++textReads <= 4) return "valid text"; throw Error("private processing failure"); } };
  postProcess.resolve({ stopReason: "stop", content: [changingBlock], usage }); await tick();
  assert.equal(postProcess.entries.find(e => e.type === "async-compact-timing")?.data.outcome, "completed", "physical successful response timing remains settled when later local processing throws");
  assert.equal(postProcess.entries.find(e => e.type === "async-compact-failure")?.data.reason, "processing_error");
  assert.equal(postProcess.entries.find(e => e.type === "async-compact-usage")?.data.outcome, "failed", "attempt finalization records failed local processing separately from physical generation");
  assert.doesNotMatch(JSON.stringify(postProcess.entries), /private processing failure/);
});

test("leave records unknown in old scope and late response never appends into new session", async () => {
  const f = controllerFixture(); f.c.set(true, f.ctx); f.c.schedule(f.ctx); f.c.leave(f.ctx);
  const first = f.entries.filter(e => e.type === "async-compact-timing"); assert.equal(first.length, 1); assert.equal(first[0].data.durationMs, null); assert.equal(first[0].data.unknownReason, "scope_left");
  f.sm.newSession(); f.c.set(true, f.ctx); f.c.schedule(f.ctx); f.resolve(response("error", "")); await tick();
  assert.equal(f.entries.filter(e => e.type === "async-compact-timing").length, 1);
  assert.equal(f.entries.filter(e => e.type === "async-compact-failure").length, 0, "late old-scope response cannot append failure diagnostics to replacement scope");
});

test("Reporting start/wait/fallback/finish/hide append and notice failures do not alter request or adoption", async () => {
  const start = controllerFixture({ failAppend: (type, data) => type === "async-compact-progress" && data.revision === 1 });
  start.c.set(true, start.ctx); assert.doesNotThrow(() => start.c.schedule(start.ctx)); assert.equal(start.calls(), 1, "failed generating row cannot prevent SDK request");
  start.resolve(response()); await tick(); assert.ok(await start.c.offer(start.ctx, prep, new AbortController().signal), "ready candidate remains offerable after progress append failure");

  const waiting = controllerFixture({ failAppend: (type, data) => type === "async-compact-progress" && data.revision === 2 });
  waiting.c.set(true, waiting.ctx); waiting.c.schedule(waiting.ctx);
  const offeredPromise = waiting.c.offer(waiting.ctx, prep, new AbortController().signal); waiting.resolve(response());
  assert.ok(await offeredPromise, "waiting-row failure does not skip candidate completion or force native fallback");

  const finish = controllerFixture({ failAppend: (type, data) => type === "async-compact-usage" || (type === "async-compact-progress" && data.revision === 0), failNotify: true });
  finish.c.set(true, finish.ctx); finish.c.schedule(finish.ctx); finish.resolve(response("error", "")); await tick();
  assert.equal(finish.calls(), 1); assert.equal(finish.entries.filter(e => e.type === "async-compact-timing").length, 1, "timing persists independently when old usage/hide rows fail");
  assert.equal(finish.entries.filter(e => e.type === "async-compact-usage").length, 0, "failed usage append is not represented as saved");
  assert.ok(finish.attempts.some(e => e.type === "async-compact-progress" && e.data.revision === 0), "hide refresh failure was exercised");
  assert.doesNotThrow(() => finish.c.set(false, finish.ctx));
});

test("sync stream/result observation failures keep physical slot after native submit and cooldown despite append/notify faults", () => {
  for (const failure of ["stream", "result"] as const) {
    const sm = SessionManager.inMemory("/tmp/async-compact-sync-failure");
    for (let n = 0; n < 2; n++) { sm.appendMessage({ role: "user", content: [{ type: "text", text: `user ${n} ${"word ".repeat(160)}` }], timestamp: Date.now() }); sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer ".repeat(40) }], api: "fake-api", provider: "fake", model: "m", stopReason: "stop", usage, timestamp: Date.now() }); }
    const entries: any[] = [], notices: string[] = []; let calls = 0, now = 1_000_000;
    const pi = { getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }), getAllTools: () => [], getActiveTools: () => [], registerEntryRenderer() {}, appendEntry: (type: string, data: any) => { if (type === "async-compact-usage" || (type === "async-compact-progress" && data?.revision === 0)) throw Error("private append"); entries.push({ type, data }); } } as any;
    const ctx = { sessionManager: sm, mode: "tui", model: { provider: "fake", id: "m", api: "fake-api", contextWindow: 4096 }, thinkingLevel: "off", getSystemPrompt: () => "system", hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 2900, contextWindow: 4096 }), ui: { notify: (m: string) => { notices.push(m); throw Error("private notify"); } }, modelRegistry: { streamSimple: () => { calls++; if (failure === "stream") throw Error("private stream"); return { result: () => { throw Error("private result"); } }; } } } as any;
    const c = new Controller(pi, { monotonic: () => now, utc: () => now }); c.set(true, ctx); c.schedule(ctx);
    const sample = entries.find(e => e.type === "async-compact-timing")?.data;
    assert.equal(sample.outcome, "unknown"); assert.equal(sample.unknownReason, "observation_failed"); assert.equal(sample.durationMs, null);
    assert.equal(notices.length, 1); assert.doesNotMatch(JSON.stringify(notices), /private/); assert.doesNotMatch(JSON.stringify(entries), /private stream|private result/);
    sm.appendCompaction("native", sm.getBranch().find(e => e.type === "message" && e.message.role === "user")!.id, 2900, {}, false); c.compact(ctx, sm.getBranch().at(-1)! as any);
    now += 500_000; c.schedule(ctx); assert.equal(calls, 1, "native commit and cooldown do not free an unobserved physical request");
    c.set(false, ctx); c.set(true, ctx); c.schedule(ctx); assert.equal(calls, 1);
  }
});

function hookHarness(options: { failAppend?: (type: string, data: any) => boolean; failNotify?: boolean; submitMetric?: (event: unknown) => Promise<void> } = {}) {
  let now = 100, bumpTerminalGuard = false; const clockReads: number[] = [], branch: any[] = [];
  const events = new Map<string, Function[]>(), entries: any[] = [], notices: string[] = [];
  let command!: (args: string, ctx: any) => Promise<void>, session = "same-session";
  const emit = (name: string, ...args: any[]) => {
    let result: any, chain: Promise<void> | undefined;
    for (const handler of events.get(name) ?? []) {
      if (chain) chain = chain.then(async () => { const value = await handler(...args); if (value !== undefined) result = value; });
      else {
        const value = handler(...args);
        if (value && typeof value.then === 'function') chain = Promise.resolve(value).then((resolved: unknown) => { if (resolved !== undefined) result = resolved; });
        else if (value !== undefined) result = value;
      }
    }
    return chain ? chain.then(() => result) : result;
  };
  const pi = { registerCommand: (_n: string, c: any) => command = c.handler, registerEntryRenderer() {}, appendEntry: (type: string, data: any) => { entries.push({ type, data }); if (type === "async-compact-timing") now += 700; if (options.failAppend?.(type, data)) throw Error("private hook append"); }, on: (n: string, cb: Function) => { const registered = events.get(n) ?? []; registered.push(cb); events.set(n, registered); }, getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }), getAllTools: () => [], getActiveTools: () => [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), 'async-duration-agent-')); preferenceDirs.push(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  extension(pi as never, { timingClock: { monotonic: () => { clockReads.push(now); return now; }, utc: () => 1000 }, submitMetric: options.submitMetric as any });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  const ctx: any = { mode: "tui", model: null, ui: { notify: (m: string) => { notices.push(m); if (options.failNotify) throw Error("private hook notify"); }, onTerminalInput: () => () => {} }, sessionManager: { getSessionId: () => { if (bumpTerminalGuard) { now += 900; bumpTerminalGuard = false; } return session; }, getBranch: () => { now += 37; return branch; } } };
  const before = (reason: string) => emit("session_before_compact", { reason, signal: new AbortController().signal, preparation: { fileOps: { read: new Set(), edited: new Set(), written: new Set() }, settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } } }, ctx);
  const terminal = (failed = false, aborted = false, reason = 'threshold') => { bumpTerminalGuard = true; const endAt = now; if (!failed) branch.push({ id: `compact-${branch.length}`, type: 'compaction' }); emit(failed ? "session_compact_failed" : "session_compact", failed ? { aborted, reason } : { compactionEntry: { id: 'stale-host-pointer' }, reason }, ctx); bumpTerminalGuard = false; return endAt; };
  return { events, emit, entries, notices, command, ctx, before, terminal, setSession: (v: string) => session = v, advance: (n: number) => now += n, now: () => now, clockReads };
}

test("index owns a controllable hook clock: preflight, native miss, Off interval, guard/append boundary, same-SID reset and leave", async () => {
  const h = hookHarness(), oldArgv = process.argv; process.argv = ["node", cli, "-ne", "-e", "/tmp/repo/packages/async-compaction/src/index.ts"];
  const argvDescriptor = Object.getOwnPropertyDescriptor(process, "argv")!;
  let advanceProfileIo = false, profileReads = 0;
  const supportedArgv = process.argv;
  Object.defineProperty(process, "argv", { configurable: true, enumerable: argvDescriptor.enumerable, get() { if (advanceProfileIo) { profileReads++; h.advance(50); } return supportedArgv; } });
  try {
    await h.emit("session_start", {}, h.ctx); await h.command("on", h.ctx);
    await h.before("manual"); await h.before("overflow"); assert.equal(h.entries.filter(e => e.type === "async-compact-timing").length, 0);
    advanceProfileIo = true;
    await h.before("threshold"); advanceProfileIo = false;
    const start = h.clockReads.at(-1)!;
    assert.equal(profileReads, 2, "the normal entry checks the supported host twice after the handler-entry stamp");
    assert.equal(h.now(), start + 137, "hook stamp precedes host IO (+100ms) and post-filter preparation (+37ms)");
    assert.equal(h.entries.filter(e => e.type === "async-compact-timing").length, 0, "start remains open, with no premature record");
    await h.command("off", h.ctx); h.advance(200); assert.equal(h.entries.filter(e => e.type === "async-compact-timing").length, 0, "Off cannot finish an open foreground sample");
    const end = h.terminal(); h.terminal();
    let samples = h.entries.filter(e => e.type === "async-compact-timing");
    assert.equal(samples.length, 1); assert.equal(samples[0].data.outcome, "completed"); assert.equal(samples[0].data.durationMs, end - start, "terminal stamp precedes session guard (+900ms), duplicate checks, and append (+700ms)");

    await h.command("on", h.ctx); await h.emit("input", {}, h.ctx); await h.before("threshold");
    const preStart = h.clockReads.at(-1)!, preEnd = h.terminal(true, true);
    samples = h.entries.filter(e => e.type === "async-compact-timing"); assert.equal(samples.length, 2); assert.equal(samples[1].data.outcome, "cancelled"); assert.equal(samples[1].data.durationMs, preEnd - preStart, "native input preflight is timed without a background attempt");

    await h.before("threshold"); await h.emit("session_start", {}, h.ctx); await h.command("on", h.ctx); await h.before("threshold");
    const resetStart = h.clockReads.at(-1)!, resetEnd = h.terminal();
    samples = h.entries.filter(e => e.type === "async-compact-timing"); assert.equal(samples.length, 3); assert.equal(samples[2].data.outcome, "completed"); assert.equal(samples[2].data.durationMs, resetEnd - resetStart, "same sessionId new epoch receives a fresh sample");

    await h.before("threshold"); assert.equal(h.events.has("session_before_switch"), false, "cancellable navigation preserves the active instance");
    await h.emit("session_tree", {}, h.ctx);
    samples = h.entries.filter(e => e.type === "async-compact-timing"); assert.equal(samples.length, 3, 'successful tree navigation discards the old-scope stage instead of appending into the new branch');
    h.setSession("replacement"); await h.command("on", h.ctx); await h.before("threshold"); h.terminal();
    samples = h.entries.filter(e => e.type === "async-compact-timing"); assert.equal(samples.length, 4); assert.equal(samples[3].data.outcome, "completed", "new session sample is distinct from discarded old-branch work");
  } finally { Object.defineProperty(process, "argv", argvDescriptor); process.argv = oldArgv; }
});

test("fallback phase append and command notification failures preserve native hook result and timing", async () => {
  const h = hookHarness({ failAppend: type => type === "async-compact-progress", failNotify: true }), oldArgv = process.argv;
  process.argv = ["node", cli, "-ne", "-e", "/tmp/repo/packages/async-compaction/src/index.ts"];
  try {
    await h.emit("session_start", {}, h.ctx);
    await assert.doesNotReject(h.command("on", h.ctx));
    await h.emit("input", {}, h.ctx);
    assert.equal(await h.before("threshold"), undefined, "failed fallback phase write does not replace native ownership/result");
    assert.equal(h.entries.filter(e => e.type === "async-compact-timing").length, 0);
    h.terminal();
    assert.equal(h.entries.filter(e => e.type === "async-compact-timing").length, 1);
    assert.equal(h.entries.find(e => e.type === "async-compact-timing")?.data.outcome, "completed");
    assert.doesNotMatch(JSON.stringify(h.notices), /private/);
  } finally { process.argv = oldArgv; }
});

test("generic manual, threshold, overflow, disabled, success and failure diagnostics submit zero metrics while supported enabled threshold retains its original event", async () => {
  let submissions = 0;
  const h = hookHarness({ submitMetric: async () => { submissions++; throw new Error('fail-loud metrics sink'); } });
  const oldArgv = process.argv; process.argv = ["node", cli, "-ne", "-e", "/tmp/repo/packages/async-compaction/src/index.ts"];
  try {
    await h.emit('session_start', {}, h.ctx);
    for (const reason of ['manual', 'threshold', 'overflow'] as const) {
      await h.before(reason); h.terminal(false, false, reason);
    }
    await h.command('on', h.ctx);
    await h.before('manual'); h.terminal(false, false, 'manual');
    await h.before('overflow'); h.terminal(false, false, 'overflow');
    assert.equal(submissions, 0, 'generic compaction-duration records never reach the remote sink');
    await h.before('threshold'); h.terminal(false, false, 'threshold');
    assert.equal(submissions, 1, 'enabled supported threshold retains exactly its original foreground_compaction event');
    assert.equal(h.entries.filter(entry => entry.type === 'compaction-duration').length, 6);
    assert.equal(h.entries.filter(entry => entry.type === 'async-compact-timing').length, 1);
  } finally { process.argv = oldArgv; }
});

test("unsupported CLI/profile and Off threshold do not create samples", async () => {
  const h = hookHarness(), oldArgv = process.argv; process.argv = ["node", "unsupported-cli", "-ne", "-e", "/tmp/repo/packages/async-compaction/src/index.ts"];
  try { await h.emit("session_start", {}, h.ctx); await h.command("on", h.ctx); await h.before("threshold"); h.terminal(); assert.equal(h.entries.filter(e => e.type === "async-compact-timing").length, 0); }
  finally { process.argv = oldArgv; }
});
