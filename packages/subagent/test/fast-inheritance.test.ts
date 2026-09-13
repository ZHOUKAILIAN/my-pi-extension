import test from "node:test";
import assert from "node:assert/strict";
import {
  FAST_ENV_NAME as PUBLIC_FAST_ENV_NAME,
  FAST_REQUESTED_EVENT as PUBLIC_FAST_REQUESTED_EVENT,
  parseFastRequestedEvent as parsePublicFastRequestedEvent,
} from "@pi/codex-usage-status/interop";
import { FAST_ENV_NAME, FAST_REQUESTED_EVENT, FastInheritanceConsumer, createChildEnvironment, loadFastInterop } from "../src/fast-inheritance.ts";

function bus() {
  const handlers = new Map<string, (value: unknown) => void>();
  return { on: (name: string, handler: (value: unknown) => void) => { handlers.set(name, handler); return () => handlers.delete(name); }, emit: (name: string, value: unknown) => handlers.get(name)?.(value) };
}
const eligible = { name: "implementer", source: "user" as const, codexFast: "inherit" };

test("Fast consumer loads the producer contract through its public package subpath", async () => {
  const interop = await loadFastInterop();
  assert.ok(interop);
  assert.equal(PUBLIC_FAST_ENV_NAME, FAST_ENV_NAME);
  assert.equal(PUBLIC_FAST_REQUESTED_EVENT, FAST_REQUESTED_EVENT);
  assert.deepEqual(interop.parseFastRequestedEvent({ version: 1, sessionId: "parent", requested: true }), {
    version: 1,
    sessionId: "parent",
    requested: true,
  });
  assert.deepEqual(parsePublicFastRequestedEvent({ version: 1, sessionId: "parent", requested: true }), {
    version: 1,
    sessionId: "parent",
    requested: true,
  });
});

test("Fast consumer accepts only exact producer event and exact user agent contract", async () => {
  const events = bus(); const consumer = new FastInheritanceConsumer(events, "parent", await loadFastInterop());
  events.emit(FAST_REQUESTED_EVENT, { version: 1, sessionId: "parent", requested: true });
  await consumer.ready;
  assert.equal(consumer.requestedFast, true);
  assert.equal(consumer.environment(eligible, true).PI_CODEX_FAST, "1");
  assert.equal(consumer.environment(eligible, false)[FAST_ENV_NAME], undefined);
  assert.equal(consumer.environment({ ...eligible, source: "project" }, true)[FAST_ENV_NAME], undefined);
  assert.equal(consumer.environment({ ...eligible, name: "planner" }, true)[FAST_ENV_NAME], undefined);
  assert.equal(consumer.environment({ ...eligible, codexFast: "on" }, true)[FAST_ENV_NAME], undefined);
  consumer.dispose();
});

test("ambient Fast is removed and malformed/session-mismatched events fail closed", async () => {
  const base = { [FAST_ENV_NAME]: "1", KEEP: "yes" };
  const off = createChildEnvironment({ agent: eligible, firstLogicalChildSpawn: true, parentSessionRequestedFast: false, baseEnv: base });
  assert.equal(off[FAST_ENV_NAME], undefined); assert.equal(off.KEEP, "yes");
  const producer = await loadFastInterop();
  assert.ok(producer);
  assert.deepEqual(producer.parseFastRequestedEvent({ version: 1, sessionId: "s", requested: true }), { version: 1, sessionId: "s", requested: true });
  assert.deepEqual(producer.parseFastRequestedEvent({ version: 1, sessionId: "other", requested: true }), { version: 1, sessionId: "other", requested: true });
  for (const value of [null, { version: 1, sessionId: "s", requested: 1 }, { version: 1, sessionId: "s", requested: true, extra: false }]) assert.equal(producer.parseFastRequestedEvent(value), undefined);
});

test("missing producer interop keeps the consumer safely Off", async () => {
  const events = bus();
  const consumer = new FastInheritanceConsumer(events, "parent", Promise.resolve(undefined));
  events.emit(FAST_REQUESTED_EVENT, { version: 1, sessionId: "parent", requested: true });
  await consumer.ready;
  assert.equal(consumer.requestedFast, false);
  assert.equal(consumer.environment(eligible, true)[FAST_ENV_NAME], undefined);
});
