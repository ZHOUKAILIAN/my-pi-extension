import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(single.content[0].text, "a:[TASK_OR_PROMPT_OMITTED]");
  const parallel = await runSubagentModes({ tasks: [{ agent: "a", task: "one" }, { agent: "b", task: "two" }] }, runOne, details);
  assert.match(parallel.content[0].text, /Parallel: 2\/2 succeeded/);
  const chain = await runSubagentModes({ chain: [{ agent: "a", task: "first" }, { agent: "b", task: "next {previous}" }] }, runOne, details);
  assert.equal(chain.content[0].text, "b:[TASK_OR_PROMPT_OMITTED]");
  assert.deepEqual(seen, ["a:one", "a:one", "b:two", "a:first", "b:next a:[TASK_OR_PROMPT_OMITTED]"]);
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
