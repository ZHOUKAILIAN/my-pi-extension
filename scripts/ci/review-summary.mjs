import { createPublicReportProjector } from './public-report.mjs';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const runUrl = (env) => `${env.GITHUB_SERVER_URL || 'https://github.com'}/${env.REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
const defaultSpec = { fingerprint: '', sources: [] };
const defaultAppend = (env) => async (text) => (await import('node:fs/promises')).appendFile(env.GITHUB_STEP_SUMMARY, text);
function safeGitHubLink(value, project) {
  const url = project(value);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+$/iu.test(parsed.pathname)) return 'source';
    return `<a href="${escapeHtml(url)}">source</a>`;
  } catch { return escapeHtml(url); }
}
export function formatCandidateSummary(result, spec = defaultSpec, { knownSecrets = [] } = {}) {
  const project = createPublicReportProjector(knownSecrets);
  const pub = (value) => escapeHtml(project(value));
  const rows = result.reviews.map((review) => {
    const findings = review.findings.length ? `<ul>${review.findings.map((finding) => `<li><b>${pub(finding.severity)}</b> ${pub(finding.path)}:${pub(finding.line ?? '—')} — ${pub(finding.impact)}<br>Must fix: ${finding.mustFix ? 'yes' : 'no'}<br>Evidence: ${pub(finding.evidence)}<br>Closure: ${pub(finding.closure)}</li>`).join('')}</ul>` : '<p>No findings reported.</p>';
    const reason = review.reason ? `<p><b>Reason:</b> ${pub(review.reason)}</p>` : '';
    const uncovered = review.uncovered.length ? `<ul>${review.uncovered.map((item) => `<li>${pub(item)}</li>`).join('')}</ul>` : '<p>None</p>';
    const coverage = review.coverage.map((item) => `${project(item.source)}:${project(item.path ?? 'diff')}:${project(item.start)}-${project(item.end)} ${project(item.note)}`).join('\n');
    return `<h3>${pub(review.axis)} — ${pub(review.status)}</h3>${reason}${findings}<b>Uncovered</b>${uncovered}<details><summary>Coverage ranges</summary><pre>${escapeHtml(coverage)}</pre></details>`;
  }).join('\n');
  const sources = spec.sources.length ? `<ul>${spec.sources.map((source) => `<li>${pub(source.type)} ${pub(source.id)} (${safeGitHubLink(source.url, project)}; updated ${pub(source.updatedAt)})</li>`).join('')}</ul>` : '<p>None</p>';
  const html = `<h2>AI review candidate — not finalized</h2><p>Result: ${pub(result.status)}; head: <code>${pub(result.head)}</code>; base: <code>${pub(result.base)}</code>; model: <code>${pub(result.model)}</code></p><h3>Source specification</h3><p>Fingerprint: <code>${pub(spec.fingerprint)}</code></p>${sources}${rows}<p>Final status is published only after credential persistence and fresh snapshot verification.</p>`;
  if (Buffer.byteLength(html, 'utf8') > 900_000) throw new Error('Review summary exceeds the safe output limit');
  return html;
}
export async function appendCandidateSummary(result, env, append = defaultAppend(env), spec = defaultSpec, options = {}) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  await append(`${formatCandidateSummary(result, spec, options)}\n`);
}
export async function appendFinalSummary(state, env, append = defaultAppend(env), { knownSecrets = [] } = {}) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const project = createPublicReportProjector(knownSecrets);
  const label = state === 'publishing' ? 'Final checks passed; success status publication pending' : state === 'success' ? 'Finalized: success' : 'Finalized: failure / blocked';
  const url = project(runUrl(env));
  await append(`<h2>${escapeHtml(project(label))}</h2><p>Run: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>\n`);
}
export async function appendBlockedSummary(message, env, append = defaultAppend(env), { knownSecrets = [] } = {}) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const project = createPublicReportProjector(knownSecrets);
  await append(`<h2>AI review BLOCKED before model invocation</h2><p>${escapeHtml(project(message))}</p>\n`);
}
export { runUrl };
