import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import fenceExtension from "../src/side-effect-fence-extension.ts";
import { sideEffectFenceToolSetDigest } from "../src/delegation-internal.ts";

function eventHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
  const active: string[][] = [];
  return { handlers, active, on(name: string, handler: any) { handlers.set(name, handler); }, getActiveTools() { return active.at(-1) ?? []; }, setActiveTools(names: string[]) { active.push([...names]); } } as any;
}

test("real Pi event handlers fence final tool_call input and final tool_result digest over IPC", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-extension-"));
  const socket = path.join(root, "fence.sock");
  const server = net.createServer();
  const clients = new Set<net.Socket>();
  const frames: any[] = [];
  server.on("connection", (client) => {
    clients.add(client); client.once("close", () => clients.delete(client));
    let buffer = "";
    client.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const frame = JSON.parse(line); frames.push(frame);
        if (frame.type === "hello") client.write(`${JSON.stringify({ version: 1, type: "hello_ack", requestId: "hello", ok: true, handler: 1, dispatchCallId: frame.dispatchCallId, delegationId: frame.delegationId, executionScope: frame.executionScope, reservationId: frame.reservationId, owner: frame.owner, ownerGeneration: frame.ownerGeneration, fencingGeneration: frame.fencingGeneration, childSessionId: frame.childSessionId, childIdentityRef: frame.childIdentityRef, pid: frame.pid, allowlistManifestDigest: frame.allowlistManifestDigest, extensionOrderDigest: frame.extensionOrderDigest, fenceLastProof: frame.fenceLastProof, policyDigest: frame.policyDigest, toolSetDigest: sideEffectFenceToolSetDigest(["custom_tool"]), policyVersion: "1.0.0", policies: [{ toolName: "custom_tool", classification: "fenced_mutating" }] })}\n`);
        if (frame.type === "prepare") client.write(JSON.stringify({ version: 1, type: "response", requestId: frame.requestId, ok: true, handler: 1, actionId: "action-" + "1".repeat(64), stableIdempotencyKey: "idempotency:" + "2".repeat(64), preInjectionArgsDigest: "3".repeat(64), policy: "fenced_mutating" }) + "\n");
        if (frame.type === "intent" || frame.type === "result") client.write(`${JSON.stringify({ version: 1, type: "response", requestId: frame.requestId, ok: true, handler: 1 })}\n`);
        if (frame.type === "goodbye") { client.end(`${JSON.stringify({ version: 1, type: "goodbye_ack", requestId: "goodbye", ok: true, handler: 1, seq: frame.seq, nonce: frame.nonce, dispatchCallId: frame.dispatchCallId, delegationId: frame.delegationId, executionScope: frame.executionScope, reservationId: frame.reservationId, owner: frame.owner, ownerGeneration: frame.ownerGeneration, fencingGeneration: frame.fencingGeneration, childSessionId: frame.childSessionId, childIdentityRef: frame.childIdentityRef, pid: frame.pid, completedActionIds: frame.completedActionIds, blockedActionIds: frame.blockedActionIds })}\n`); }
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, () => { server.removeAllListeners("error"); resolve(); }); });
  await fs.chmod(socket, 0o600);
  const previous = { socket: process.env.PI_SUBAGENT_FENCE_SOCKET, nonce: process.env.PI_SUBAGENT_FENCE_NONCE, protocol: process.env.PI_SUBAGENT_FENCE_PROTOCOL };
  process.env.PI_SUBAGENT_FENCE_SOCKET = socket; process.env.PI_SUBAGENT_FENCE_NONCE = "test-nonce"; process.env.PI_SUBAGENT_FENCE_PROTOCOL = "1"; process.env.PI_SUBAGENT_FENCE_HANDSHAKE = Buffer.from(JSON.stringify({ dispatchCallId: "call", delegationId: "delegation", executionScope: "scope", reservationId: "reservation", owner: "owner", ownerGeneration: 1, fencingGeneration: 1, childIdentityRef: "self", allowlistManifestDigest: "manifest", extensionOrderDigest: "order", toolSetDigest: sideEffectFenceToolSetDigest(["custom_tool"]), policyDigest: "policy", fenceLastProof: "proof" })).toString("base64url");
  try {
    const pi = eventHarness(); fenceExtension(pi);
    let aborted = false;
    const ctx = { abort() { aborted = true; }, sessionManager: { getSessionId: () => "child-session" } };
    await pi.handlers.get("session_start")!({}, ctx);
    await pi.handlers.get("turn_start")!({}, ctx);
    await pi.handlers.get("tool_execution_start")!({ toolCallId: "call-1", toolName: "custom_tool" }, ctx);
    const finalInput = { amount: 3, rewrittenBy: "prior-handler" };
    const callResult = await pi.handlers.get("tool_call")!({ toolCallId: "call-1", toolName: "custom_tool", input: finalInput }, ctx);
    assert.equal(callResult, undefined);
    assert.deepEqual(pi.getActiveTools(), ["custom_tool"]);
    const resultResult = await pi.handlers.get("tool_result")!({ toolCallId: "call-1", toolName: "custom_tool", content: [{ type: "text", text: "ok" }], details: { source: "tool" }, isError: false, usage: { totalTokens: 2 } }, ctx);
    assert.equal(resultResult, undefined);
    assert.equal(aborted, false);
    await pi.handlers.get("session_shutdown")!({}, ctx);
    assert.deepEqual(frames.map((frame) => frame.type), ["hello", "prepare", "intent", "result", "goodbye"]);
    assert.deepEqual(frames[2].input, finalInput);
    assert.equal(frames[2].toolCallOrdinal, 0);
    assert.equal(frames[2].logicalCheckpoint, "turn:1:tool:0");
    assert.match(frames[3].resultDigest, /^[0-9a-f]{64}$/);
  } finally {
    if (previous.socket === undefined) delete process.env.PI_SUBAGENT_FENCE_SOCKET; else process.env.PI_SUBAGENT_FENCE_SOCKET = previous.socket;
    if (previous.nonce === undefined) delete process.env.PI_SUBAGENT_FENCE_NONCE; else process.env.PI_SUBAGENT_FENCE_NONCE = previous.nonce;
    if (previous.protocol === undefined) delete process.env.PI_SUBAGENT_FENCE_PROTOCOL; else process.env.PI_SUBAGENT_FENCE_PROTOCOL = previous.protocol;
    delete process.env.PI_SUBAGENT_FENCE_HANDSHAKE;
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
