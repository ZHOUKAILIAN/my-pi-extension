// Keep the producer's wire values stable without making its package a load-time
// requirement. The parser itself is always obtained from the producer's public
// ./interop export before any event can enable Fast.
export const FAST_ENV_NAME = "PI_CODEX_FAST";
export const FAST_REQUESTED_EVENT = "@pi/codex-usage-status:fast-requested/v1";

export interface FastRequestedEvent {
  version: 1;
  sessionId: string;
  requested: boolean;
}

export interface FastInterop {
  readonly parseFastRequestedEvent: (value: unknown) => FastRequestedEvent | undefined;
}

export async function loadFastInterop(): Promise<FastInterop | undefined> {
  try {
    const producer = await import("@pi/codex-usage-status/interop");
    if (producer.FAST_ENV_NAME !== FAST_ENV_NAME || producer.FAST_REQUESTED_EVENT !== FAST_REQUESTED_EVENT || typeof producer.parseFastRequestedEvent !== "function") {
      return undefined;
    }
    return { parseFastRequestedEvent: producer.parseFastRequestedEvent };
  } catch {
    // The producer is an optional peer. A standalone subagent package must
    // still load and must keep Fast disabled when it is unavailable.
    return undefined;
  }
}

export interface FastEventBus {
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface FastAgentLike {
  name: string;
  source: "user" | "project";
  codexFast?: string;
}

export function isFastInheritanceEligible(agent: FastAgentLike): boolean {
  return agent.source === "user" && (agent.name === "implementer" || agent.name === "code_reviewer") && agent.codexFast === "inherit";
}

export interface SpawnEnvironmentOptions {
  agent: FastAgentLike;
  firstLogicalChildSpawn: boolean;
  parentSessionRequestedFast: boolean;
  baseEnv?: NodeJS.ProcessEnv;
}

/** Always removes ambient Fast. The only positive path is the exact first-spawn contract. */
export function createChildEnvironment(options: SpawnEnvironmentOptions): NodeJS.ProcessEnv {
  const env = { ...(options.baseEnv ?? process.env) };
  delete env[FAST_ENV_NAME];
  if (options.firstLogicalChildSpawn && options.parentSessionRequestedFast && isFastInheritanceEligible(options.agent)) {
    env[FAST_ENV_NAME] = "1";
  }
  return env;
}

export class FastInheritanceConsumer {
  private parentSessionId: string | undefined;
  private requested = false;
  private readonly interopPromise: Promise<FastInterop | undefined>;
  private interop: FastInterop | undefined;
  private readonly pendingEvents: unknown[] = [];
  private readonly requestedBySession = new Map<string, boolean>();
  private disposed = false;
  private unsubscribe?: () => void;
  readonly ready: Promise<void>;

  constructor(events: FastEventBus | undefined, parentSessionId?: string, interop?: FastInterop | Promise<FastInterop | undefined>) {
    this.parentSessionId = parentSessionId;
    this.interopPromise = interop === undefined ? loadFastInterop() : Promise.resolve(interop);
    this.ready = this.interopPromise.then((loaded) => {
      if (this.disposed) return;
      this.interop = loaded;
      if (!loaded) return;
      for (const value of this.pendingEvents) this.consume(value, loaded);
      this.pendingEvents.length = 0;
    });
    this.unsubscribe = events?.on(FAST_REQUESTED_EVENT, (value) => {
      if (this.interop) this.consume(value, this.interop);
      else {
        this.pendingEvents.push(value);
        if (this.pendingEvents.length > 16) this.pendingEvents.shift();
      }
    });
  }

  bind(parentSessionId: string): void {
    this.parentSessionId = parentSessionId;
    this.requested = this.requestedBySession.get(parentSessionId) ?? false;
    this.requestedBySession.clear();
  }

  private consume(value: unknown, interop: FastInterop): void {
    let event: FastRequestedEvent | undefined;
    try { event = interop.parseFastRequestedEvent(value); } catch { return; }
    if (!event) return;
    if (event.sessionId === this.parentSessionId) {
      this.requested = event.requested;
      return;
    }
    if (this.parentSessionId === undefined) {
      this.requestedBySession.set(event.sessionId, event.requested);
      if (this.requestedBySession.size > 16) this.requestedBySession.delete(this.requestedBySession.keys().next().value!);
    }
  }

  get requestedFast(): boolean { return this.requested; }

  environment(agent: FastAgentLike, firstLogicalChildSpawn: boolean, baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return createChildEnvironment({ agent, firstLogicalChildSpawn, parentSessionRequestedFast: this.requested, baseEnv });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.pendingEvents.length = 0;
    this.requestedBySession.clear();
    this.requested = false;
  }
}
