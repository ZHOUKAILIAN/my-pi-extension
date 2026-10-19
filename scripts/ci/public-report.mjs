const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/giu;
const BEARER = /\bBearer\s+[^\s,;"']+/giu;
const BASIC_AUTH = /\bBasic\s+[A-Za-z0-9+/]{12,}={0,2}/giu;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/gu;
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/giu;
const OPENAI_KEY = /\bsk-(?:(?:proj|svcacct|live|ant)-)?[A-Za-z0-9_-]{16,}\b/giu;
const CREDENTIAL_FIELD = /(["']?(?:[A-Za-z0-9_.-]*[-_])?(?:password|passwd|pwd|token|api[-_]?key|authorization|auth|header|cookie|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,}]+)/giu;
const URL_CREDENTIAL = /\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu;
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu;

export function createPublicReportProjector(knownSecrets = []) {
  const secrets = [...new Set(knownSecrets.filter((value) => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length);
  return (value) => {
    let text = String(value ?? '');
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    text = text
      .replace(PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
      .replace(BEARER, 'Bearer [REDACTED]')
      .replace(BASIC_AUTH, 'Basic [REDACTED]')
      .replace(JWT, '[REDACTED JWT]')
      .replace(GITHUB_TOKEN, '[REDACTED GITHUB TOKEN]')
      .replace(OPENAI_KEY, '[REDACTED API KEY]')
      .replace(CREDENTIAL_FIELD, '$1[REDACTED]')
      .replace(URL_CREDENTIAL, '$1[REDACTED]@')
      .replace(ANSI, '[CONTROL]')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .replace(/::/gu, ': :');
    return text;
  };
}
