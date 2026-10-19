export const REVIEW_AXES = ['five-layer consistency', 'code review'];
export const REVIEW_STATUSES = new Set(['PASSED', 'CHANGES_REQUESTED', 'BLOCKED', 'NOT_APPLICABLE']);
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const exactKeys = (value, keys) => value && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export function validateAxisResult(value, axis, { changedPaths }) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(exactKeys(value, ['status','findings','uncovered','coverage','reason']) || exactKeys(value, ['axis','status','findings','uncovered','coverage','reason']) && value.axis === axis)) return ['result must have the exact axis-result schema'];
  if (typeof value.reason !== 'string') errors.push('reason must be a string');
  if (!REVIEW_STATUSES.has(value.status)) errors.push('invalid status');
  if (!Array.isArray(value.findings) || !Array.isArray(value.uncovered) || !Array.isArray(value.coverage) || value.coverage.length === 0) errors.push('findings, uncovered and non-empty coverage arrays are required');
  for (const f of Array.isArray(value.findings) ? value.findings : []) {
    if (!exactKeys(f, ['severity','path','line','evidence','impact','closure','mustFix']) || !['P0','P1','P2'].includes(f.severity) || !nonEmpty(f.path) || !(f.line === null || Number.isSafeInteger(f.line) && f.line > 0) || !nonEmpty(f.evidence) || !nonEmpty(f.impact) || !nonEmpty(f.closure) || typeof f.mustFix !== 'boolean') errors.push('invalid finding schema');
  }
  for (const item of Array.isArray(value.uncovered) ? value.uncovered : []) if (!nonEmpty(item)) errors.push('uncovered entries must be non-empty strings');
  for (const item of Array.isArray(value.coverage) ? value.coverage : []) {
    if (!exactKeys(item, ['source','path','start','end','note']) || !['diff','file','spec'].includes(item.source) || !(item.path === null || nonEmpty(item.path)) || !Number.isSafeInteger(item.start) || item.start < 1 || !Number.isSafeInteger(item.end) || item.end < item.start || !nonEmpty(item.note) || item.source === 'diff' && item.path !== null || item.source !== 'diff' && !nonEmpty(item.path)) errors.push('coverage entries must identify an exact source range');
  }
  if (value.status === 'NOT_APPLICABLE') {
    const docsOnly = changedPaths.length > 0 && changedPaths.every((p) => p.toLowerCase().endsWith('.md'));
    if (axis !== 'code review' || !docsOnly || !nonEmpty(value.reason)) errors.push('NOT_APPLICABLE is not allowed for authoritative changed paths');
  }
  return errors;
}
function expectedAggregateStatus(reviews) {
  const blocked = reviews.some((review, index) => {
    if (!review || typeof review !== 'object') return true;
    const notApplicable = index === 1 && review.axis === 'code review' && review.status === 'NOT_APPLICABLE' && reviews[0]?.status === 'PASSED';
    const blockingFinding = Array.isArray(review.findings) && review.findings.some((finding) => ['P0','P1'].includes(finding.severity) || finding.severity === 'P2' && finding.mustFix);
    return review.status !== 'PASSED' && !notApplicable || Array.isArray(review.uncovered) && review.uncovered.length > 0 || blockingFinding;
  });
  return blocked ? 'CHANGES_REQUESTED' : 'PASSED';
}
export function isSuccessfulAssistantChain(messages, expectedModel) {
  if (!Array.isArray(messages) || !expectedModel || typeof expectedModel.provider !== 'string' || typeof expectedModel.model !== 'string') return false;
  const assistant = messages.filter((m) => m?.role === 'assistant');
  if (!assistant.length) return false;
  const last = assistant.at(-1);
  return assistant.every((m) => m.provider === expectedModel.provider && m.model === expectedModel.model && (!('responseModel' in m) || m.responseModel === expectedModel.model) && ['stop','toolUse'].includes(m.stopReason)) && last.stopReason === 'stop';
}
export function applySnapshotCoverage(result, { gaps = [], specGaps = [], errors = [], specCoverage = [] }) {
  return { ...result, coverage: [...result.coverage, ...specCoverage], uncovered: [...result.uncovered, ...(result.status === 'NOT_APPLICABLE' ? [] : gaps), ...specGaps, ...errors] };
}
export function buildAggregateReviewResult({ head, base, model, changedPaths, specFingerprint, reviews }) {
  return { status: expectedAggregateStatus(reviews), head, base, model, changedPaths, specFingerprint, reviews };
}
export function parseSuccessfulAxis({ messages, text, expectedModel, axis, changedPaths }) {
  if (!isSuccessfulAssistantChain(messages, expectedModel)) return { ok: false, errors: ['SDK assistant chain did not end successfully'] };
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, errors: ['assistant response is not JSON'] }; }
  const errors = validateAxisResult(value, axis, { changedPaths });
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
export function validateReviewResult(result, { head, base, model, changedPaths, specFingerprint }) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result) || !exactKeys(result, ['status','head','base','model','changedPaths','specFingerprint','reviews'])) return ['result must have the exact aggregate schema'];
  if (result.head !== head || result.base !== base || result.model !== model) errors.push('snapshot/model binding mismatch');
  if (!/^[0-9a-f]{64}$/.test(specFingerprint ?? '') || result.specFingerprint !== specFingerprint) errors.push('source specification fingerprint mismatch');
  if (!Array.isArray(result.changedPaths) || result.changedPaths.length !== changedPaths.length || result.changedPaths.some((path, i) => path !== changedPaths[i])) errors.push('changed paths do not match the authoritative snapshot');
  if (!Array.isArray(result.reviews) || result.reviews.length !== 2) return [...errors, 'exactly two axis results required'];
  for (const [i, axis] of REVIEW_AXES.entries()) {
    const review = result.reviews[i];
    if (review?.axis !== axis) errors.push(`axis ${i} mismatch`);
    errors.push(...validateAxisResult(review, axis, { changedPaths }));
  }
  const notApplicable = result.reviews[1]?.status === 'NOT_APPLICABLE';
  if (notApplicable && result.reviews[0]?.status !== 'PASSED') errors.push('code review NA requires passed first axis');
  if (result.status !== expectedAggregateStatus(result.reviews)) errors.push('aggregate status mismatch');
  return errors;
}
export function buildReviewControllerOutputs(result, binding) {
  const errors = validateReviewResult(result, binding);
  if (errors.length) throw new Error(`Review result contract invalid: ${errors.join('; ')}`);
  return { result: result.status, specFingerprint: result.specFingerprint };
}
export function formatReviewControllerOutputs(outputs) {
  if (!exactKeys(outputs, ['result','specFingerprint']) || !['PASSED','CHANGES_REQUESTED'].includes(outputs.result) || !/^[0-9a-f]{64}$/.test(outputs.specFingerprint)) throw new Error('Invalid review controller outputs');
  return `result=${outputs.result}\nspec_fingerprint=${outputs.specFingerprint}\n`;
}
