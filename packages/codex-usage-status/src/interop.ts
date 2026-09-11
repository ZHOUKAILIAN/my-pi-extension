export const FAST_REQUESTED_EVENT = '@pi/codex-usage-status:fast-requested/v1';
export const FAST_ENV_NAME = 'PI_CODEX_FAST';

export interface FastRequestedEvent {
  version: 1;
  sessionId: string;
  requested: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Parse only the exact v1 payload; unknown or malformed events are ignored. */
export function parseFastRequestedEvent(value: unknown): FastRequestedEvent | undefined {
  try {
    if (!isPlainObject(value)) return undefined;
    const keys = Object.keys(value).sort();
    if (keys.length !== 3 || keys[0] !== 'requested' || keys[1] !== 'sessionId' || keys[2] !== 'version') {
      return undefined;
    }
    if (value.version !== 1 || typeof value.sessionId !== 'string' || value.sessionId.length === 0 || typeof value.requested !== 'boolean') {
      return undefined;
    }
    return {
      version: 1,
      sessionId: value.sessionId,
      requested: value.requested,
    };
  } catch {
    return undefined;
  }
}

export interface FastEventBusLike {
  emit(channel: string, data: unknown): void;
}

export function publishFastRequested(
  events: FastEventBusLike,
  sessionId: string | undefined,
  requested: boolean,
): boolean {
  if (!sessionId) return false;
  events.emit(FAST_REQUESTED_EVENT, { version: 1, sessionId, requested });
  return true;
}

/** Consume the child-only bootstrap input. Any value other than exactly "1" is Off. */
export function consumeFastBootstrap(): boolean {
  const requested = process.env[FAST_ENV_NAME] === '1';
  delete process.env[FAST_ENV_NAME];
  return requested;
}
