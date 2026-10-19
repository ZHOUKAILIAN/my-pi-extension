const ROOT_KEYS = ['openai-codex'];
const PROVIDER_KEYS = ['type', 'access', 'refresh', 'expires', 'accountId'];
const token = (value) => typeof value === 'string' && value.length >= 16 && value.length <= 20_000;
export function parseOAuthCredential(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== ROOT_KEYS.length || !ROOT_KEYS.every((key) => Object.hasOwn(value, key))) throw new Error('OAuth provider set invalid');
  const credential = value['openai-codex'];
  if (!credential || typeof credential !== 'object' || Array.isArray(credential) || Object.keys(credential).length !== PROVIDER_KEYS.length || !PROVIDER_KEYS.every((key) => Object.hasOwn(credential, key))) throw new Error('OAuth credential fields invalid');
  if (credential.type !== 'oauth' || !token(credential.access) || !token(credential.refresh) || typeof credential.expires !== 'number' || !Number.isFinite(credential.expires) || credential.expires <= 0 || typeof credential.accountId !== 'string' || !credential.accountId.trim() || credential.accountId.length > 256 || /[\u0000-\u001f\u007f]/u.test(credential.accountId)) throw new Error('OAuth credential values invalid');
  return Object.freeze({ type: 'oauth', access: credential.access, refresh: credential.refresh, expires: credential.expires, accountId: credential.accountId });
}
