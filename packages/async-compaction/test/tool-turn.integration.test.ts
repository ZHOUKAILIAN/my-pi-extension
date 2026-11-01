import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { hasCompletedToolTurn } from "../src/tool-turn.ts";
import { writeMachinePreference } from "../src/machine-settings.ts";

const usage = (input: number) => ({ input, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: input + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const contentText = (message: { content: unknown }) => Array.isArray(message.content) ? message.content.filter(block => block.type === "text").map(block => block.text).join("") : String(message.content);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test("real SDK tool turn starts background generation after all persisted results without blocking follow-up", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "async-tool-turn-sdk-")), agentDir = join(cwd, "agent"), dir = join(cwd, "sessions");
  mkdirSync(agentDir); mkdirSync(dir);
  const argv = process.argv, previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.argv = ["node", fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")).replace(/\/dist\/index\.js$/, "/dist/bundle/cli.js"), "--no-extensions", "-e", "packages/async-compaction/src/index.ts"];
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  let background = 0, foreground = 0, backgroundSettled = false;
  const reportedInputs: number[] = [];
  const requestOrder: string[] = [];
  const turnEnds: unknown[] = [];
  const pendingAtTurnEnd: boolean[] = [];
  const errors: unknown[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "missing-auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("fake", { baseUrl: "http://127.0.0.1:1", api: "fake-api", apiKey: "test-only", streamSimple: (model, context, options) => {
    const summary = context.messages.some(message => /Summarize the following effective conversation/.test(contentText(message)));
    requestOrder.push(summary ? "background" : `foreground-${foreground + 1}`);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      if (summary) { background++; await gate; }
      else foreground++;
      const number = foreground;
      const calls = number === 3 || number === 5 ? [
        { type: "toolCall" as const, id: `call-read-${number}`, name: "fixture_read", arguments: { value: "read" } },
        { type: "toolCall" as const, id: `call-edit-${number}`, name: "fixture_edit", arguments: { value: "edit" } },
      ] : [];
      const value = summary ? "BACKGROUND CANDIDATE" : `foreground-${number} completed`;
      const inputTokens = summary ? 100 : foreground <= 2 ? 1000 : 12000;
      if (!summary) reportedInputs.push(inputTokens);
      const message = { role: "assistant" as const, content: calls.length ? calls : [{ type: "text" as const, text: value }], api: model.api, provider: model.provider, model: model.id, usage: usage(inputTokens), stopReason: calls.length ? "toolUse" as const : "stop" as const, timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
      stream.end();
      if (summary) backgroundSettled = true;
    })();
    return stream;
  }, models: [{ id: "m", name: "M", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16384, maxTokens: 512 }] });
  const sm = SessionManager.create(cwd, dir);
  await writeMachinePreference("asyncCompaction", true, join(agentDir, "settings.json"));
  const tool = (name: string) => defineTool({ name, label: name, description: name, parameters: Type.Object({ value: Type.String() }), async execute(_id, params) {
    requestOrder.push(`tool-${name}`);
    return { content: [{ type: "text" as const, text: `${name}:${params.value}` }], details: undefined };
  } });
  const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, extensionFactories: [pi => { extension(pi, { settingsFile: join(agentDir, "settings.json"), agentType: "main" }); pi.on("turn_end", (event, ctx) => { turnEnds.push(event); pendingAtTurnEnd.push(ctx.hasPendingMessages()); if ((event as any).message?.stopReason === "toolUse") requestOrder.push("tool-results-persisted"); }); pi.registerTool(tool("fixture_read")); pi.registerTool(tool("fixture_edit")); }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir, model: runtime.getModel("fake", "m"), thinkingLevel: "off", modelRuntime: runtime, resourceLoader: loader, sessionManager: sm,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 1 }, retry: { enabled: false } }) });
  await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, onTerminalInput: () => () => {} } as never, onError: error => errors.push(error) });
  try {
    await session.prompt("history-one " + "constraint detail ".repeat(800));
    await session.prompt("history-two " + "constraint detail ".repeat(800));
    assert.equal(background, 0, "below-threshold stop turns cannot start the background request");
    assert.deepEqual(reportedInputs, [1000, 1000]);
    assert.deepEqual(requestOrder, ["foreground-1", "foreground-2"]);
    await session.prompt("start tools");
    assert.equal(turnEnds.length, 4, turnEnds.map(event => (event as any).message?.stopReason).join(","));
    assert.equal(hasCompletedToolTurn(turnEnds[2] as any, sm.getBranch()), true, "SDK's toolUse event references matching persisted messages");
    assert.equal(pendingAtTurnEnd[2], false, "the host has completed and persisted the tool batch before scheduling");
    assert.equal(background, 1, `toolUse turn did not launch background request: ${JSON.stringify({ errors, foreground, usage: session.getContextUsage(), pendingAtTurnEnd, turnEnds })}`);
    assert.equal(reportedInputs[2], 12000, "only the completed toolUse turn reports pressure above the 16K model's 10.6K soft threshold");
    assert.equal(foreground, 4, "SDK issued the follow-up model request after the completed tool turn while summary request stayed pending");
    assert.deepEqual(requestOrder.slice(0, 7), ["foreground-1", "foreground-2", "foreground-3", "tool-fixture_read", "tool-fixture_edit", "tool-results-persisted", "background"], requestOrder.join(" -> "));
    assert.ok(requestOrder.indexOf("background") < requestOrder.indexOf("foreground-4"), requestOrder.join(" -> "));
    assert.equal(backgroundSettled, false, "background provider remains deliberately held");
    await session.prompt("another tool turn while background is pending");
    assert.equal(foreground, 6, "a later foreground run also proceeds while the same background call is pending");
    assert.equal(background, 1, "repeated qualifying tool turns cannot bypass the single physical request slot");
    const branch = sm.getBranch();
    const scheduleRecords = branch.filter(entry => entry.type === "custom" && entry.customType === "async-compact-schedule");
    assert.ok(scheduleRecords.some(entry => entry.data?.trigger === "completed_tool_turn"), "completed tool-turn scheduling is recorded distinctly");
    const toolCalls = branch.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "toolUse");
    const toolResults = branch.filter(entry => entry.type === "message" && entry.message.role === "toolResult");
    assert.equal(toolCalls.length, 2);
    assert.equal(turnEnds.length, 6);
    assert.equal(hasCompletedToolTurn(turnEnds[4] as any, branch), true, "the repeated complete tool turn reaches the same eligibility boundary");
    assert.deepEqual(toolResults.map(entry => entry.message.toolCallId), ["call-read-3", "call-edit-3", "call-read-5", "call-edit-5"]);
    assert.equal(branch.some(entry => entry.type === "compaction"), false, "preparing a candidate never appends or adopts compaction while foreground work continues");
    assert.ok(branch.some(entry => entry.type === "message" && entry.message.role === "assistant" && contentText(entry.message).includes("foreground-4 completed")));
    assert.ok(branch.some(entry => entry.type === "message" && entry.message.role === "assistant" && contentText(entry.message).includes("foreground-6 completed")));
  } finally {
    release();
    for (let i = 0; i < 100 && !backgroundSettled; i++) await tick();
    session.dispose(); process.argv = argv;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  }
});
