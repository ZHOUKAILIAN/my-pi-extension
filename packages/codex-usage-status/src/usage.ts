const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const MAX_BODY_BYTES = 64 * 1024;
const HARD_EXPIRY_MS = 10 * 60 * 1000;
const SCOPE_LEASE_MS = 60 * 1000;
const USAGE_MIN_INTERVAL_MS = 60 * 1000;
const USAGE_REFRESH_MS = 5 * 60 * 1000;
const RESET_MIN_SECONDS = 946684800; // 2000-01-01
const RESET_MAX_SECONDS = 4102444800; // 2100-01-01
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/;

export interface UsageWindow {
  readonly label: string;
  readonly remainingPercent: number;
  readonly windowDurationMins?: number;
  readonly resetsAt?: number;
}

export type Availability = 'allowed' | 'limited' | 'unknown';

export interface UsageDisplaySnapshot {
  readonly availability: Availability;
  readonly windows: readonly UsageWindow[];
  readonly fetchedAt: number;
}

interface UsageWindowWire {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
}

interface UsageLimitWire {
  allowed?: unknown;
  primary_window?: UsageWindowWire;
  secondary_window?: UsageWindowWire;
}

interface UsageAdditionalLimitWire {
  limit_name?: unknown;
  metered_feature?: unknown;
  rate_limit?: UsageLimitWire;
}

interface UsageResponseWire {
  account_id?: unknown;
  rate_limit?: UsageLimitWire;
  additional_rate_limits?: UsageAdditionalLimitWire[];
}

interface ResolvedAuthScope {
  readonly accountId: string;
  readonly fingerprint: string;
  readonly bearerToken: string;
}

export interface FetchUsageOptions {
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UsageContextLike {
  readonly mode: string;
  readonly model: UsageModelLike | undefined;
  readonly modelRegistry: {
    isUsingOAuth(model: UsageModelLike): boolean;
    getProviderAuth(provider: string): Promise<unknown>;
  };
  readonly ui: { setStatus(key: string, text: string | undefined): void };
}

export interface UsageModelLike {
  readonly provider: string;
  readonly api: string;
  readonly baseUrl: string;
}

export interface UsageControllerOptions {
  readonly now?: () => number;
  readonly setTimeout?: (handler: () => void, timeout: number) => ReturnType<typeof globalThis.setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof globalThis.setTimeout>) => void;
  readonly fetch?: FetchLike;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeAccountId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function fingerprintScope(accountId: string): string {
  // This is only an in-memory equality key. The account id never leaves this module.
  let hash = 2166136261;
  for (let index = 0; index < accountId.length; index += 1) {
    hash ^= accountId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `scope-${(hash >>> 0).toString(16)}`;
}

function decodeBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return undefined;
  try {
    const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (value.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return undefined;
  }
}

function resolveCodexAuthScope(authResult: unknown, now = Date.now()): ResolvedAuthScope | undefined {
  if (!isPlainObject(authResult) || !isPlainObject(authResult.auth)) return undefined;
  const bearerToken = authResult.auth.apiKey;
  if (typeof bearerToken !== 'string' || bearerToken.length === 0) return undefined;

  const segments = bearerToken.split('.');
  if (segments.length !== 3) return undefined;
  const payloadText = decodeBase64Url(segments[1]);
  if (!payloadText) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return undefined;
  }
  if (!isPlainObject(payload)) return undefined;
  if ('exp' in payload && (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= now / 1000)) {
    return undefined;
  }

  const authClaim = payload['https://api.openai.com/auth'];
  if (!isPlainObject(authClaim) || !isSafeAccountId(authClaim.chatgpt_account_id)) return undefined;
  const accountId = authClaim.chatgpt_account_id;
  return { accountId, fingerprint: fingerprintScope(accountId), bearerToken };
}

function isValidResetAt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= RESET_MIN_SECONDS && value <= RESET_MAX_SECONDS;
}

function parseWindow(label: string, value: unknown): UsageWindow | undefined {
  if (!isPlainObject(value)) return undefined;
  const usedPercent = value.used_percent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) return undefined;

  const windowDurationMins = typeof value.limit_window_seconds === 'number' && Number.isSafeInteger(value.limit_window_seconds) && value.limit_window_seconds > 0
    ? value.limit_window_seconds / 60
    : undefined;
  const resetsAt = isValidResetAt(value.reset_at) ? value.reset_at : undefined;
  return {
    label,
    remainingPercent: Math.round(100 - usedPercent),
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

function parseBucket(label: string, limit: unknown): UsageWindow[] {
  if (!isPlainObject(limit)) return [];
  const windows: UsageWindow[] = [];
  const primary = parseWindow(label, limit.primary_window);
  const secondary = parseWindow(label, limit.secondary_window);
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);
  return windows;
}

function safeLabel(value: unknown): value is string {
  return typeof value === 'string' && SAFE_LABEL.test(value);
}

export function parseUsagePayload(payload: unknown, expectedAccountId: string, fetchedAt = Date.now()): UsageDisplaySnapshot | undefined {
  if (!isPlainObject(payload)) return undefined;
  const response = payload as UsageResponseWire;
  if ('account_id' in response && (!isSafeAccountId(response.account_id) || response.account_id !== expectedAccountId)) return undefined;

  const defaultLimit = response.rate_limit;
  if (!isPlainObject(defaultLimit)) return undefined;
  const defaultWindows = parseBucket('default', defaultLimit);
  if (defaultWindows.length === 0) return undefined;

  const additional: Array<{ label: string; index: number; windows: UsageWindow[] }> = [];
  if (Array.isArray(response.additional_rate_limits)) {
    for (const [index, item] of response.additional_rate_limits.entries()) {
      if (!isPlainObject(item) || !isPlainObject(item.rate_limit)) continue;
      const label = safeLabel(item.limit_name) ? item.limit_name : safeLabel(item.metered_feature) ? item.metered_feature : 'additional';
      const windows = parseBucket(label, item.rate_limit);
      if (windows.length > 0) additional.push({ label, index, windows });
    }
  }
  additional.sort((left, right) => left.label < right.label ? -1 : left.label > right.label ? 1 : left.index - right.index);

  const allowed = defaultLimit.allowed;
  const availability: Availability = allowed === true ? 'allowed' : allowed === false ? 'limited' : 'unknown';
  return {
    availability,
    windows: [...defaultWindows, ...additional.flatMap((bucket) => bucket.windows)],
    fetchedAt,
  };
}

async function readLimitedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength > MAX_BODY_BYTES) throw new Error('body_too_large');
  }
  if (!response.body) throw new Error('body_missing');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('body_too_large');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export async function fetchUsageSnapshot(authResult: unknown, options: FetchUsageOptions = {}): Promise<UsageDisplaySnapshot | undefined> {
  const now = options.now ?? Date.now;
  const scope = resolveCodexAuthScope(authResult, now());
  if (!scope) return undefined;

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  const fetcher = options.fetch ?? globalThis.fetch;
  try {
    const response = await fetcher(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${scope.bearerToken}`,
        'ChatGPT-Account-ID': scope.accountId,
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status !== 200) return undefined;
    const body = await readLimitedBody(response);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return undefined;
    }
    return parseUsagePayload(payload, scope.accountId, now());
  } catch {
    return undefined;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function formatUsageSnapshot(snapshot: UsageDisplaySnapshot): string {
  const availability = snapshot.availability === 'limited' ? 'limit reached' : snapshot.availability === 'unknown' ? 'status unknown' : undefined;
  const windows = snapshot.windows.map((window) => {
    const details: string[] = [];
    if (window.windowDurationMins !== undefined) {
      const minutes = Math.round(window.windowDurationMins);
      details.push(minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`);
    }
    if (window.resetsAt !== undefined) {
      const date = new Date(window.resetsAt * 1000);
      const pad = (value: number) => String(value).padStart(2, '0');
      details.push(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`);
    }
    return `${window.label} ${window.remainingPercent}% left${details.length === 0 ? '' : ` (${details.join(', ')})`}`;
  });
  return `Codex: ${availability === undefined ? '' : `${availability} · `}${windows.join(' · ')}`;
}

function isEligible(context: UsageContextLike, model = context.model): boolean {
  if (context.mode !== 'tui' || !model || model.provider !== 'openai-codex' || model.api !== 'openai-codex-responses' || model.baseUrl !== 'https://chatgpt.com/backend-api') return false;
  try {
    return context.modelRegistry.isUsingOAuth(model);
  } catch {
    return false;
  }
}

export class UsageController {
  private readonly now: () => number;
  private readonly schedule: UsageControllerOptions['setTimeout'];
  private readonly cancel: UsageControllerOptions['clearTimeout'];
  private readonly fetcher: FetchLike | undefined;
  private context: UsageContextLike | undefined;
  private activeModel: UsageModelLike | undefined;
  private snapshot: { readonly display: UsageDisplaySnapshot; readonly scopeFingerprint: string } | undefined;
  private scopeFingerprint: string | undefined;
  private scopeAccountId: string | undefined;
  private generation = 0;
  private scopeLeaseTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private scopeLeaseExpiresAt: number | undefined;
  private hardExpiryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private usageTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private scopeInFlight = false;
  private pendingScopeRefresh = false;
  private pendingScopeFetchImmediately = false;
  private usageInFlight = false;
  private pendingUsageRefresh = false;
  private pendingUsageForce = false;
  private lastUsageAttempt = 0;
  private usageFailure = false;

  constructor(options: UsageControllerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule = options.setTimeout ?? globalThis.setTimeout;
    this.cancel = options.clearTimeout ?? globalThis.clearTimeout;
    this.fetcher = options.fetch;
  }

  handle(context: UsageContextLike, modelOverride?: UsageModelLike, forceRevalidate = false): void {
    if (forceRevalidate) {
      this.invalidate();
      this.usageFailure = false;
    }
    this.context = context;
    this.activeModel = modelOverride ?? context.model;
    this.expireLeaseIfNeeded();
    if (!isEligible(context, this.activeModel)) {
      this.disable();
      return;
    }
    if (!this.hasValidLease()) {
      this.renderUnavailable();
      this.requestScopeRefresh(true);
      return;
    }
    this.render();
    if (this.now() - this.lastUsageAttempt >= USAGE_MIN_INTERVAL_MS) this.requestUsage(this.generation);
  }

  shutdown(): void {
    this.context?.ui.setStatus('codex-usage-status', undefined);
    this.context = undefined;
    this.activeModel = undefined;
    this.pendingScopeRefresh = false;
    this.pendingScopeFetchImmediately = false;
    this.pendingUsageRefresh = false;
    this.pendingUsageForce = false;
    this.invalidate();
  }

  private hasValidLease(): boolean {
    return this.scopeFingerprint !== undefined && this.scopeLeaseTimer !== undefined && this.scopeLeaseExpiresAt !== undefined && this.now() < this.scopeLeaseExpiresAt;
  }

  private expireLeaseIfNeeded(): void {
    if (this.scopeLeaseExpiresAt !== undefined && this.now() >= this.scopeLeaseExpiresAt) {
      this.invalidate();
      this.renderUnavailable();
    }
  }

  private disable(): void {
    this.clearTimers();
    this.context?.ui.setStatus('codex-usage-status', undefined);
    this.snapshot = undefined;
    this.scopeFingerprint = undefined;
    this.scopeAccountId = undefined;
    this.scopeLeaseExpiresAt = undefined;
    this.usageFailure = false;
    this.pendingScopeRefresh = false;
    this.pendingScopeFetchImmediately = false;
    this.pendingUsageRefresh = false;
    this.pendingUsageForce = false;
    this.generation += 1;
  }

  private invalidate(): void {
    this.clearTimers();
    this.snapshot = undefined;
    this.scopeFingerprint = undefined;
    this.scopeAccountId = undefined;
    this.scopeLeaseExpiresAt = undefined;
    this.generation += 1;
  }

  private requestScopeRefresh(fetchImmediately: boolean): void {
    if (this.scopeInFlight) {
      this.pendingScopeRefresh = true;
      this.pendingScopeFetchImmediately ||= fetchImmediately;
      return;
    }
    void this.confirmScope(fetchImmediately);
  }

  private drainPendingScopeRefresh(): void {
    if (!this.pendingScopeRefresh || this.scopeInFlight) return;
    if (!this.context || !isEligible(this.context, this.activeModel)) return;
    const fetchImmediately = this.pendingScopeFetchImmediately;
    this.pendingScopeRefresh = false;
    this.pendingScopeFetchImmediately = false;
    this.requestScopeRefresh(fetchImmediately);
  }

  private requestUsage(generation: number, auth?: unknown, force = false): void {
    if (this.usageInFlight) {
      this.pendingUsageRefresh = true;
      this.pendingUsageForce ||= force;
      return;
    }
    if (!force && this.now() - this.lastUsageAttempt < USAGE_MIN_INTERVAL_MS) return;
    this.pendingUsageRefresh = false;
    this.pendingUsageForce = false;
    void this.fetchUsage(generation, auth);
  }

  private drainPendingUsageRefresh(): void {
    if (!this.pendingUsageRefresh || this.usageInFlight) return;
    if (!this.context || !this.scopeFingerprint || !this.hasValidLease() || !isEligible(this.context, this.activeModel)) return;
    const force = this.pendingUsageForce;
    this.pendingUsageRefresh = false;
    this.pendingUsageForce = false;
    this.requestUsage(this.generation, undefined, force);
  }

  private clearTimers(): void {
    if (this.scopeLeaseTimer !== undefined) this.cancel?.(this.scopeLeaseTimer);
    if (this.hardExpiryTimer !== undefined) this.cancel?.(this.hardExpiryTimer);
    if (this.usageTimer !== undefined) this.cancel?.(this.usageTimer);
    this.scopeLeaseTimer = undefined;
    this.scopeLeaseExpiresAt = undefined;
    this.hardExpiryTimer = undefined;
    this.usageTimer = undefined;
  }

  private async confirmScope(fetchImmediately: boolean): Promise<void> {
    if (this.scopeInFlight || !this.context || !isEligible(this.context, this.activeModel)) return;
    const context = this.context;
    const generation = this.generation;
    this.scopeInFlight = true;
    try {
      const auth = await context.modelRegistry.getProviderAuth('openai-codex');
      const scope = resolveCodexAuthScope(auth, this.now());
      if (generation !== this.generation || context !== this.context || !isEligible(context, this.activeModel)) return;
      if (!scope) {
        this.invalidate();
        this.renderUnavailable();
        return;
      }
      if (this.scopeFingerprint !== undefined && this.scopeFingerprint !== scope.fingerprint) {
        this.snapshot = undefined;
        this.clearSnapshotTimers();
      }
      this.scopeFingerprint = scope.fingerprint;
      this.scopeAccountId = scope.accountId;
      this.setLease(generation);
      this.render();
      if (fetchImmediately || !this.snapshot || this.now() - this.lastUsageAttempt >= USAGE_MIN_INTERVAL_MS) {
        this.requestUsage(generation, auth, fetchImmediately);
      }
    } catch {
      if (generation === this.generation && context === this.context) {
        this.renderUnavailableOrStale();
      }
    } finally {
      this.scopeInFlight = false;
      this.drainPendingScopeRefresh();
      this.drainPendingUsageRefresh();
    }
  }

  private setLease(generation: number): void {
    if (this.scopeLeaseTimer !== undefined) this.cancel?.(this.scopeLeaseTimer);
    this.scopeLeaseExpiresAt = this.now() + SCOPE_LEASE_MS;
    this.scopeLeaseTimer = this.schedule?.(() => {
      if (generation !== this.generation) return;
      this.invalidate();
      this.renderUnavailable();
      this.requestScopeRefresh(true);
    }, SCOPE_LEASE_MS);
    if (this.usageTimer === undefined) {
      this.usageTimer = this.schedule?.(() => {
        this.usageTimer = undefined;
        if (this.hasValidLease() && this.now() - this.lastUsageAttempt >= USAGE_MIN_INTERVAL_MS) this.requestUsage(this.generation);
        if (this.hasValidLease()) this.setUsageTimer();
      }, USAGE_REFRESH_MS);
    }
  }

  private setUsageTimer(): void {
    if (this.usageTimer !== undefined) this.cancel?.(this.usageTimer);
    this.usageTimer = this.schedule?.(() => {
      this.usageTimer = undefined;
      if (this.hasValidLease() && this.now() - this.lastUsageAttempt >= USAGE_MIN_INTERVAL_MS) this.requestUsage(this.generation);
      if (this.hasValidLease()) this.setUsageTimer();
    }, USAGE_REFRESH_MS);
  }

  private async fetchUsage(generation: number, auth?: unknown): Promise<void> {
    if (!this.context || !this.scopeFingerprint || !isEligible(this.context, this.activeModel)) return;
    const context = this.context;
    this.usageInFlight = true;
    this.lastUsageAttempt = this.now();
    try {
      const authResult = auth ?? await context.modelRegistry.getProviderAuth('openai-codex');
      const scope = resolveCodexAuthScope(authResult, this.now());
      if (!scope || scope.fingerprint !== this.scopeFingerprint || scope.accountId !== this.scopeAccountId) {
        if (generation === this.generation) {
          this.invalidate();
          this.renderUnavailable();
        }
        return;
      }
      if (generation !== this.generation || context !== this.context || !isEligible(context, this.activeModel)) return;
      const display = await fetchUsageSnapshot(authResult, { fetch: this.fetcher, now: this.now });
      if (generation !== this.generation || context !== this.context || !this.scopeFingerprint || scope.fingerprint !== this.scopeFingerprint || scope.accountId !== this.scopeAccountId) return;
      if (!display) {
        this.usageFailure = true;
        this.renderUnavailableOrStale();
        return;
      }
      this.snapshot = { display, scopeFingerprint: scope.fingerprint };
      this.usageFailure = false;
      this.setHardExpiry(generation, display.fetchedAt);
      this.render();
    } catch {
      if (generation === this.generation && context === this.context) {
        this.usageFailure = true;
        this.renderUnavailableOrStale();
      }
    } finally {
      this.usageInFlight = false;
      this.drainPendingUsageRefresh();
    }
  }

  private clearSnapshotTimers(): void {
    if (this.hardExpiryTimer !== undefined) this.cancel?.(this.hardExpiryTimer);
    this.hardExpiryTimer = undefined;
  }

  private setHardExpiry(generation: number, fetchedAt: number): void {
    this.clearSnapshotTimers();
    const delay = Math.max(0, fetchedAt + HARD_EXPIRY_MS - this.now());
    this.hardExpiryTimer = this.schedule?.(() => {
      this.hardExpiryTimer = undefined;
      if (generation !== this.generation || !this.snapshot) return;
      if (this.now() - this.snapshot.display.fetchedAt >= HARD_EXPIRY_MS) {
        this.snapshot = undefined;
        this.usageFailure = false;
        this.renderUnavailable();
      } else {
        this.setHardExpiry(generation, this.snapshot.display.fetchedAt);
      }
    }, delay);
  }

  private renderUnavailable(): void {
    this.context?.ui.setStatus('codex-usage-status', 'Codex: unavailable');
  }

  private renderUnavailableOrStale(): void {
    if (!this.snapshot || this.snapshot.scopeFingerprint !== this.scopeFingerprint || this.now() - this.snapshot.display.fetchedAt >= HARD_EXPIRY_MS) {
      this.snapshot = undefined;
      this.renderUnavailable();
      return;
    }
    this.context?.ui.setStatus('codex-usage-status', `Codex: stale · ${formatUsageSnapshot(this.snapshot.display).slice('Codex: '.length)}`);
  }

  private render(): void {
    if (!this.context || !this.snapshot || this.snapshot.scopeFingerprint !== this.scopeFingerprint) {
      this.renderUnavailable();
      return;
    }
    if (this.now() - this.snapshot.display.fetchedAt >= HARD_EXPIRY_MS) {
      this.snapshot = undefined;
      this.renderUnavailable();
      return;
    }
    this.context.ui.setStatus('codex-usage-status', this.usageFailure
      ? `Codex: stale · ${formatUsageSnapshot(this.snapshot.display).slice('Codex: '.length)}`
      : formatUsageSnapshot(this.snapshot.display));
  }
}

export const USAGE_STATUS_CONSTANTS = {
  usageUrl: USAGE_URL,
  maxBodyBytes: MAX_BODY_BYTES,
  hardExpiryMs: HARD_EXPIRY_MS,
  scopeLeaseMs: SCOPE_LEASE_MS,
  usageMinIntervalMs: USAGE_MIN_INTERVAL_MS,
  usageRefreshMs: USAGE_REFRESH_MS,
} as const;
