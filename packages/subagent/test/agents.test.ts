import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../src/agents.ts";

test("agent discovery preserves project override and parses policy fields", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "agents-test-"));
  const dir = path.join(cwd, ".pi", "agents"); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "implementer.md"), `---\nname: implementer\ndescription: do work\ntools: [read, bash]\nmodel: model-a\nfallback-models: model-b, model-c\npersistent: false\ncodexFast: inherit\n---\nSystem instructions\n`);
  const found = discoverAgents(cwd, "project");
  assert.equal(found.agents[0].persistent, false);
  assert.deepEqual(found.agents[0].tools, ["read", "bash"]);
  assert.deepEqual(found.agents[0].fallbackModels, ["model-b", "model-c"]);
  assert.equal(found.agents[0].codexFast, "inherit");
  await fs.rm(cwd, { recursive: true, force: true });
});
