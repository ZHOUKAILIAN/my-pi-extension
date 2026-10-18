import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const signalExitCode = (signal) => 128 + (osConstants.signals[signal] ?? 0);

export async function discoverSuiteFiles(root = repoRoot) {
  const packageDirs = (await readdir(join(root, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const files = [];
  for (const name of packageDirs) {
    files.push(...await matchingFiles(join(root, 'packages', name, 'test')));
  }
  files.push(...await matchingFiles(join(root, 'scripts')));
  return files;
}

async function matchingFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
    .map((entry) => join(directory, entry.name)).sort();
}

export async function buildNodeTestCommand({ root = repoRoot, reporter, reporterDestination, additionalFiles = [], rejectTestHooks = false } = {}) {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (packageJson.scripts?.test !== 'node scripts/test-suite.mjs') {
    throw new Error('Unsupported npm test command; expected the shared scripts/test-suite.mjs owner');
  }
  const lifecycleScripts = packageJson.scripts;
  if (rejectTestHooks && (lifecycleScripts.pretest || lifecycleScripts.posttest)) {
    throw new Error('Unsupported npm test lifecycle hook: test:agent requires the pretest/posttest hooks to be absent');
  }
  if (!Array.isArray(additionalFiles) || additionalFiles.some((file) => typeof file !== 'string' || !file || file.startsWith('-'))) {
    throw new Error('Unsupported npm test argument; only additional test file paths are accepted');
  }
  const discoveredFiles = await discoverSuiteFiles(root);
  const files = [...discoveredFiles, ...additionalFiles.map((file) => resolve(root, file))];
  if (!files.length) throw new Error('No Node test files found');
  const nodeArgs = ['--experimental-strip-types'];
  const args = [...nodeArgs];
  if (reporter) args.push(`--test-reporter=${reporter}`);
  if (reporterDestination) args.push(`--test-reporter-destination=${reporterDestination}`);
  args.push('--test', ...discoveredFiles.map((file) => relative(root, file)), ...additionalFiles);
  return { executable: process.execPath, args, files, nodeArgs };
}

export async function launchNativeSuite({ root = repoRoot, additionalFiles = [], captureOutput = false } = {}) {
  const command = await buildNodeTestCommand({ root, additionalFiles });
  return new Promise((done) => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.PI_METRICS_CONFIG;
    const child = spawn(command.executable, command.args, { cwd: root, env: childEnv, stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => done({ code: 127, error, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    child.once('close', (code, signal) => done({ code: signal ? signalExitCode(signal) : code ?? 1, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await launchNativeSuite({ additionalFiles: process.argv.slice(2) });
    if (result.error) process.stderr.write(`${result.error.message}\n`);
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
