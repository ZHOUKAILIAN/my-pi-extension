import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { makeSessionIdentity } from "../src/session-identity.ts";
import { createBridgeTestProofInternal, isBridgeTestProof } from "../src/bridge-internal.ts";
import {
  adoptExistingV1Internal, rollbackAdoptedV1Internal, readDispatchCallInternal, requestCallCleanupInternal, aggregateCapabilityGateInternal,
} from "../src/delegation-internal.ts";
import { canAdoptExistingV1, inspectPreservationPinInternal } from "../src/bridge.ts";

const parentSessionId = "adoption-parent";
const actor = { parentSessionId, activeLineageId: "adoption-lineage", activeBranchAnchor: "adoption-anchor" };

async function fixture(t: TestContext, name = "fixture") {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `subagent-${name}-`));
  const cwd = path.join(rootDir, "cwd"); await fs.mkdir(cwd, { mode: 0o700 });
  const identity = makeSessionIdentity({ parentSessionId, cwd, agentName: "implement", handle: "bridge" });
  const registryDir = path.join(rootDir, "registry"); const sessionDir = path.join(rootDir, "sessions", identity.key);
  await fs.mkdir(registryDir, { recursive: true, mode: 0o700 }); await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(registryDir, `${identity.key}.json`), JSON.stringify({ version: 1, key: identity.key, parentSessionId, agentName: "implement", handle: "bridge", childSessionId: "child", status: "settled", createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:00.000Z", attempts: [] }), { mode: 0o600 });
  await fs.writeFile(path.join(sessionDir, "events.jsonl"), '{"type":"header","version":1}\n{"type":"assistant","text":"opaque"}\n', { mode: 0o600 });
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const proof = createBridgeTestProofInternal(new Date("2026-01-01T00:00:00.000Z"));
  const request = { adoptionKey: name, task: "adopt opaque task", cwd, target: "implement", discoveryScope: "project" as const, actor, v1Handle: "bridge", v1Session: identity.key, bridgeProof: proof };
  const deps = { now: () => new Date("2026-01-01T00:00:00.000Z"), allowTestProof: true, inspectSource: async () => ({ lock: "absent" as const, writer: "absent" as const, child: "dead" as const }) };
  return { rootDir, cwd, identity, request, deps, proof, sessionDir };
}

test("ordinary objects and test proof cannot open production adoption", async (t) => {
  const state = await fixture(t, "forged");
  assert.equal(isBridgeTestProof(state.proof), true);
  assert.equal(canAdoptExistingV1(state.proof), false);
  const forged = { capability: "bridge-v1", version: 1, verified: true, adoptionAllowed: true, bridgeDigest: "a".repeat(64) };
  const trapped = new Proxy(forged, { get() { throw new Error("symbol trap must not be observed"); }, ownKeys() { throw new Error("key trap must not be observed"); } });
  assert.equal(canAdoptExistingV1(trapped), false);
  assert.equal(isBridgeTestProof(new Proxy(state.proof, { get() { throw new Error("test proof trap"); } })), false);
  const rejected = await adoptExistingV1Internal(state.rootDir, { ...state.request, bridgeProof: forged });
  assert.equal(rejected.status, "rejected");
  const testOnlyDisabled = await adoptExistingV1Internal(state.rootDir, state.request, { ...state.deps, allowTestProof: false });
  assert.equal(testOnlyDisabled.status, "rejected");
  assert.equal(await fs.stat(path.join(state.rootDir, "v2", "adoptions", "forged.json")).then(() => true).catch(() => false), false);
});

test("prepared marker survives a fault and resumes without duplicate admission", async (t) => {
  const state = await fixture(t, "prepared-crash");
  await assert.rejects(() => adoptExistingV1Internal(state.rootDir, state.request, { ...state.deps, fault: async (point) => { if (point === "after:adoption_prepared") throw new Error("kill:prepared"); } }));
  const prepared = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "adoptions", "prepared-crash.json"), "utf8")) as Record<string, unknown>;
  assert.equal(prepared.phase, "prepared"); assert.equal(prepared.sourceDigest, undefined); assert.equal(prepared.pinUntil, undefined); assert.equal(prepared.deadline, undefined);
  const resumed = await adoptExistingV1Internal(state.rootDir, state.request, state.deps); assert.equal(resumed.status, "adopted", JSON.stringify(resumed));
  const wal = await fs.readFile(path.join(state.rootDir, "v2", "wal", `${prepared.dispatchCallId}.jsonl`), "utf8");
  assert.equal(wal.split("\n").filter((line) => line.includes('"type":"call_admitted"')).length, 1);
});

test("admission is complete before the source-lock barrier and does not repeat inside it", async (t) => {
  const state = await fixture(t, "lock-barrier"); let observations = 0; let admittedEvents = "";
  const result = await adoptExistingV1Internal(state.rootDir, state.request, { ...state.deps, inspectSource: async () => {
    const files = await fs.readdir(path.join(state.rootDir, "v2", "wal")); const wal = await fs.readFile(path.join(state.rootDir, "v2", "wal", files[0]!), "utf8");
    const types = wal.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { type: string }).type).filter((type) => type === "call_admitted" || type === "delegation_admitted").join(",");
    if (observations === 0) admittedEvents = types; else assert.equal(types, admittedEvents); observations += 1;
    return { lock: "absent" as const, writer: "absent" as const, child: "dead" as const };
  } });
  assert.equal(result.status, "adopted", JSON.stringify(result)); assert.ok(observations > 0); assert.equal(admittedEvents, "call_admitted,delegation_admitted");
});

test("adoption refreshes the preservation pin through the durable 30-day deadline", async (t) => {
  const state = await fixture(t, "clock-advance"); let reads = 0; const base = new Date("2026-01-01T00:00:00.000Z");
  const result = await adoptExistingV1Internal(state.rootDir, state.request, { ...state.deps, now: () => new Date(base.getTime() + (reads++ > 6 ? 2_000 : 0)) });
  assert.equal(result.status, "adopted", JSON.stringify(result)); assert.ok(result.deadline);
  const deadline = Date.parse(result.deadline!); const record = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "adoptions", "clock-advance.json"), "utf8")) as { adoptedAt: string };
  const pin = await inspectPreservationPinInternal({ rootDir: state.rootDir, sourceHash: state.identity.key }, state.deps);
  assert.equal(pin.state, "valid"); assert.ok(pin.pin); assert.ok(deadline >= Date.parse(record.adoptedAt) + 30 * 24 * 60 * 60 * 1000); assert.ok(Date.parse(pin.pin!.pinUntil) >= deadline);
});

test("adoption pins before copying, copies an independent namespace, and is idempotent", async (t) => {
  const state = await fixture(t, "adopted");
  const first = await adoptExistingV1Internal(state.rootDir, state.request, state.deps);
  assert.equal(first.status, "adopted", JSON.stringify(first));
  assert.ok(first.v2Namespace);
  assert.equal(await fs.stat(path.join(first.v2Namespace!, "branch", "events.jsonl")).then(() => true).catch(() => false), true);
  assert.equal(first.v2Namespace!.includes(`${path.sep}sessions${path.sep}`), false);
  assert.equal((await inspectPreservationPinInternal({ rootDir: state.rootDir, sourceHash: state.identity.key }, state.deps)).state, "valid");
  const second = await adoptExistingV1Internal(state.rootDir, state.request, state.deps);
  assert.equal(second.status, "already_adopted");
  assert.equal(second.v2Namespace, first.v2Namespace);
});

test("malformed, symlinked, hardlinked, live, and unknown sources fail closed", async (t) => {
  const malformed = await fixture(t, "malformed");
  await fs.writeFile(path.join(malformed.sessionDir, "events.jsonl"), "not-json\n", { mode: 0o600 });
  assert.equal((await adoptExistingV1Internal(malformed.rootDir, malformed.request, malformed.deps)).status, "rejected");

  const linked = await fixture(t, "hardlink");
  await fs.link(path.join(linked.sessionDir, "events.jsonl"), path.join(linked.sessionDir, "copy.jsonl"));
  assert.equal((await adoptExistingV1Internal(linked.rootDir, linked.request, linked.deps)).status, "rejected");

  const symlinked = await fixture(t, "symlink");
  await fs.rename(path.join(symlinked.sessionDir, "events.jsonl"), path.join(symlinked.sessionDir, "events.old"));
  await fs.symlink(path.join(symlinked.sessionDir, "events.old"), path.join(symlinked.sessionDir, "events.jsonl"));
  assert.equal((await adoptExistingV1Internal(symlinked.rootDir, symlinked.request, symlinked.deps)).status, "rejected");

  const live = await fixture(t, "live");
  await fs.writeFile(path.join(live.rootDir, "registry", `${live.identity.key}.json`), JSON.stringify({ version: 1, key: live.identity.key, parentSessionId, agentName: "implement", handle: "bridge", childSessionId: "child", status: "running", createdAt: "2026-01-01T00:00:00.000Z", lastActivityAt: "2026-01-01T00:00:00.000Z", attempts: [] }), { mode: 0o600 });
  const liveResult = await adoptExistingV1Internal(live.rootDir, live.request, { ...live.deps, inspectSource: async () => ({ lock: "absent", writer: "live", child: "live" }) });
  assert.equal(liveResult.status, "rejected");

  const unknown = await fixture(t, "unknown");
  const unknownResult = await adoptExistingV1Internal(unknown.rootDir, unknown.request, { ...unknown.deps, inspectSource: async () => ({ lock: "unknown", writer: "unknown", child: "unknown" }) });
  assert.equal(unknownResult.status, "rejected");
});

test("concurrent adoption has one durable winner and rollback freezes before legacy resume", async (t) => {
  const state = await fixture(t, "concurrent");
  const results = await Promise.all([adoptExistingV1Internal(state.rootDir, state.request, state.deps), adoptExistingV1Internal(state.rootDir, state.request, state.deps)]);
  assert.deepEqual(results.map((item) => item.status).sort(), ["adopted", "already_adopted"]);
  const failed = await rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "live", child: "dead", action: "zero", outbox: "idle", cleanup: "idle" }) });
  assert.equal(failed.status, "frozen");
  const retry = await rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "dead", child: "dead", action: "zero", outbox: "idle", cleanup: "idle" }) });
  assert.equal(retry.status, "frozen");
  const successfulState = await fixture(t, "rollback");
  await adoptExistingV1Internal(successfulState.rootDir, successfulState.request, successfulState.deps);
  const rolled = await rollbackAdoptedV1Internal(successfulState.rootDir, successfulState.request.adoptionKey, actor, successfulState.proof, { ...successfulState.deps, inspectV2: async () => ({ owner: "dead", child: "dead", action: "zero", outbox: "idle", cleanup: "idle" }) });
  assert.equal(rolled.status, "rolled_back", JSON.stringify(rolled));
  assert.equal(rolled.disposition, "legacy_v1_explicit_handle_only");
  assert.equal(await fs.stat(successfulState.sessionDir).then(() => true).catch(() => false), true);
  assert.equal((await inspectPreservationPinInternal({ rootDir: successfulState.rootDir, sourceHash: successfulState.identity.key }, successfulState.deps)).state, "absent");
  assert.equal(await fs.stat(path.join(successfulState.rootDir, "v2", "quarantine", successfulState.request.adoptionKey)).then(() => true).catch(() => false), true);
  const record = JSON.parse(await fs.readFile(path.join(successfulState.rootDir, "v2", "adoptions", `${successfulState.request.adoptionKey}.json`), "utf8")) as { dispatchCallId: string };
  assert.equal((await readDispatchCallInternal(successfulState.rootDir, record.dispatchCallId))?.adoptionRollbackFrozen, true);
});

test("rollback quarantine plan and rename/ledger faults converge to one rolled_back destination", async (t) => {
  for (const point of ["before:adoption_rollback_quarantine_rename", "after:adoption_rollback_quarantine_rename", "after:adoption_rolled_back"]) {
    const state = await fixture(t, `rollback-${point.replaceAll(":", "-")}`);
    assert.equal((await adoptExistingV1Internal(state.rootDir, state.request, state.deps)).status, "adopted");
    let tripped = false;
    await assert.rejects(() => rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "dead" as const, child: "dead" as const, action: "zero" as const, outbox: "idle" as const, cleanup: "idle" as const }), fault: async (actual) => { if (!tripped && actual === point) { tripped = true; throw new Error(`kill:${point}`); } } }));
    const resumed = await rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "dead" as const, child: "dead" as const, action: "zero" as const, outbox: "idle" as const, cleanup: "idle" as const }) });
    assert.ok(["rolled_back", "already_rolled_back"].includes(resumed.status), `${point}: ${JSON.stringify(resumed)}`);
    const record = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "adoptions", `${state.request.adoptionKey}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(record.phase, "rolled_back"); assert.equal(typeof record.rollbackSourceNamespaceDigest, "string"); assert.equal(typeof record.rollbackDestinationRelative, "string");
    assert.equal(await fs.stat(state.sessionDir).then(() => true).catch(() => false), true);
    assert.equal(await fs.stat(path.join(state.rootDir, "v2", "adopted-sessions", state.request.adoptionKey)).then(() => true).catch(() => false), false);
    assert.equal(await fs.stat(path.join(state.rootDir, "v2", "quarantine", state.request.adoptionKey)).then(() => true).catch(() => false), true);
    assert.deepEqual((await fs.readdir(path.join(state.rootDir, "v2", "quarantine"))).filter((name) => name === state.request.adoptionKey), [state.request.adoptionKey]);
    const recordWal = await fs.readFile(path.join(state.rootDir, "v2", "wal", `${record.dispatchCallId}.jsonl`), "utf8");
    assert.equal(recordWal.split("\n").filter((line) => line.includes('"type":"adoption_rollback_quarantine_planned"')).length, 1, recordWal);
    const repeated = await rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "dead" as const, child: "dead" as const, action: "zero" as const, outbox: "idle" as const, cleanup: "idle" as const }) });
    assert.equal(repeated.status, "already_rolled_back");
  }
});

test("ambiguous quarantine state is paused without overwriting either namespace", async (t) => {
  const state = await fixture(t, "rollback-both-present");
  assert.equal((await adoptExistingV1Internal(state.rootDir, state.request, state.deps)).status, "adopted");
  await assert.rejects(() => rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "dead" as const, child: "dead" as const, action: "zero" as const, outbox: "idle" as const, cleanup: "idle" as const }), fault: async (point) => { if (point === "before:adoption_rollback_quarantine_rename") throw new Error("kill:planned"); } }));
  const source = path.join(state.rootDir, "v2", "adopted-sessions", state.request.adoptionKey); const destination = path.join(state.rootDir, "v2", "quarantine", state.request.adoptionKey);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(destination, "sentinel"), "must-not-be-overwritten", { mode: 0o600 });
  const result = await rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "dead" as const, child: "dead" as const, action: "zero" as const, outbox: "idle" as const, cleanup: "idle" as const }) });
  assert.equal(result.status, "paused_integrity"); assert.equal(await fs.readFile(path.join(destination, "sentinel"), "utf8"), "must-not-be-overwritten"); assert.equal(await fs.stat(source).then(() => true).catch(() => false), true);
});

test("cleanup remains WAL=0 for prepared and every non-terminal adoption phase", async (t) => {
  const cases: Array<[string, "prepared" | "adopted" | "rollback_failed" | "rollback_frozen"]> = [["prepared-cleanup", "prepared"], ["adopted-cleanup", "adopted"], ["failed-cleanup", "rollback_failed"], ["frozen-cleanup", "rollback_frozen"]];
  for (const [name, phase] of cases) {
    const state = await fixture(t, name); let record: Record<string, unknown>;
    if (phase === "prepared") {
      await assert.rejects(() => adoptExistingV1Internal(state.rootDir, state.request, { ...state.deps, fault: async (point) => { if (point === "after:adoption_prepared") throw new Error("kill:prepared"); } }));
    } else {
      assert.equal((await adoptExistingV1Internal(state.rootDir, state.request, state.deps)).status, "adopted");
      if (phase === "rollback_failed") await rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "live" as const, child: "dead" as const, action: "zero" as const, outbox: "idle" as const, cleanup: "idle" as const }) });
      if (phase === "rollback_frozen") await assert.rejects(() => rollbackAdoptedV1Internal(state.rootDir, state.request.adoptionKey, actor, state.proof, { ...state.deps, inspectV2: async () => ({ owner: "dead" as const, child: "dead" as const, action: "zero" as const, outbox: "idle" as const, cleanup: "idle" as const }), fault: async (point) => { if (point === "after:adoption_rollback_frozen") throw new Error("kill:frozen"); } }));
    }
    record = JSON.parse(await fs.readFile(path.join(state.rootDir, "v2", "adoptions", `${name}.json`), "utf8")); assert.equal(record.phase, phase);
    const walPath = path.join(state.rootDir, "v2", "wal", `${record.dispatchCallId}.jsonl`); const before = await fs.readFile(walPath, "utf8").catch(() => undefined);
    const blocked = await requestCallCleanupInternal(state.rootDir, String(record.dispatchCallId), { parentSessionId: String(record.parentSessionId), activeLineageId: String(record.activeLineageId), activeBranchAnchor: String(record.activeBranchAnchor) }, "explicit_delete", { lineage: record.lineage as any });
    assert.equal(blocked.status, "rejected"); assert.equal(await fs.readFile(walPath, "utf8").catch(() => undefined), before);
  }
});

test("capability aggregation is a closed false gate", () => {
  const gate = aggregateCapabilityGateInternal({ bridge: { verified: true }, adoption: { verified: true }, sideEffectFenceDeployment: { verified: true }, darwinProcessProof: { verified: true }, deliveryHost: { verified: true }, controlAdapters: { verified: true }, providerOsE2E: { verified: true } });
  assert.equal(gate.enabled, false);
  assert.equal(gate.publicV2, false);
  assert.equal(gate.rootWiring, 0);
  assert.deepEqual(gate.missing, ["bridge", "adoption", "sideEffectFenceDeployment", "darwinProcessProof", "deliveryHost", "controlAdapters", "providerOsE2E"]);
});
