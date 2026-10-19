import { readFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { authorizeTrigger } from './policy.mjs';
import { githubRequest } from './github-api.mjs';
import { validateReviewPreflight } from './review-preflight.mjs';

export async function authorize({ env = process.env, fetchImpl = fetch, git = execFileSync } = {}) {
  const event = JSON.parse(await readFile(env.EVENT_PATH, 'utf8'));
  const repo = env.REPOSITORY;
  const decision = authorizeTrigger({ event, eventName: env.EVENT_NAME, actor: env.ACTOR, triggeringActor: env.TRIGGERING_ACTOR, repository: repo, inputPr: env.INPUT_PR });
  if (!decision.eligible) throw new Error('Unauthorized trigger');
  const api = (path, options = {}) => githubRequest({ fetchImpl, repo, token: env.GH_TOKEN, path, options });
  const pr = await api(`pulls/${decision.number}`);
  const head = pr.head?.sha;
  if (!head || !/^[0-9a-f]{40}$/i.test(head)) throw new Error('PR head SHA is invalid');
  await api(`statuses/${head}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'pending', context: 'ai-review / result', description: 'AI review in progress' }) });
  const main = await api('branches/main');
  const { base } = validateReviewPreflight({ pr, main, repository: repo, expectedHead: head, expectedBase: pr.base?.sha, expectedNumber: decision.number, dispatch: decision.dispatch });
  git('git', ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', base, head], { stdio: 'ignore' });
  git('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' });
  const outputs = { eligible: 'true', pr: decision.number, head, base, dispatch: String(decision.dispatch) };
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([k,v]) => `${k}=${v}\n`).join(''));
  for (const [key, value] of Object.entries(outputs)) process.stdout.write(`${key}=${value}\n`);
  return outputs;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { await authorize(); } catch {
    process.stderr.write('AI review authorization failed.\n');
    const env = process.env;
    if (env.GITHUB_OUTPUT) await import('node:fs/promises').then(({ appendFile }) => appendFile(env.GITHUB_OUTPUT, 'eligible=false\n'));
    try {
      const event = JSON.parse(await readFile(env.EVENT_PATH, 'utf8'));
      let sha = event.pull_request?.head?.sha ?? event.after;
      if (!sha && env.EVENT_NAME === 'workflow_dispatch' && /^\d+$/.test(env.INPUT_PR ?? '')) {
        const prResponse = await fetch(`https://api.github.com/repos/${env.REPOSITORY}/pulls/${env.INPUT_PR}`, { headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } });
        if (prResponse.ok) sha = (await prResponse.json()).head?.sha;
      }
      if (sha && /^[0-9a-f]{40}$/i.test(sha) && env.REPOSITORY && env.GH_TOKEN) await fetch(`https://api.github.com/repos/${env.REPOSITORY}/statuses/${sha}`, { method: 'POST', headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify({ state: 'failure', context: 'ai-review / result', description: 'AI review BLOCKED: authorization failed' }) });
    } catch { /* Leave no success signal if status publication is unavailable. */ }
    process.exitCode = 1;
  }
}
