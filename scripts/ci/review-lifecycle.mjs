export async function finalizeReview({ outcomes, expected, readCurrent, publishSuccess, publishFailure = async () => {}, beforePublish = async () => {} }) {
  const eligible = outcomes.authorization === 'success' && outcomes.install === 'success' && outcomes.review === 'success' && outcomes.save === 'success' && outcomes.result === 'PASSED' && /^[0-9a-f]{64}$/.test(expected.specFingerprint ?? '');
  if (!eligible) { if (expected.head) await publishFailure(expected.head); return { finalized: false, reason: 'required step failed or review did not pass' }; }
  const current = await readCurrent();
  if (current.head !== expected.head || current.base !== expected.base || current.main !== expected.base || current.specFingerprint !== expected.specFingerprint) { await publishFailure(expected.head); return { finalized: false, reason: 'stale snapshot or source specification changed' }; }
  await beforePublish();
  await publishSuccess(expected.head);
  return { finalized: true };
}
