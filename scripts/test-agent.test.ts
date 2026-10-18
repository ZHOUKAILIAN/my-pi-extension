import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from 'node-test-brief/cli';
import { runTests } from 'node-test-brief';
import { buildNodeTestCommand, discoverSuiteFiles } from './test-suite.mjs';

async function fixture({ git = true, tests = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'node-test-brief-consumer-'));
  await mkdir(join(root, 'packages', 'fixture', 'test'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node scripts/test-suite.mjs' } }));
  if (tests) {
    await writeFile(join(root, 'scripts', 'base.test.ts'), "import test from 'node:test'; test('base discovered test', () => {});\n");
    await writeFile(join(root, 'packages', 'fixture', 'test', 'package.test.ts'), "import test from 'node:test'; test('package discovered test', () => {});\n");
  }
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function runProjectAgent(root: string, argv: string[] = []) {
  const agentUrl = new URL('./test-agent.mjs', import.meta.url).href;
  const source = `import { runAgentTests } from ${JSON.stringify(agentUrl)}; try { await runAgentTests({ root: ${JSON.stringify(root)}, argv: ${JSON.stringify(argv)} }); } catch (error) { console.error(error.message); process.exitCode = 2; }`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8' });
}

test('project adapter passes full discovered scope and extra failure to the installed CLI', async () => {
  const f = await fixture();
  const extra = join(f.root, 'extra.test.mjs');
  await writeFile(extra, "import test from 'node:test'; test('extra failure executed', () => { throw new Error('EXTRA_EXECUTED'); });\n");
  try {
    const command = await buildNodeTestCommand({ root: f.root });
    assert.deepEqual(command.files, await discoverSuiteFiles(f.root));
    assert.deepEqual(command.nodeArgs, ['--experimental-strip-types']);
    const result = runProjectAgent(f.root, [extra]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /tests=3/);
    assert.match(result.stdout, /EXTRA_EXECUTED|extra failure executed/);
  } finally { await f.cleanup(); }
});

test('project entry rejects unsupported flags and npm lifecycle hooks', async () => {
  const f = await fixture();
  try {
    await assert.rejects(buildNodeTestCommand({ root: f.root, additionalFiles: ['--test-reporter=tap'] }), /only additional test file paths/);
    assert.notEqual(await runCli({ argv: ['--unknown-option'], cwd: f.root, files: [], nodeArgs: [], snapshot: 'git' }), 0);
    const manifestPath = join(f.root, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.scripts.pretest = 'echo forbidden';
    manifest.scripts.posttest = 'echo forbidden';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(buildNodeTestCommand({ root: f.root, rejectTestHooks: true }), /pretest\/posttest hooks/);
    const result = runProjectAgent(f.root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pretest\/posttest hooks/);
  } finally { await f.cleanup(); }
});

test('arguments after -- treat --help and -h as files, preserving discovered failures', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'scripts', 'base.test.ts'), "import test from 'node:test'; test('ordinary discovered failure', () => { throw new Error('DISCOVERED_FAILURE'); });\n");
  await writeFile(join(f.root, '--help'), "import test from 'node:test'; test('file named --help passes', () => {});\n");
  await writeFile(join(f.root, '-h'), "import test from 'node:test'; test('file named -h passes', () => {});\n");
  try {
    for (const filename of ['--help', '-h']) {
      const result = runProjectAgent(f.root, ['--', filename]);
      assert.equal(result.status, 1, `${filename} must not switch to help mode`);
      assert.match(result.stdout, /tests=3/);
      assert.match(result.stdout, /DISCOVERED_FAILURE|ordinary discovered failure/);
    }
  } finally { await f.cleanup(); }
});

test('arguments after -- do not bypass lifecycle-hook rejection', async () => {
  const f = await fixture();
  await writeFile(join(f.root, '--help'), "import test from 'node:test'; test('file named --help passes', () => {});\n");
  try {
    const manifestPath = join(f.root, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.scripts.pretest = 'echo forbidden';
    manifest.scripts.posttest = 'echo forbidden';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = runProjectAgent(f.root, ['--', '--help']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pretest\/posttest hooks/);
  } finally { await f.cleanup(); }
});

test('project entry requires Git snapshot and rejects attempts to turn it off', async () => {
  const f = await fixture({ git: false });
  try {
    const defaultResult = runProjectAgent(f.root);
    assert.notEqual(defaultResult.status, 0);
    assert.match(defaultResult.stdout + defaultResult.stderr, /snapshot\(start\)=unavailable|CHANGED\/UNAVAILABLE/i);
    const downgradedResult = runProjectAgent(f.root, ['--snapshot', 'off']);
    assert.notEqual(downgradedResult.status, 0);
    assert.match(downgradedResult.stderr, /Git snapshot validation/);
  } finally { await f.cleanup(); }
});

test('project help works without discovering tests for both help flags', async () => {
  const f = await fixture({ git: false, tests: false });
  try {
    for (const flag of ['--help', '-h']) {
      const result = runProjectAgent(f.root, [flag]);
      assert.equal(result.status, 0, `${flag} should not require discovered tests`);
      assert.match(result.stdout, /Usage: node-test-brief/);
      assert.doesNotMatch(result.stderr, /No Node test files found/);
    }
    const fWithTests = await fixture({ git: false });
    try {
      for (const [argv, diagnostic] of [
        [['--unknown-option', '--help'], /Unsupported option/],
        [['--timeout', '--help'], /Invalid timeout duration/],
        [['--snapshot', 'invalid', '--help'], /snapshot must be git or off/],
      ] as const) {
        const helperFailure = runProjectAgent(fWithTests.root, [...argv]);
        assert.equal(helperFailure.status, 2);
        assert.match(helperFailure.stderr, diagnostic);
      }
    } finally { await fWithTests.cleanup(); }

    const cliPath = fileURLToPath(new URL('./test-agent.mjs', import.meta.url));
    const cliFailure = spawnSync(process.execPath, [cliPath, '--unknown-option', '--help'], { encoding: 'utf8' });
    assert.equal(cliFailure.status, 2);
    assert.match(cliFailure.stderr, /Unsupported option/);
  } finally { await f.cleanup(); }
});

test('the installed package API executes tests without printing or adding process signal listeners', async () => {
  const f = await fixture();
  try {
    const file = join(f.root, 'scripts', 'base.test.ts');
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const result = await runTests({ cwd: f.root, files: [file], nodeArgs: ['--experimental-strip-types'], snapshot: 'git' });
    assert.equal(result.ok, true);
    assert.equal(result.report.tests, 1);
    assert.deepEqual({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }, before);
  } finally { await f.cleanup(); }
});
