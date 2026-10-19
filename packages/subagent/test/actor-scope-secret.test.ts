import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { actorScopeSecretPath, ensureActorScopeSecret } from "../src/delegation-context.ts";

const exec = promisify(execFile);

async function root(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "actor-secret-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("concurrent same-process initializers return the single durable secret", async (t) => {
  const directory = await root(t);
  const values = await Promise.all(Array.from({ length: 24 }, () => ensureActorScopeSecret(directory)));
  const durable = await fs.readFile(actorScopeSecretPath(directory), "utf8").then((text) => Buffer.from(JSON.parse(text).secret, "hex"));
  assert.equal(durable.length, 32);
  for (const value of values) assert.ok(value.equals(durable), "same-process result must match the durable secret");
});

test("independent processes return one durable secret, not last-writer values", async (t) => {
  const directory = await root(t);
  const moduleUrl = new URL("../src/delegation-context.ts", import.meta.url).href;
  const source = `import { ensureActorScopeSecret } from ${JSON.stringify(moduleUrl)}; const secret = await ensureActorScopeSecret(process.argv[1]); process.stdout.write(secret.toString("hex"));`;
  const children = Array.from({ length: 8 }, () => exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, directory], { encoding: "utf8", timeout: 20_000 }));
  const outcomes = await Promise.allSettled(children);
  const outputs = outcomes.map((outcome) => {
    assert.equal(outcome.status, "fulfilled", "every initializer process must finish before the test cleans up its directory");
    return outcome.value;
  });
  const values = outputs.map(({ stdout }) => Buffer.from(stdout.trim(), "hex"));
  const durable = Buffer.from(JSON.parse(await fs.readFile(actorScopeSecretPath(directory), "utf8")).secret, "hex");
  assert.equal(durable.length, 32);
  for (const value of values) assert.ok(value.equals(durable), "child result must match the durable secret");
});

test("concurrent stale-lock contenders fail closed without stealing the lock or publishing different secrets", async (t) => {
  const directory = await root(t);
  const lockDir = path.join(directory, "v2", "locks");
  await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
  const staleLockPath = path.join(lockDir, "actor-scope-secret-init.lock");
  const exitedOwner = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  assert.ok(exitedOwner.pid);
  const deadPid = exitedOwner.pid;
  await new Promise<void>((resolve, reject) => { exitedOwner.once("error", reject); exitedOwner.once("exit", () => resolve()); });
  await fs.writeFile(staleLockPath, JSON.stringify({
    host: os.hostname(), pid: deadPid, token: "stale-owner", createdAt: new Date(0).toISOString(), child: { state: "idle" },
  }), { mode: 0o600 });

  const moduleUrl = new URL("../src/delegation-context.ts", import.meta.url).href;
  const source = `import { ensureActorScopeSecret } from ${JSON.stringify(moduleUrl)}; try { await ensureActorScopeSecret(process.argv[1]); process.stdout.write("resolved"); } catch { process.stdout.write("rejected"); }`;
  const outcomes = await Promise.allSettled(Array.from({ length: 2 }, () => exec(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source, directory], { encoding: "utf8", timeout: 15_000 })));
  const results = outcomes.map((outcome) => {
    assert.equal(outcome.status, "fulfilled", "both stale-lock contenders must settle before cleanup");
    return outcome.value.stdout;
  });
  assert.deepEqual(results, ["rejected", "rejected"]);
  assert.equal(await fs.readFile(staleLockPath, "utf8"), JSON.stringify({
    host: os.hostname(), pid: deadPid, token: "stale-owner", createdAt: new Date(0).toISOString(), child: { state: "idle" },
  }));
  await assert.rejects(() => fs.access(actorScopeSecretPath(directory)), { code: "ENOENT" });

  await fs.unlink(staleLockPath);
  const recovered = await ensureActorScopeSecret(directory);
  assert.ok(recovered.equals(Buffer.from(JSON.parse(await fs.readFile(actorScopeSecretPath(directory), "utf8")).secret, "hex")), "recovered value must match the durable secret");
});

test("existing valid secret is not rotated; malformed or unsafe existing state fails closed", async (t) => {
  const directory = await root(t);
  const file = actorScopeSecretPath(directory);
  const original = await ensureActorScopeSecret(directory);
  assert.ok((await ensureActorScopeSecret(directory)).equals(original), "valid secret must not rotate");

  const malformedRoot = await root(t);
  const malformedPath = actorScopeSecretPath(malformedRoot);
  await fs.mkdir(path.dirname(malformedPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(malformedPath, JSON.stringify({ version: 1, secret: "not-a-secret" }), { mode: 0o600 });
  await assert.rejects(() => ensureActorScopeSecret(malformedRoot));
  assert.equal(await fs.readFile(malformedPath, "utf8"), JSON.stringify({ version: 1, secret: "not-a-secret" }));

  const linkRoot = await root(t);
  const linkPath = actorScopeSecretPath(linkRoot);
  await fs.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o700 });
  await fs.symlink(file, linkPath);
  await assert.rejects(() => ensureActorScopeSecret(linkRoot));
  assert.equal((await fs.lstat(linkPath)).isSymbolicLink(), true);

  const hardlinkRoot = await root(t);
  const hardlinkPath = actorScopeSecretPath(hardlinkRoot);
  await fs.mkdir(path.dirname(hardlinkPath), { recursive: true, mode: 0o700 });
  const otherPath = path.join(hardlinkRoot, "other");
  await fs.writeFile(otherPath, JSON.stringify({ version: 1, secret: original.toString("hex") }), { mode: 0o600 });
  await fs.link(otherPath, hardlinkPath);
  await assert.rejects(() => ensureActorScopeSecret(hardlinkRoot));
  assert.equal((await fs.stat(otherPath)).nlink, 2);
});

test("unsafe pending state fails closed, releases initialization lock, and can retry after cleanup", async (t) => {
  const directory = await root(t);
  const secretPath = actorScopeSecretPath(directory);
  await fs.mkdir(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  const pending = `${secretPath}.pending`;
  await fs.symlink("/dev/null", pending);
  await assert.rejects(() => ensureActorScopeSecret(directory));
  await assert.rejects(() => fs.stat(path.join(path.dirname(secretPath), "locks", "actor-scope-secret-init.lock")), { code: "ENOENT" });
  await fs.unlink(pending);
  const retried = await ensureActorScopeSecret(directory);
  assert.equal(retried.length, 32);
  assert.ok(retried.equals(Buffer.from(JSON.parse(await fs.readFile(secretPath, "utf8")).secret, "hex")), "retry value must match the durable secret");
});
