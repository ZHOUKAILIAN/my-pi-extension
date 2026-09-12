import { calculateCost, type Model, type Usage } from '@earendil-works/pi-ai';
import { FAST_ENV_NAME } from './interop.ts';

export const FAST_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
] as const;

const FAST_PROVIDER = 'openai-codex';
const FAST_API = 'openai-codex-responses';
const FAST_BASE_URL = 'https://chatgpt.com/backend-api';
const FAST_ORANGE = '\u001b[38;2;217;140;63m';
const ANSI_RESET = '\u001b[0m';
const FAST_ACTIVE_LABEL = orange('⚡ Fast');
const FAST_ACTIVE_NOTIFICATION = '⚡ Fast enabled — selected user implementer/code_reviewer agents inherit requested Fast.';
const MAX_PENDING_TICKETS = 32;
const PRIORITY_SERVICE_TIER = 'priority';

type FastModel = Model<any>;

function orange(text: string): string {
  return `${FAST_ORANGE}${text}${ANSI_RESET}`;
}

export interface FastContextLike {
  readonly hasUI: boolean;
  readonly mode: string;
  readonly model: FastModel | undefined;
  readonly modelRegistry: {
    isUsingOAuth(model: FastModel): boolean;
  };
  readonly sessionManager?: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  readonly ui: {
    notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

export type FastState = 'off' | 'active' | 'inactive';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasFastModelId(model: FastModel | undefined): boolean {
  return model !== undefined && FAST_MODEL_IDS.includes(model.id as (typeof FAST_MODEL_IDS)[number]);
}

export function isFastEligible(context: FastContextLike, model = context.model): boolean {
  if (!model || model.provider !== FAST_PROVIDER || model.api !== FAST_API || model.baseUrl !== FAST_BASE_URL || !hasFastModelId(model)) {
    return false;
  }
  try {
    return context.modelRegistry.isUsingOAuth(model) === true;
  } catch {
    return false;
  }
}

export function getFastState(requested: boolean, eligible: boolean): FastState {
  if (!requested) return 'off';
  return eligible ? 'active' : 'inactive';
}

export interface FastDisplaySnapshot {
  readonly state: FastState;
}

export interface FastDisplayTheme {
  fg(color: 'muted', text: string): string;
}

function style(theme: FastDisplayTheme | undefined, text: string): string {
  if (!theme) return text;
  try {
    return theme.fg('muted', text);
  } catch {
    return text;
  }
}

export function formatFastDisplay(snapshot: FastDisplaySnapshot, theme?: FastDisplayTheme): string {
  if (snapshot.state === 'active') return FAST_ACTIVE_LABEL;
  return style(theme, snapshot.state === 'inactive' ? 'Fast inactive' : 'Fast off');
}

function sessionIdentity(context: FastContextLike): string | undefined {
  try {
    const manager = context.sessionManager;
    if (!manager) return undefined;
    return `${manager.getSessionId()}\u0000${manager.getSessionFile() ?? ''}`;
  } catch {
    return undefined;
  }
}

function cloneModel(model: FastModel): FastModel {
  const cost = isPlainObject((model as { cost?: unknown }).cost)
    ? (model as unknown as { cost: Record<string, unknown> }).cost
    : undefined;
  return {
    ...model,
    ...(cost === undefined ? {} : {
      cost: {
        ...cost,
        ...(Array.isArray(cost.tiers) ? { tiers: cost.tiers.map((tier) => isPlainObject(tier) ? { ...tier } : tier) } : {}),
      },
    }),
  } as FastModel;
}

interface PendingFastTicket {
  readonly model: FastModel;
  readonly sessionIdentity: string | undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isUsage(value: unknown): value is Usage {
  if (!isPlainObject(value) || !isPlainObject(value.cost)) return false;
  const tokenFields = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
  if (!tokenFields.every((field) => isNonNegativeInteger(value[field]))) return false;
  const output = value.output;
  const cacheWrite = value.cacheWrite;
  if (!isNonNegativeInteger(output) || !isNonNegativeInteger(cacheWrite)) return false;
  const reasoning = value.reasoning;
  const cacheWrite1h = value.cacheWrite1h;
  if (reasoning !== undefined && (!isNonNegativeInteger(reasoning) || reasoning > output)) return false;
  if (cacheWrite1h !== undefined && (!isNonNegativeInteger(cacheWrite1h) || cacheWrite1h > cacheWrite)) return false;
  const cost = value.cost;
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every((field) => isFiniteNumber(cost[field]));
}

function costsEqual(left: Usage['cost'], right: Usage['cost']): boolean {
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite
    && left.total === right.total;
}

function priorityCost(model: FastModel, usage: Usage): Usage['cost'] | undefined {
  try {
    const clonedUsage: Usage = {
      ...usage,
      cost: { ...usage.cost },
    };
    const baseCost = calculateCost(model, clonedUsage);
    const multiplier = model.id === 'gpt-5.5' ? 2.5 : 2;
    const input = baseCost.input * multiplier;
    const output = baseCost.output * multiplier;
    const cacheRead = baseCost.cacheRead * multiplier;
    const cacheWrite = baseCost.cacheWrite * multiplier;
    const cost = {
      ...baseCost,
      input,
      output,
      cacheRead,
      cacheWrite,
      // Match Pi's native pricing order: total is the sum of scaled
      // components, rather than a scaled copy of the native total.
      total: input + output + cacheRead + cacheWrite,
    };
    return Object.values(cost).every((value) => isFiniteNumber(value)) ? cost : undefined;
  } catch {
    return undefined;
  }
}

export class FastController {
  private requested: boolean;
  private context: FastContextLike | undefined;
  private model: FastModel | undefined;
  private pendingTickets: PendingFastTicket[] = [];
  private readonly stateListeners = new Set<(snapshot: FastDisplaySnapshot) => void>();

  constructor(initialRequested = false) {
    this.requested = initialRequested;
  }

  onDisplayStateChange(listener: (snapshot: FastDisplaySnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  getDisplaySnapshot(): FastDisplaySnapshot {
    return { state: this.state };
  }

  private emitDisplayStateChange(previousState: FastState | undefined): void {
    const snapshot = this.getDisplaySnapshot();
    if (previousState === snapshot.state) return;
    for (const listener of this.stateListeners) listener(snapshot);
  }

  get requestedOn(): boolean {
    return this.requested;
  }

  get state(): FastState {
    return getFastState(this.requested, this.context ? isFastEligible(this.context, this.model) : false);
  }

  handle(
    context: FastContextLike,
    modelOverride?: FastModel,
    announceTransition = false,
    previousStateOverride?: FastState,
  ): void {
    const previousState = previousStateOverride ?? (this.context ? this.state : undefined);
    this.context = context;
    this.model = modelOverride ?? context.model;
    const state = this.state;
    this.emitDisplayStateChange(previousState);
    if (announceTransition && this.requested && previousState !== undefined && previousState !== state) {
      this.notifyState(state);
    }
  }

  shutdown(): void {
    this.context = undefined;
    this.model = undefined;
    this.pendingTickets = [];
    this.requested = false;
    this.stateListeners.clear();
  }

  setRequested(requested: boolean, context: FastContextLike): void {
    const previousState = this.context ? this.state : 'off';
    this.requested = requested;
    this.handle(context, undefined, false, previousState);
    this.notifyState(this.state);
  }

  toggle(context: FastContextLike): void {
    this.setRequested(!this.requested, context);
  }

  notifyCurrent(context = this.context): void {
    if (!context) return;
    this.context = context;
    this.model = context.model;
    this.notifyState(this.state);
  }

  handleCommand(args: string, context: FastContextLike): boolean {
    if (!context.hasUI) {
      context.ui.notify('Fast is unavailable in JSON/print mode; use TUI or RPC. Fast intent was not changed.', 'warning');
      return false;
    }

    const parts = args.trim() === '' ? [] : args.trim().split(/\s+/u);
    if (parts.length > 1 || (parts.length === 1 && !['on', 'off', 'toggle', 'status'].includes(parts[0]))) {
      context.ui.notify('Usage: /fast [on|off|toggle|status]', 'warning');
      return false;
    }
    const command = parts[0] ?? 'toggle';
    const previousRequested = this.requested;
    if (command === 'status') {
      this.notifyCurrent(context);
      return false;
    }
    if (command === 'on') {
      this.setRequested(true, context);
    } else if (command === 'off') {
      this.setRequested(false, context);
    } else {
      this.toggle(context);
    }
    return this.requested !== previousRequested;
  }

  rewriteProviderPayload(payload: unknown, context: FastContextLike): unknown | undefined {
    this.context = context;
    this.model = context.model;
    if (!this.requested || !isFastEligible(context)) return undefined;
    const model = context.model;
    if (!model || !isPlainObject(payload) || payload.model !== model.id) return undefined;

    this.pendingTickets.push({ model: cloneModel(model), sessionIdentity: sessionIdentity(context) });
    if (this.pendingTickets.length > MAX_PENDING_TICKETS) this.pendingTickets.shift();
    // Pi may compose later handlers; this is only this extension's payload output.
    return { ...payload, service_tier: PRIORITY_SERVICE_TIER };
  }

  rewriteAssistantMessage<T extends object>(message: T, context: FastContextLike): { message: T } | undefined {
    if (this.pendingTickets.length === 0) return undefined;
    const ticket = this.pendingTickets.shift();
    if (!ticket || !isPlainObject(message) || message.role !== 'assistant') return undefined;
    if (message.provider !== ticket.model.provider || message.api !== ticket.model.api || message.model !== ticket.model.id || sessionIdentity(context) !== ticket.sessionIdentity) return undefined;
    if (!isUsage(message.usage)) return undefined;

    const cost = priorityCost(ticket.model, message.usage);
    if (!cost || costsEqual(message.usage.cost, cost)) return undefined;
    // Other message_end handlers and final persistence are outside this hook's view.
    return {
      message: {
        ...message,
        usage: {
          ...message.usage,
          cost,
        },
      } as T,
    };
  }

  private notifyState(state: FastState): void {
    const context = this.context;
    if (!context) return;
    if (state === 'active') {
      context.ui.notify(context.mode === 'tui' ? orange(FAST_ACTIVE_NOTIFICATION) : FAST_ACTIVE_NOTIFICATION, 'info');
    } else if (state === 'inactive') {
      context.ui.notify('Fast is inactive: this model is not eligible for priority processing.', 'warning');
    } else {
      context.ui.notify('Fast off: this extension will not request priority processing.', 'info');
    }
  }
}

export { FAST_ENV_NAME };

export const FAST_STATUS_CONSTANTS = {
  provider: FAST_PROVIDER,
  api: FAST_API,
  baseUrl: FAST_BASE_URL,
  serviceTier: PRIORITY_SERVICE_TIER,
  maxPendingTickets: MAX_PENDING_TICKETS,
} as const;
