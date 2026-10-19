import { spawn } from 'node:child_process';
import { readFile, rm, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseOAuthCredential } from './oauth-credential.mjs';
function mask(value, write = process.stdout.write.bind(process.stdout)) { write(`::add-mask::${String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`); }
export async function saveRefreshedAuth({ dir, env = process.env, spawnImpl = spawn, write = process.stdout.write.bind(process.stdout) }) {
  if (!dir || !env.CI_ENVIRONMENT_TOKEN || !env.REPOSITORY) throw new Error('Required persistence configuration is missing');
  if (((await stat(dir)).mode & 0o777) !== 0o700) throw new Error('Unsafe auth directory permissions');
  const authPath = join(dir, 'auth.json');
  if (((await stat(authPath)).mode & 0o777) !== 0o600) throw new Error('Unsafe auth file permissions');
  let provider;
  try { provider = parseOAuthCredential(JSON.parse(await readFile(authPath, 'utf8'))); }
  catch { throw new Error('Refreshed OAuth credential schema invalid'); }
  mask(provider.access, write); mask(provider.refresh, write);
  const payload = JSON.stringify({ 'openai-codex': provider });
  const child = spawnImpl('gh', ['secret', 'set', 'PI_CI_AUTH_JSON', '--env', 'ai-review', '--repo', env.REPOSITORY], { stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: env.PATH, GH_TOKEN: env.CI_ENVIRONMENT_TOKEN } });
  const code = await new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Secret persistence process failed')));
    child.once('close', resolve);
    child.stdin.once('error', () => reject(new Error('Secret persistence input failed')));
    child.stdin.end(payload);
  });
  if (code !== 0) throw new Error('Secret persistence failed');
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, 'saved=true\n');
}
const dir = process.env.PI_CI_AUTH_DIR;
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { await saveRefreshedAuth({ dir }); }
  catch {
    process.stderr.write('AI review credential persistence failed.\n');
    process.exitCode = 1;
  } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
}
