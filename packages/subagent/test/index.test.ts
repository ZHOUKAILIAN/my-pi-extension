import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSubagentModes, scheduleGarbageCollection, subagentSessionMetadata, type SingleResult } from "../src/index.ts";

function success(agent: string, task: string, step?: number): SingleResult {
  return { agent, agentSource: "user", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text: `${agent}:${task}` }], stopReason: "stop" } as any] as any, toolResults: [], usage: { input: 0, output: 0, cacheRead: 0, cost: 0, contextTokens: 0, turns: 1, cacheWrite: 0 }, requestedModel: "unknown", actualModel: "unknown", source: "initial", attempt: step ?? 1, failureKind: "success", cwdScope: "cwd:unknown" };
}

const details = (results: SingleResult[]) => ({ mode: "single" as const, agentScope: "user" as const, results });

test("index mode integration routes single, parallel, and chained calls", async () => {
  const seen: string[] = [];
  const runOne = async (item: { agent: string; task: string }, step?: number) => {
    seen.push(`${item.agent}:${item.task}`);
    return success(item.agent, item.task, step);
  };
  const single = await runSubagentModes({ single: { agent: "a", task: "one" } }, runOne, details);
  assert.match(single.content[0].text, /^a:\[TASK_OR_PROMPT_OMITTED\]\n\n已返回\n\[执行诊断：不代表验收结论；工具异常 未提供；模型异常 未提供\]$/);
  const parallel = await runSubagentModes({ tasks: [{ agent: "a", task: "one" }, { agent: "b", task: "two" }] }, runOne, details);
  assert.match(parallel.content[0].text, /Parallel: 2\/2 已返回/);
  const chain = await runSubagentModes({ chain: [{ agent: "a", task: "first" }, { agent: "b", task: "next {previous}" }] }, runOne, details);
  assert.match(chain.content[0].text, /b:\[TASK_OR_PROMPT_OMITTED\]/);
  assert.match(chain.content[0].text, /b:\[TASK_OR_PROMPT_OMITTED\]\n\n已返回\n\[执行诊断：不代表验收结论；工具异常 未提供；模型异常 未提供\]/);
  assert.deepEqual(seen, ["a:one", "a:one", "b:two", "a:first", "b:next a:[TASK_OR_PROMPT_OMITTED]\n\n[执行诊断：不代表验收结论；工具异常 未提供；模型异常 未提供]"]);
});

test("chain appends diagnostics even when the next task has no previous placeholder", async () => {
  const seen: string[] = [];
  const response = await runSubagentModes({ chain: [{ agent: "a", task: "first" }, { agent: "b", task: "next" }] }, async (item) => {
    seen.push(item.task);
    return {
      ...success(item.agent, item.task),
      diagnostics: { toolErrorCount: 2, providerErrorCount: 1 },
    };
  }, details);
  assert.match(seen[1], /next\n\n\[执行诊断：不代表验收结论；工具异常 2；模型异常 1\]/);
  assert.match(response.content[0].text, /已返回\n\[执行诊断：不代表验收结论；工具异常 2；模型异常 1\]/);
});

test("non-success output keeps the report and says it was not fully returned", async () => {
  const response = await runSubagentModes({ single: { agent: "a", task: "task" } }, async () => ({
    ...success("a", "task"), phase: "finished" as const, failureKind: "transient_provider" as const,
  }), details);
  assert.match(response.content[0].text, /a:\[TASK_OR_PROMPT_OMITTED\]/);
  assert.match(response.content[0].text, /执行失败（瞬态模型错误）（未完整返回）/);
  assert.doesNotMatch(response.content[0].text, /已返回不代表验收通过/);
  assert.equal(response.isError, true);
});

test("a failed chain keeps the report and does not claim it was returned", async () => {
  const response = await runSubagentModes({ chain: [{ agent: "a", task: "first" }, { agent: "b", task: "next {previous}" }] }, async (item, step) => ({
    ...success(item.agent, item.task, step), phase: "finished" as const, failureKind: step === 2 ? "cancelled" as const : "success" as const,
  }), details);
  assert.match(response.content[0].text, /Chain stopped at step 2/);
  assert.match(response.content[0].text, /b:\[TASK_OR_PROMPT_OMITTED\]/);
  assert.match(response.content[0].text, /已取消（未完整返回）/);
  assert.doesNotMatch(response.content[0].text, /已返回不代表验收通过/);
});

test("the loaded extension renderer distinguishes running, partial, incomplete, and cancelled results", async () => {
  const loaderUrl = new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", import.meta.url);
  const { loadExtensions, createExtensionRuntime } = await import(loaderUrl.href);
  const loaded = await loadExtensions([resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts")], process.cwd(), undefined, createExtensionRuntime());
  const tool = loaded.extensions[0].tools.get("subagent")?.definition as any;
  assert.equal(typeof tool?.renderResult, "function");
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const context = { args: {}, toolCallId: "test", invalidate() {}, lastComponent: undefined, state: {}, cwd: process.cwd(), executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: false };
  const render = (item: SingleResult, isPartial: boolean) => tool.renderResult({ content: [{ type: "text", text: "fallback" }], details: details([item]) }, { expanded: false, isPartial }, theme, context).render(120).join("\n");

  assert.match(render({ ...success("a", "running"), phase: "running", failureKind: "unknown_transport" }, false), /执行中/);
  assert.doesNotMatch(render({ ...success("a", "running"), phase: "running", failureKind: "unknown_transport" }, false), /✗/);
  assert.match(render({ ...success("a", "legacy"), phase: undefined }, true), /执行中/);
  assert.match(render({ ...success("a", "long"), phase: "finished", failureKind: "incomplete" }, false), /未完整返回（长度截断）/);
  assert.match(render({ ...success("a", "cancel"), phase: "finished", failureKind: "cancelled" }, false), /已取消/);
});

test("details and user-facing output retain safe assistant text without header values", async () => {
  const cookieSecret = "Cookie_EQUALS_SECRET";
  const traceSecret = "X_TRACE_HEADER_SECRET";
  const raw = success("implementer", "ignored");
  (raw.messages[0] as any).content = [{ type: "text", text: `final answer; Cookie=${cookieSecret}; X-Trace-Header: ${traceSecret}` }];
  const response = await runSubagentModes({ single: { agent: "implementer", task: "task" } }, async () => raw, details);
  const serialized = JSON.stringify(response);
  assert.match(response.content[0].text, /final answer/);
  assert.equal(serialized.includes(cookieSecret), false);
  assert.equal(serialized.includes(traceSecret), false);
  assert.match(JSON.stringify(response.details), /final answer/);
  const metadata = subagentSessionMetadata({
    attempt: raw, attempts: [raw], persistent: true, handle: "logical-handle", status: "completed", failureKind: "success",
  }, "implementer");
  assert.equal(JSON.stringify(metadata).includes(cookieSecret), false);
  assert.equal(JSON.stringify(metadata).includes(traceSecret), false);
});

test("parent session metadata mirrors only the safe attempt summary", () => {
  const attempt = success("implementer", "TASK_SHOULD_NOT_APPEAR");
  attempt.requestedModel = "requested-model";
  attempt.actualModel = "provider/actual-model";
  attempt.attempt = 2;
  attempt.source = "retry";
  const metadata = subagentSessionMetadata({
    attempt, attempts: [attempt], persistent: true, handle: "logical-handle", status: "recoverable_failed", failureKind: "task_failure",
  }, "implementer");
  assert.deepEqual(metadata.attempt, {
    requestedModel: "requested-model", actualModel: "provider/actual-model", attempt: 2, source: "retry", kind: "success",
  });
  assert.equal(metadata.requestedModel, "requested-model");
  assert.equal(metadata.actualModel, "provider/actual-model");
  assert.equal(JSON.stringify(metadata).includes("TASK_SHOULD_NOT_APPEAR"), false);
});

test("session lifecycle schedules GC in the background and swallows maintenance failure", async () => {
  let release!: () => void;
  let started = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  scheduleGarbageCollection("/tmp/subagent-test", async () => {
    started = true;
    await pending;
    throw new Error("maintenance failed");
  });
  assert.equal(started, false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
});
