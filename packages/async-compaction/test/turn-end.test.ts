import test from "node:test";
import assert from "node:assert/strict";
import { hasCompletedToolTurn } from "../src/tool-turn.ts";

const calls = [
  { type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
  { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "b.ts" } },
];
const assistant = { role: "assistant", content: calls, stopReason: "toolUse" };
const results = [
  { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false },
  // A protocol-complete business error remains a completed host tool result.
  { role: "toolResult", toolCallId: "edit-1", toolName: "edit", isError: false },
];
const branch = [
  { id: "assistant-entry", type: "message", message: assistant },
  { id: "read-entry", type: "message", message: results[0] },
  { id: "edit-entry", type: "message", message: results[1] },
];
const event = (overrides: Record<string, unknown> = {}) => ({
  message: assistant, outcome: "completed", toolResults: results,
  messageEntryId: "assistant-entry", toolResultEntryIds: ["read-entry", "edit-entry"], ...overrides,
});

test("accepts only fully successful persisted multi-tool turns with matching assistant calls and results", () => {
  assert.equal(hasCompletedToolTurn(event() as any, branch), true);
  assert.equal(hasCompletedToolTurn(event({ toolResults: [results[0], { ...results[1], isError: true }] }) as any, branch), false, "a business-error result rejects the complete turn");
  assert.equal(hasCompletedToolTurn(event() as any, branch.map((entry, index) => index === 2 ? { ...entry, message: { ...entry.message, isError: true } } : entry)), false, "persisted error result rejects even if event metadata claims success");
  assert.equal(hasCompletedToolTurn(event({ toolResults: [{ ...results[0] }, { ...results[1], toolCallId: "other" }] }) as any, branch), false, "wrong call ID");
  assert.equal(hasCompletedToolTurn(event({ toolResultEntryIds: ["read-entry", "read-entry"] }) as any, branch), false, "duplicate result entry ID");
  assert.equal(hasCompletedToolTurn(event({ toolResultEntryIds: ["read-entry", "missing"] }) as any, branch), false, "unpersisted result");
  assert.equal(hasCompletedToolTurn(event({ toolResultEntryIds: ["read-entry", "assistant-entry"] }) as any, branch), false, "IDs must identify tool-result entries, not merely any branch entry");
  assert.equal(hasCompletedToolTurn(event({ messageEntryId: "read-entry" }) as any, branch), false, "message ID must identify persisted assistant message");
  assert.equal(hasCompletedToolTurn(event({ message: { ...assistant, content: [] } }) as any, branch), false, "toolUse without tool calls");
  assert.equal(hasCompletedToolTurn(event({ toolResults: [results[0]] }) as any, branch), false, "missing result");
  assert.equal(hasCompletedToolTurn(event({ toolResults: [results[0], null] }) as any, branch), false, "malformed result fails closed");
  assert.equal(hasCompletedToolTurn(event({ toolResultEntryIds: undefined }) as any, branch), false, "missing persisted result IDs fail closed");
  assert.equal(hasCompletedToolTurn(event({ toolResults: [results[0], { ...results[1], toolCallId: "read-1" }] }) as any, branch), false, "duplicate result call ID");
  assert.equal(hasCompletedToolTurn(event({ outcome: "aborted" }) as any, branch), false);
  assert.equal(hasCompletedToolTurn(event({ message: { ...assistant, stopReason: "error" } }) as any, branch), false);
  assert.equal(hasCompletedToolTurn(event({ message: { ...assistant, stopReason: "length" } }) as any, branch), false);
});

test("rejects duplicate call IDs and branch entries with mismatched persisted message kinds", () => {
  const duplicateCalls = [{ ...calls[0] }, { ...calls[1], id: calls[0].id }];
  assert.equal(hasCompletedToolTurn(event({ message: { ...assistant, content: duplicateCalls } }) as any, branch), false);
  assert.equal(hasCompletedToolTurn(event() as any, branch.map((entry, i) => i === 2 ? { ...entry, type: "custom" } : entry)), false);
  assert.equal(hasCompletedToolTurn(event() as any, branch.map((entry, i) => i === 2 ? { ...entry, message: { ...entry.message, toolCallId: "wrong" } } : entry)), false);
});
