import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Controller, type BudgetClock } from "../src/controller.ts";
import { fits, plan, valid, withFiles } from "../src/compaction.ts";

const usage = { input: 18, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 27, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const preparation = { tokensBefore: 2900, firstKeptEntryId: "unused", isSplitTurn: false, settings: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } };
function fixture() {
  const sm = SessionManager.inMemory("/tmp/async-compact-budget-test");
  for (let n = 1; n <= 2; n++) {
    sm.appendMessage({ role: "user", content: [{ type: "text", text: `user-${n} ` + "word ".repeat(160) }], timestamp: Date.now() });
    sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `answer-${n} ` + "answer ".repeat(40) }], api: "fake-api", provider: "fake", model: "m", stopReason: "stop", timestamp: Date.now(), usage });
  }
  let resolve!: (value: unknown) => void, calls = 0, now = 0;
  const requestSignals: AbortSignal[] = [];
  const timers: { callback: () => void; delay: number; active: boolean }[] = [];
  const budgetClock: BudgetClock = {
    monotonic: () => now,
    setTimeout: ((callback: () => void, delay = 0) => { const timer = { callback, delay, active: true }; timers.push(timer); return timer; }) as typeof setTimeout,
    clearTimeout: ((handle: unknown) => { if (handle && typeof handle === "object" && "active" in handle) (handle as { active: boolean }).active = false; }) as typeof clearTimeout,
  };
  const entries: { kind: string; data: any }[] = [];
  const pi: any = {
    getSettings: () => ({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 } }), getAllTools: () => [], getActiveTools: () => [],
    registerEntryRenderer() {}, appendEntry: (kind: string, data: unknown) => entries.push({ kind, data }),
  };
  const ctx: any = {
    sessionManager: sm, mode: "tui", ui: { notify() {} }, model: { provider: "fake", id: "m", api: "fake-api", contextWindow: 4096 }, thinkingLevel: "off",
    getSystemPrompt: () => "system", hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 2900, contextWindow: 4096 }),
    modelRegistry: { streamSimple: (_model: unknown, _context: unknown, options: { signal: AbortSignal }) => { calls++; requestSignals.push(options.signal); return { result: () => new Promise(r => resolve = r) }; } },
  };
  const controller = new Controller(pi, undefined, undefined, budgetClock);
  controller.set(true, ctx);
  return { controller, ctx, pi, entries, timers, calls: () => calls, requestSignals, resolve: (stopReason = "stop") => resolve({ role: "assistant", stopReason, content: [{ type: "text", text: "safe summary" }], usage, api: "fake-api", provider: "fake", model: "m", timestamp: Date.now() }), setNow: (value: number) => now = value, now: () => now, budgetClock };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function trackAbortListeners(signal: AbortSignal) {
  let adds = 0, removes = 0;
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, ...args: any[]) => { if (type === "abort") adds++; return add(type, ...args); }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, ...args: any[]) => { if (type === "abort") removes++; return remove(type, ...args); }) as typeof signal.removeEventListener;
  return () => ({ adds, removes });
}

test("900s budget starts at streamSimple, spends only the remainder, duplicate offers cannot renew it, timeout keeps the physical slot", async () => {
  const f = fixture();
  f.setNow(1234);
  const scope = new AbortController(); f.ctx.signal = scope.signal;
  const trackedScope = trackAbortListeners(scope.signal);
  f.controller.schedule(f.ctx);
  assert.equal(f.calls(), 1);
  const trackedAttempt = trackAbortListeners(f.requestSignals[0]);
  f.setNow(1234 + 300_000);
  const hostSignal = new AbortController().signal;
  const trackedHost = trackAbortListeners(hostSignal);
  const offer = f.controller.offer(f.ctx, preparation, hostSignal);
  await tick();
  const waitTimer = f.timers.find(timer => timer.delay === 600_000 && timer.active);
  assert.ok(waitTimer, "foreground waits the remaining 600 seconds, not a fresh budget");
  assert.equal(await f.controller.offer(f.ctx, preparation, hostSignal), undefined, "a duplicate offer does not start another waiter");
  f.setNow(1234 + 900_000);
  waitTimer.callback();
  const result = await offer;
  assert.equal(result, undefined);
  assert.equal(f.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "deadline", "deadline is not confused with a user stop");
  for (const [name, counts] of [["host", trackedHost()], ["attempt", trackedAttempt()], ["scope", trackedScope()]] as const) assert.equal(counts.adds, counts.removes, `${name} abort listener is removed after timeout`);
  assert.equal(f.timers.some(timer => timer.active && timer.delay === 900_000), false, "terminal timeout clears the generation deadline");
  assert.equal(f.calls(), 1);
  f.controller.schedule(f.ctx);
  assert.equal(f.calls(), 1, "timeout does not release the physical slot before provider settlement");
  f.resolve(); await tick(); await tick();
  assert.equal(f.entries.filter(entry => entry.kind === "async-compact-usage").length, 1, "late physical usage settles once");
  assert.equal(f.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "deadline");
});

test("a newly scheduled attempt captures its configured absolute budget while the default remains 900s", async () => {
  const configured = fixture(); configured.controller.schedule(configured.ctx, "assistant_stop", 1_200_000);
  assert.equal(configured.timers.find(timer => timer.active)?.delay, 1_200_000, "configured 1200s is captured at SDK start");
  configured.setNow(600_000);
  const pending = configured.controller.offer(configured.ctx, preparation, new AbortController().signal);
  await tick();
  assert.ok(configured.timers.some(timer => timer.active && timer.delay === 600_000), "threshold wait consumes only the original captured remainder");
  configured.controller.schedule(configured.ctx, "assistant_stop", 1_000);
  assert.equal(configured.timers.some(timer => timer.active && timer.delay === 1_200_000), true, "later scheduling input cannot change the existing absolute deadline");
  configured.controller.set(false, configured.ctx); await pending; configured.resolve("aborted"); await tick();

  const invalid = fixture(); invalid.controller.schedule(invalid.ctx, "assistant_stop", 1.5);
  assert.equal(invalid.calls(), 0, "invalid budget fails closed before any provider request");
  assert.equal(invalid.entries.find(entry => entry.kind === "async-compact-schedule")?.data.reason, "invalid_budget");
});

test("an initially invalid candidate returns without waiting on its otherwise-valid in-flight request", async () => {
  const f = fixture(); f.controller.schedule(f.ctx); f.ctx.hasPendingMessages = () => true;
  const before = f.timers.length;
  assert.equal(await f.controller.offer(f.ctx, preparation, new AbortController().signal), undefined);
  assert.equal(f.timers.length, before, "invalid input is rejected before allocating a foreground deadline timer");
  assert.equal(f.entries.filter(entry => entry.kind === "async-compact-schedule").at(-1)?.data.reason, "pending_input");
  assert.equal(f.calls(), 1, "no duplicate request is launched to replace the invalid candidate");
  f.controller.set(false, f.ctx); f.resolve(); await tick();
});

test("in-flight attempts do not wait when a later oversized text or image tail makes even the minimum summary impossible", async () => {
  for (const tail of ["oversized-text", "image"] as const) {
    const f = fixture();
    const prefix = plan(f.pi, f.ctx, 0);
    f.controller.schedule(f.ctx);
    if (tail === "oversized-text") f.ctx.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "tail-content ".repeat(20_000) }], timestamp: Date.now() });
    else f.ctx.sessionManager.appendMessage({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], timestamp: Date.now() });
    const timerCount = f.timers.length;
    assert.ok(prefix && valid(f.pi, f.ctx, prefix), `${tail}: planned prefix remains valid after tail growth`);
    assert.equal(fits(f.pi, f.ctx, prefix!, withFiles("x", prefix!.files), preparation.tokensBefore), false, `${tail}: even the minimum useful summary cannot fit`);
    assert.equal(await f.controller.offer(f.ctx, preparation, new AbortController().signal), undefined, `${tail} preserves native fallback ownership`);
    assert.equal(f.timers.length, timerCount, `${tail} allocates no foreground wait timer after impossibility is known`);
    assert.equal(f.entries.some(entry => entry.kind === "async-compact-progress" && entry.data.phase === "waiting"), false, `${tail} never displays a waiting phase`);
    f.controller.set(false, f.ctx); f.resolve("aborted"); await tick(); await tick();
  }
});

test("600s remains inside the default 900s deadline; exact deadline response loses once", async () => {
  const before = fixture(); before.controller.schedule(before.ctx); before.setNow(600_000); before.resolve(); await tick(); await tick();
  assert.ok(await before.controller.offer(before.ctx, preparation, new AbortController().signal), "600 seconds does not trigger the default 900 second deadline");
  const at = fixture(); at.controller.schedule(at.ctx); at.setNow(900_000); at.resolve(); await tick(); await tick();
  assert.equal(await at.controller.offer(at.ctx, preparation, new AbortController().signal), undefined, "the absolute deadline linearizes before a response at the same instant");
  assert.equal(at.entries.filter(entry => entry.kind === "async-compact-cancellation" && entry.data.reason === "deadline").length, 1);
  assert.equal(at.entries.filter(entry => entry.kind === "async-compact-usage").length, 1);
});

test("Esc only cancels the active automatic offer; unrelated stop calls do not poison a later operation", async () => {
  const f = fixture();
  f.controller.schedule(f.ctx);
  const trackedAttempt = trackAbortListeners(f.requestSignals[0]);
  const pending = f.controller.offer(f.ctx, preparation, new AbortController().signal);
  await tick();
  f.controller.stop(f.ctx, "user");
  assert.deepEqual(await pending, { cancel: true });
  assert.equal(f.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "user", "the current waited compaction receives the user cancellation");
  assert.equal(trackedAttempt().adds, trackedAttempt().removes, "attempt abort listener is removed after user cancellation");
  f.controller.stop(f.ctx, "user");
  assert.equal(f.entries.filter(entry => entry.kind === "async-compact-cancellation" && entry.data.reason === "user").length, 1, "a stop outside an active offer cannot create a sticky next-operation cancellation");
  f.resolve("aborted"); await tick(); await tick();
  f.controller.reset(f.ctx); f.controller.set(true, f.ctx); f.controller.schedule(f.ctx);
  f.resolve("stop"); await tick(); await tick();
  const next = await f.controller.offer(f.ctx, preparation, new AbortController().signal);
  assert.ok(next && !("cancel" in next), "a following operation is not cancelled by the previous manual/Esc stop");
});

test("scope invalidation wakes the offer and explicitly cancels rather than reaching native fallback", async () => {
  const f = fixture(), scope = new AbortController(), host = new AbortController(); f.ctx.signal = scope.signal;
  const trackedScope = trackAbortListeners(scope.signal), trackedHost = trackAbortListeners(host.signal);
  f.controller.schedule(f.ctx);
  const trackedAttempt = trackAbortListeners(f.requestSignals[0]);
  const pending = f.controller.offer(f.ctx, preparation, host.signal);
  await tick(); scope.abort();
  assert.deepEqual(await pending, { cancel: true });
  for (const [name, counts] of [["host", trackedHost()], ["attempt", trackedAttempt()], ["scope", trackedScope()]] as const) assert.equal(counts.adds, counts.removes, `${name} abort listener is removed after scope cancellation`);
  assert.equal(f.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "scope");
  f.resolve("aborted"); await tick(); await tick();
});

test("wait abort listeners are removed after provider completion and Off", async () => {
  const done = fixture(), doneHost = new AbortController(), doneScope = new AbortController(); done.ctx.signal = doneScope.signal;
  const doneCounts = [trackAbortListeners(doneHost.signal), trackAbortListeners(doneScope.signal)];
  done.controller.schedule(done.ctx); doneCounts.push(trackAbortListeners(done.requestSignals[0]));
  const offered = done.controller.offer(done.ctx, preparation, doneHost.signal); await tick(); done.resolve(); await tick(); await tick();
  assert.ok(await offered, "completed provider response can be offered");
  for (const counts of doneCounts) assert.equal(counts().adds, counts().removes, "done cleans every wait signal listener");

  const off = fixture(), offHost = new AbortController(), offScope = new AbortController(); off.ctx.signal = offScope.signal;
  const offCounts = [trackAbortListeners(offHost.signal), trackAbortListeners(offScope.signal)];
  off.controller.schedule(off.ctx); offCounts.push(trackAbortListeners(off.requestSignals[0]));
  const waiting = off.controller.offer(off.ctx, preparation, offHost.signal); await tick(); off.controller.set(false, off.ctx);
  assert.equal(await waiting, undefined, "Off leaves native compaction in control");
  for (const counts of offCounts) assert.equal(counts().adds, counts().removes, "Off cleans every wait signal listener");
  assert.equal(off.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "off");
  off.resolve("aborted"); await tick(); await tick();
});

test("a changed ctx.signal getter still removes the listener from the originally registered scope signal", async () => {
  const f = fixture(), initial = new AbortController(), replacement = new AbortController();
  let swapped = false;
  Object.defineProperty(f.ctx, "signal", { configurable: true, get: () => swapped ? replacement.signal : initial.signal });
  const initialCounts = trackAbortListeners(initial.signal), replacementCounts = trackAbortListeners(replacement.signal);
  f.controller.schedule(f.ctx);
  const pending = f.controller.offer(f.ctx, preparation, new AbortController().signal);
  await tick(); swapped = true; initial.abort();
  assert.deepEqual(await pending, { cancel: true });
  assert.equal(initialCounts().adds, initialCounts().removes, "listener removed from the exact initially observed signal");
  assert.deepEqual(replacementCounts(), { adds: 0, removes: 0 }, "a later ctx.signal value is neither registered nor used for cleanup");
  f.resolve("aborted"); await tick(); await tick();
});

test("a user stop cancels a generating request even before the host starts waiting", async () => {
  const f = fixture(); f.controller.schedule(f.ctx);
  const signal = f.requestSignals[0]; assert.equal(signal.aborted, false);
  f.controller.stop(f.ctx, "user");
  assert.equal(signal.aborted, true);
  assert.equal(f.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "user", "Esc while only a background candidate is generating is attributed to the user");
  f.resolve("aborted"); await tick(); await tick();
});

test("native manual/overflow retirement is never recorded as a user cancellation", async () => {
  const f = fixture(); f.controller.schedule(f.ctx); f.controller.stop(f.ctx, "native");
  assert.equal(f.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "native");
  assert.equal(f.entries.some(entry => entry.kind === "async-compact-cancellation" && entry.data.reason === "user"), false);
  f.resolve("aborted"); await tick(); await tick();
});

test("host cancellation wakes the offer and removes its abort listener without native-cancel misclassification", async () => {
  const f = fixture(), host = new AbortController(), scope = new AbortController(); f.ctx.signal = scope.signal;
  const trackedHost = trackAbortListeners(host.signal), trackedScope = trackAbortListeners(scope.signal);
  f.controller.schedule(f.ctx);
  const trackedAttempt = trackAbortListeners(f.requestSignals[0]);
  const pending = f.controller.offer(f.ctx, preparation, host.signal);
  await tick(); host.abort();
  assert.deepEqual(await pending, { cancel: true });
  for (const [name, counts] of [["host", trackedHost()], ["attempt", trackedAttempt()], ["scope", trackedScope()]] as const) assert.equal(counts.adds, counts.removes, `${name} abort listener is detached after host cancellation`);
  assert.equal(f.entries.find(entry => entry.kind === "async-compact-cancellation")?.data.reason, "host");
  f.resolve("aborted"); await tick(); await tick();
});
