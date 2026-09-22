import * as net from "node:net";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SIDE_EFFECT_FENCE_MAX_FRAME, SIDE_EFFECT_FENCE_MAX_JSON, SIDE_EFFECT_FENCE_PROTOCOL, type SideEffectFenceHandshakeBinding, type SideEffectFencePolicyDescriptor } from "./side-effect-fence.ts";

const ENV_SOCKET = "PI_SUBAGENT_FENCE_SOCKET";
const ENV_NONCE = "PI_SUBAGENT_FENCE_NONCE";
const ENV_PROTOCOL = "PI_SUBAGENT_FENCE_PROTOCOL";
const ENV_HANDSHAKE = "PI_SUBAGENT_FENCE_HANDSHAKE";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
type Frame = Record<string, unknown>;
type Pending = { resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type Prepared = { actionId: string; stableIdempotencyKey: string; preInjectionArgsDigest: string; idempotencyParameter?: string; policy: SideEffectFencePolicyDescriptor; ordinal: number; checkpoint: string; toolName: string };
function string(value: unknown, max = 256): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((item) => jsonValue(item, depth + 1));
  if (typeof value === "object") return Object.keys(value as object).length <= 256 && Object.entries(value as Record<string, unknown>).every(([key, item]) => string(key, 128) && jsonValue(item, depth + 1));
  return false;
}
function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite"); return value; }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  throw new Error("unsupported json value");
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function frameBytes(frame: Frame): Buffer {
  const text = JSON.stringify(frame);
  if (Buffer.byteLength(text, "utf8") > SIDE_EFFECT_FENCE_MAX_JSON) throw new Error("frame too large");
  return Buffer.from(`${text}\n`, "utf8");
}
function isSafeParameter(value: string): boolean { return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value); }

/** Internal child-only extension. It is deliberately not part of package exports. */
export default function sideEffectFenceExtension(pi: ExtensionAPI): void {
  // The CLI starts with --no-tools. Keep the set empty while the supervisor
  // handshake is pending or failed; only the verified ACK below may activate it.
  try { (pi as any).setActiveTools?.([]); } catch { /* a failed loader stays tool-less */ }
  const socket = process.env[ENV_SOCKET];
  const nonce = process.env[ENV_NONCE];
  const protocol = Number(process.env[ENV_PROTOCOL]);
  let binding: SideEffectFenceHandshakeBinding | undefined;
  try { const decoded = process.env[ENV_HANDSHAKE] ? JSON.parse(Buffer.from(process.env[ENV_HANDSHAKE], "base64url").toString("utf8")) as unknown : undefined; if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) binding = decoded as SideEffectFenceHandshakeBinding; } catch { binding = undefined; }
  if (!socket || !nonce || protocol !== SIDE_EFFECT_FENCE_PROTOCOL || !binding || typeof binding.policyDigest !== "string") return;
  let connection: net.Socket | undefined;
  let connected = false;
  let sequence = 1;
  let turns = 0;
  const starts = new Map<string, { ordinal: number; checkpoint: string; toolName: string }>();
  const prepared = new Map<string, Prepared>();
  const policies = new Map<string, SideEffectFencePolicyDescriptor>();
  const pending = new Map<string, Pending>();
  let sourceOrdinal = 0;
  const completedActionIds = new Set<string>();
  const blockedActionIds = new Set<string>();
  const allowedActionIds = new Set<string>();
  const acceptedActions = new Map<string, string>();
  let activeSessionId: string | undefined;
  let handshake: Promise<boolean> | undefined;
  let handshakeState: "pending" | "succeeded" | "failed" = "pending";
  let buffer = "";
  const send = (frame: Frame): Promise<Frame> => new Promise((resolve, reject) => {
    if (!connection || !connected) { reject(new Error("fence is not connected")); return; }
    const requestId = String(frame.requestId);
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("fence ACK timeout")); connection?.destroy(); }, 5_000);
    pending.set(requestId, { resolve, reject, timer });
    try { connection.write(frameBytes(frame)); } catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error as Error); }
  });
  const disconnect = (reason: string) => { connected = false; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); } pending.clear(); };
  const connect = async (sessionId: string): Promise<boolean> => {
    activeSessionId = sessionId;
    if (handshake) return handshake;
    handshake = new Promise<boolean>((resolve) => {
      connection = net.createConnection(socket);
      connection.once("connect", () => {
        try { connection!.write(frameBytes({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "hello", seq: 0, nonce, dispatchCallId: binding!.dispatchCallId, delegationId: binding!.delegationId, executionScope: binding!.executionScope, reservationId: binding!.reservationId, owner: binding!.owner, ownerGeneration: binding!.ownerGeneration, fencingGeneration: binding!.fencingGeneration, childSessionId: sessionId, childIdentityRef: digest({ sessionId, pid: process.pid }), pid: process.pid, allowlistManifestDigest: binding!.allowlistManifestDigest, extensionOrderDigest: binding!.extensionOrderDigest, toolSetDigest: binding!.toolSetDigest, policyDigest: binding!.policyDigest, interceptorRealpath: binding!.interceptorRealpath, interceptorDigest: binding!.interceptorDigest, interceptorVersion: binding!.interceptorVersion, fenceLastProof: binding!.fenceLastProof })); } catch { handshakeState = "failed"; resolve(false); }
      });
      connection.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > SIDE_EFFECT_FENCE_MAX_FRAME) { disconnect("fence frame too large"); connection?.destroy(); resolve(false); return; }
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          let frame: unknown; try { frame = JSON.parse(line); } catch { disconnect("invalid fence response"); connection?.destroy(); resolve(false); return; }
          if (!frame || typeof frame !== "object" || Array.isArray(frame)) { disconnect("invalid fence response"); connection?.destroy(); resolve(false); return; }
          const response = frame as Frame;
          if (response.version !== SIDE_EFFECT_FENCE_PROTOCOL || typeof response.type !== "string") { disconnect("invalid fence response version"); connection?.destroy(); resolve(false); return; }
          if (response.type === "hello_ack") {
            const expectedChildRef = digest({ sessionId, pid: process.pid });
            if (response.requestId !== "hello" || response.ok !== true || response.handler !== 1 || response.dispatchCallId !== binding!.dispatchCallId || response.delegationId !== binding!.delegationId || response.executionScope !== binding!.executionScope || response.reservationId !== binding!.reservationId || response.owner !== binding!.owner || response.ownerGeneration !== binding!.ownerGeneration || response.fencingGeneration !== binding!.fencingGeneration || response.childSessionId !== sessionId || response.childIdentityRef !== expectedChildRef || response.pid !== process.pid || response.allowlistManifestDigest !== binding!.allowlistManifestDigest || response.extensionOrderDigest !== binding!.extensionOrderDigest || response.toolSetDigest !== binding!.toolSetDigest || response.policyDigest !== binding!.policyDigest || response.interceptorRealpath !== binding!.interceptorRealpath || response.interceptorDigest !== binding!.interceptorDigest || response.interceptorVersion !== binding!.interceptorVersion || response.fenceLastProof !== binding!.fenceLastProof || !string(response.policyVersion) || !Array.isArray(response.policies)) { handshakeState = "failed"; resolve(false); return; }
            const names = new Set<string>();
            for (const item of response.policies) {
              const policy = item as Frame;
              if (!item || typeof item !== "object" || Array.isArray(item) || !string(policy.toolName) || !SAFE_ID.test(String(policy.toolName)) || names.has(String(policy.toolName)) || !(["read_only", "fenced_mutating", "unsupported"] as unknown[]).includes(policy.classification) || (policy.idempotencyParameter !== undefined && (!isSafeParameter(String(policy.idempotencyParameter)) || policy.externalSystemSupportsKey !== true))) { handshakeState = "failed"; resolve(false); return; }
              names.add(String(policy.toolName)); policies.set(String(policy.toolName), policy as unknown as SideEffectFencePolicyDescriptor);
            }
            if (digest([...names].sort()) !== binding!.toolSetDigest) { handshakeState = "failed"; resolve(false); return; }
            try { pi.setActiveTools([...names]); } catch { handshakeState = "failed"; resolve(false); return; }
            connected = true; handshakeState = "succeeded"; resolve(true); continue;
          }
          if (response.type !== "goodbye_ack" && response.type !== "response") { handshakeState = "failed"; disconnect("unknown fence response"); connection?.destroy(); resolve(false); return; }
          const requestId = typeof response.requestId === "string" ? response.requestId : undefined;
          const request = requestId ? pending.get(requestId) : undefined;
          if (!request) { handshakeState = "failed"; disconnect("unexpected fence response"); connection?.destroy(); resolve(false); return; }
          pending.delete(requestId!); clearTimeout(request.timer); request.resolve(response);
        }
      });
      connection.on("error", () => { disconnect("fence channel error"); resolve(false); });
      connection.on("close", () => { disconnect("fence channel closed"); });
    });
    return handshake;
  };
  const block = (reason: string) => ({ block: true, reason: reason.slice(0, 128), terminate: true });
  pi.on("session_start", async (_event, ctx) => { try { pi.setActiveTools([]); } catch { /* remain tool-less */ } if (!await connect(ctx.sessionManager.getSessionId())) { handshakeState = "failed"; ctx.abort(); } });
  pi.on("turn_start", async () => { turns += 1; });
  pi.on("tool_execution_start", async (event) => {
    const item = event as typeof event & { toolCallId: string; toolName: string };
    if (!SAFE_ID.test(item.toolCallId) || !SAFE_ID.test(item.toolName) || starts.has(item.toolCallId)) return;
    const ordinal = sourceOrdinal++;
    starts.set(item.toolCallId, { ordinal, checkpoint: `turn:${turns}:tool:${ordinal}`, toolName: item.toolName });
  });
  pi.on("tool_call", async (event, ctx) => {
    const item = event as typeof event & { toolCallId: string; toolName: string; input: unknown };
    const start = starts.get(item.toolCallId);
    if (!start || !jsonValue(item.input)) return block("side-effect fence source order is unavailable");
    if (handshakeState === "failed" || (!connected && !(await (handshake ?? Promise.resolve(false))))) { ctx.abort(); return block("side-effect fence handshake is unavailable"); }
    const requestId = `prepare:${item.toolCallId}`;
    try {
      const preparedResponse = await send({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "prepare", seq: sequence++, requestId, toolCallId: item.toolCallId, toolName: item.toolName, input: item.input, toolCallOrdinal: start.ordinal, logicalCheckpoint: start.checkpoint });
      if (!(preparedResponse.ok && preparedResponse.handler === 1) || typeof preparedResponse.stableIdempotencyKey !== "string" || !/^[0-9a-f]{64}$/.test(String(preparedResponse.preInjectionArgsDigest)) || typeof preparedResponse.policy !== "string") { ctx.abort(); return block("side-effect prepare ACK unavailable"); }
      const policy = policies.get(item.toolName) ?? { toolName: item.toolName, classification: "unsupported" as const };
      if (preparedResponse.policy !== policy.classification) { ctx.abort(); return block("side-effect policy binding changed"); }
      const finalInput = item.input && typeof item.input === "object" && !Array.isArray(item.input) ? { ...(item.input as Record<string, unknown>) } : item.input;
      const preparedKey = String(preparedResponse.stableIdempotencyKey);
      const preparedParameter = typeof preparedResponse.idempotencyParameter === "string" ? preparedResponse.idempotencyParameter : undefined;
      if (preparedParameter !== undefined) {
        if (policy.idempotencyParameter !== preparedParameter || policy.externalSystemSupportsKey !== true || !isSafeParameter(preparedParameter) || !finalInput || typeof finalInput !== "object" || Array.isArray(finalInput)) { ctx.abort(); return block("side-effect idempotency injection is not proven"); }
        const objectInput = finalInput as Record<string, unknown>;
        if (objectInput[preparedParameter] !== undefined && objectInput[preparedParameter] !== preparedKey) { ctx.abort(); return block("side-effect idempotency field conflicts"); }
        objectInput[preparedParameter] = preparedKey;
        (item as any).input = finalInput;
      }
      const preparedActionId = String(preparedResponse.actionId);
      prepared.set(item.toolCallId, { actionId: preparedActionId, stableIdempotencyKey: preparedKey, preInjectionArgsDigest: String(preparedResponse.preInjectionArgsDigest), ...(preparedParameter ? { idempotencyParameter: preparedParameter } : {}), policy, ordinal: start.ordinal, checkpoint: start.checkpoint, toolName: item.toolName });
      const intentResponse = await send({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "intent", seq: sequence++, requestId: `intent:${item.toolCallId}`, toolCallId: item.toolCallId, toolName: item.toolName, input: (item as any).input, toolCallOrdinal: start.ordinal, logicalCheckpoint: start.checkpoint, preInjectionArgsDigest: String(preparedResponse.preInjectionArgsDigest), stableIdempotencyKey: preparedKey });
      prepared.delete(item.toolCallId);
      if (intentResponse.ok && intentResponse.handler === 1) { allowedActionIds.add(preparedActionId); acceptedActions.set(item.toolCallId, preparedActionId); return; }
      blockedActionIds.add(preparedActionId);
      ctx.abort(); return block(typeof intentResponse.reason === "string" ? intentResponse.reason : "side-effect intent was not durably acknowledged");
    } catch { ctx.abort(); return block("side-effect intent ACK failed"); }
  });
  pi.on("tool_result", async (event, ctx) => {
    const item = event as typeof event & { toolCallId: string; toolName: string; content: unknown; details: unknown; isError: boolean; usage: unknown };
    const start = starts.get(item.toolCallId);
    if (!start || !connected) { ctx.abort(); return { isError: true, content: [{ type: "text", text: "Side-effect result ACK unavailable." }] }; }
    let resultDigest: string; try { resultDigest = digest({ content: item.content, details: item.details, isError: item.isError === true, usage: item.usage }); } catch { ctx.abort(); return { isError: true, content: [{ type: "text", text: "Side-effect result is not safely encodable." }] }; }
    const requestId = `result:${item.toolCallId}`;
    try {
      const response = await send({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "result", seq: sequence++, requestId, toolCallId: item.toolCallId, resultDigest, resultType: `tool:${start.toolName}`, status: item.isError === true ? "failure" : "success" });
      if (response.ok && response.handler === 1) { const actionId = acceptedActions.get(item.toolCallId); if (actionId) { allowedActionIds.delete(actionId); completedActionIds.add(actionId); acceptedActions.delete(item.toolCallId); } return; }
    } catch { /* fail closed below */ }
    ctx.abort(); return { isError: true, content: [{ type: "text", text: "Side-effect result ACK unavailable." }] };
  });
  pi.on("session_shutdown", async () => {
    const closeUnconfirmed = () => { connected = false; try { connection?.end(); } catch { /* channel failure is observed by the supervisor */ } };
    if (handshakeState !== "succeeded" || !connected || pending.size !== 0 || prepared.size !== 0 || allowedActionIds.size !== 0) { closeUnconfirmed(); return; }
    const goodbyeSeq = sequence++;
    try {
      const response = await send({ version: SIDE_EFFECT_FENCE_PROTOCOL, type: "goodbye", seq: goodbyeSeq, requestId: "goodbye", nonce, dispatchCallId: binding!.dispatchCallId, delegationId: binding!.delegationId, executionScope: binding!.executionScope, reservationId: binding!.reservationId, owner: binding!.owner, ownerGeneration: binding!.ownerGeneration, fencingGeneration: binding!.fencingGeneration, childSessionId: activeSessionId, childIdentityRef: digest({ sessionId: activeSessionId, pid: process.pid }), pid: process.pid, completedActionIds: [...completedActionIds], blockedActionIds: [...blockedActionIds], inflight: { prepare: prepared.size, intent: allowedActionIds.size, result: pending.size } });
      const sameIds = (value: unknown, expected: Set<string>): boolean => Array.isArray(value) && new Set(value.filter((item): item is string => typeof item === "string")).size === value.length && value.every((item) => expected.has(item)) && expected.size === value.length;
      const valid = response.type === "goodbye_ack" && response.version === SIDE_EFFECT_FENCE_PROTOCOL && response.requestId === "goodbye" && response.ok === true && response.handler === 1 && response.seq === goodbyeSeq && response.nonce === nonce && response.dispatchCallId === binding!.dispatchCallId && response.delegationId === binding!.delegationId && response.executionScope === binding!.executionScope && response.reservationId === binding!.reservationId && response.owner === binding!.owner && response.ownerGeneration === binding!.ownerGeneration && response.fencingGeneration === binding!.fencingGeneration && response.childSessionId === activeSessionId && response.childIdentityRef === digest({ sessionId: activeSessionId, pid: process.pid }) && response.pid === process.pid && sameIds(response.completedActionIds, completedActionIds) && sameIds(response.blockedActionIds, blockedActionIds);
      if (!valid) { closeUnconfirmed(); return; }
      connected = false;
      try { connection?.end(); } catch { /* supervisor will observe a failed close if the ACK was not delivered */ }
    } catch { closeUnconfirmed(); }
  });
}
