import { createHash } from 'node:crypto';

const COMMENT = /<!--[\s\S]*?-->/g;
const PLACEHOLDER = /^(?:[-*]\s*)?(?:todo|tbd|n\/a|none|待填写|待补充|请填写|请描述|原始目标(?:与(?:已确认)?决定)?|已确认决定|源头规格|original goals?|confirmed decisions?|source (?:spec(?:ification)?|prd)|requirements?|<[^>]+>|\[[^\]]*(?:enter|fill|insert|describe|placeholder|required)[^\]]*\])\s*[:：]?\s*$/iu;
const CLOSE_REFERENCE = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?\s*(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)|#(\d+))/giu;
const LOCAL_ISSUE_URL = /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/issues\/(\d+)(?:\b|\/)/giu;
const MAX_SPEC_PAGES_PER_AXIS = 24;
const meaningful = (text) => {
  const visible = text.replace(COMMENT, '').split(/\r?\n/u)
    .map((line) => line.replace(/^\s{0,3}#{1,6}\s*/u, '').replace(/^\s*[-*+]\s*(?:\[[ xX]\]\s*)?/u, '').trim())
    .filter((line) => line && !PLACEHOLDER.test(line) && !/^(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s*:?[\s#\d/.-]*$/iu.test(line));
  return [...visible.join(' ').replace(/\s+/gu, ' ').trim()].length >= 3;
};
function collectIssueNumbers({ title, body, repository }) {
  const owner = repository.split('/')[0];
  const repoName = repository.split('/')[1];
  const numbers = new Set();
  const text = `${title ?? ''}\n${body ?? ''}`;
  for (const match of text.matchAll(CLOSE_REFERENCE)) {
    const crossRepo = match[1];
    const number = match[2] ?? match[3];
    if (number && (!crossRepo || crossRepo.toLowerCase() === repository.toLowerCase())) numbers.add(Number(number));
  }
  for (const match of text.matchAll(LOCAL_ISSUE_URL)) {
    if (match[1].toLowerCase() === owner.toLowerCase() && match[2].toLowerCase() === repoName.toLowerCase()) numbers.add(Number(match[3]));
  }
  return [...numbers].filter(Number.isSafeInteger).sort((a, b) => a - b);
}
function sourceBody(title, body) { return `# ${title}\n\n${body ?? ''}`; }
function validSourceUrl(value, repository, type, number) {
  try {
    const url = new URL(value);
    const segment = type === 'pull_request' ? 'pull' : 'issues';
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && url.pathname.toLowerCase() === `/${repository}/${segment}/${number}`.toLowerCase();
  } catch { return false; }
}
function sourceIdentity(source) {
  return { type: source.type, id: source.id, number: source.number, title: source.title, url: source.url, updatedAt: source.updatedAt, state: source.state };
}
function fingerprintOf(prSource, issues) {
  const bodyHash = (source) => createHash('sha256').update(source.body ?? '').digest('hex');
  const payload = { pr: { ...sourceIdentity(prSource), bodyHash: bodyHash(prSource) }, issues: issues.map((source) => ({ ...sourceIdentity(source), bodyHash: bodyHash(source) })) };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
export class ReviewSpecError extends Error {
  constructor(code, message) { super(message); this.name = 'ReviewSpecError'; this.code = code; }
}
export async function resolveReviewSpec({ pr, repository, fetchIssue }) {
  if (!pr || !Number.isSafeInteger(pr.number) || typeof pr.title !== 'string' || !pr.updated_at || typeof pr.updated_at !== 'string' || !validSourceUrl(pr.html_url, repository, 'pull_request', pr.number)) throw new ReviewSpecError('SPEC_METADATA_INVALID', 'PR specification metadata is unavailable.');
  const prBody = typeof pr.body === 'string' ? pr.body : '';
  const issueNumbers = collectIssueNumbers({ title: pr.title, body: prBody, repository });
  if (issueNumbers.length > 10) throw new ReviewSpecError('SPEC_REFERENCE_LIMIT', 'PR references more than 10 local source issues; reduce references before review.');
  const prSource = { type: 'pull_request', id: `pr#${pr.number}`, number: pr.number, title: pr.title, url: pr.html_url, updatedAt: pr.updated_at, state: pr.state, body: prBody };
  const issues = [];
  for (const number of issueNumbers) {
    const issue = await fetchIssue(number);
    if (!issue || issue.number !== number || issue.pull_request || typeof issue.title !== 'string' || !issue.updated_at || typeof issue.updated_at !== 'string' || !validSourceUrl(issue.html_url, repository, 'issue', number)) throw new ReviewSpecError('SPEC_ISSUE_UNAVAILABLE', `Referenced local issue #${number} is unavailable as an issue.`);
    issues.push({ type: 'issue', id: `issue#${number}`, number, title: issue.title, url: issue.html_url, updatedAt: issue.updated_at, state: issue.state, body: typeof issue.body === 'string' ? issue.body : '' });
  }
  if (!meaningful(prBody) && !issues.some((issue) => meaningful(`${issue.title}\n${issue.body}`))) throw new ReviewSpecError('SPEC_DESCRIPTION_MISSING', 'PR description has no substantive original goal/decision, and no referenced local issue provides one. Add requirements to the PR description or reference a substantive issue.');
  const sources = [prSource, ...issues].map((source) => ({ ...source, content: sourceBody(source.title, source.body) }));
  let totalBytes = 0;
  for (const source of sources) {
    const bytes = Buffer.byteLength(source.content, 'utf8');
    totalBytes += bytes;
    if (bytes > 200_000 || source.content.split('\n').some((line) => line.length > 16_000)) throw new ReviewSpecError('SPEC_BUDGET_EXCEEDED', `Source ${source.id} exceeds the reviewable source budget.`);
  }
  if (totalBytes > 500_000) throw new ReviewSpecError('SPEC_BUDGET_EXCEEDED', 'Combined PR and issue sources exceed the reviewable source budget.');
  const pages = sources.reduce((sum, source) => sum + Math.ceil(source.content.split('\n').length / 200), 0);
  if (pages > MAX_SPEC_PAGES_PER_AXIS) throw new ReviewSpecError('SPEC_BUDGET_EXCEEDED', 'PR and issue sources require too many pages for the review budget.');
  return { fingerprint: fingerprintOf(prSource, issues), sources, references: issues.map(sourceIdentity) };
}
export function loadReviewSpecification({ pr, repository, request }) {
  return resolveReviewSpec({ pr, repository, fetchIssue: (number) => request(`issues/${number}`) });
}
export { collectIssueNumbers, meaningful as hasMeaningfulSpec, sourceIdentity };
