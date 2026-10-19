import type { ExtensionAPI, ExtensionFactory, InlineExtension, ResourceLoader } from '@earendil-works/pi-coding-agent';

export type ManagedExtensionAgentType = 'main' | 'subagent' | 'unknown';
export type MachineExtensionContext = { settingsFile: string; agentType: ManagedExtensionAgentType };
export type MachineExtensionCapability = {
  capability: 'fast' | 'async_compaction';
  status: 'active' | 'inactive';
  reason: 'available' | 'no_bundle' | 'missing_package' | 'import_failed' | 'peer_incompatible' | 'legacy_loader' | 'unbound_factory' | 'conflict' | 'unsupported_host';
};

export type ManagedExtensionHandle = {
  name: string;
  generation: number;
  started: boolean;
  invalid: boolean;
  close(deadline: number): Promise<void>;
};
export type ManagedExtensionSet = {
  extensions: InlineExtension[];
  capabilities: MachineExtensionCapability[];
  handles?: ManagedExtensionHandle[];
  shutdown(deadline: number): Promise<void>;
};
export interface MachineExtensionsBundleV1 {
  version: 1;
  create(context: MachineExtensionContext): Promise<ManagedExtensionSet> | ManagedExtensionSet;
}
export type ResourceLoaderFactoryContext = {
  createDefault(options?: Record<string, unknown>): ResourceLoader;
  /** Accept only resources created by this controlled Runtime seam. */
  adoptResource<T extends object>(expected: T, incoming: T): T;
};

/** Private seam shared by the Runtime and the two package-local factories. */
export type ManagedFactory = ExtensionFactory & {
  managedShutdown?: (deadline: number) => Promise<void>;
};

function fixedDiagnostic(): void {
  try { process.stderr.write('[pi] managed extension cleanup unavailable\n'); } catch { /* stderr is diagnostic only */ }
}

export function inactiveMachineCapabilities(reason: MachineExtensionCapability['reason'] = 'no_bundle'): MachineExtensionCapability[] {
  return [
    { capability: 'fast', status: 'inactive', reason },
    { capability: 'async_compaction', status: 'inactive', reason },
  ];
}

function reportCapability(report: ((capability: MachineExtensionCapability) => void) | undefined, capability: MachineExtensionCapability): void {
  try { report?.(capability); } catch { fixedDiagnostic(); }
}

function extensionName(extension: InlineExtension, index: number): string {
  return typeof extension === 'function'
    ? `inline-${index}`
    : typeof extension.name === 'string' && extension.name.length > 0 ? extension.name : `inline-${index}`;
}

/**
 * Loads the controlled bundle and turns each factory's real package cleanup
 * into a Runtime-owned handle. The Runtime never imports an optional package.
 */
export async function loadMachineExtensionsBundle(
  context: MachineExtensionContext,
  options: { bundle?: MachineExtensionsBundleV1; report?: (capability: MachineExtensionCapability) => void } = {},
): Promise<ManagedExtensionSet> {
  if (!options.bundle || options.bundle.version !== 1 || typeof options.bundle.create !== 'function') {
    const capabilities = inactiveMachineCapabilities();
    capabilities.forEach(capability => reportCapability(options.report, capability));
    return { extensions: [], capabilities, handles: [], shutdown: async () => {} };
  }

  try {
    const result = await options.bundle.create(context);
    if (!result || !Array.isArray(result.extensions) || typeof result.shutdown !== 'function' || !Array.isArray(result.capabilities)) {
      throw new Error('unbound_factory');
    }

    const names = new Set<string>();
    const handles: ManagedExtensionHandle[] = [];
    const extensions = result.extensions.map((extension, index) => {
      const name = extensionName(extension, index);
      if (names.has(name)) throw new Error('extension_conflict');
      names.add(name);
      const source = (typeof extension === 'function' ? extension : extension.factory) as ManagedFactory;
      const descriptor = typeof extension === 'function' ? undefined : extension;
      let closed = false;
      const handle: ManagedExtensionHandle = {
        name,
        generation: 1,
        started: false,
        invalid: false,
        close: async (deadline) => {
          if (closed) return;
          closed = true;
          handle.invalid = true;
          // Package-local cleanup is real and idempotent. A factory without
          // this seam remains loadable but is not allowed to claim cleanup.
          if (source.managedShutdown) await source.managedShutdown(deadline);
          await Promise.resolve();
        },
      };
      handles.push(handle);
      const wrapped = (async (pi: Parameters<typeof source>[0]) => {
        if (handle.invalid) return;
        handle.started = true;
        await source(pi);
      }) as ManagedFactory;
      if (source.managedShutdown) wrapped.managedShutdown = source.managedShutdown;
      return descriptor ? { ...descriptor, factory: wrapped } : wrapped;
    });

    const capabilities = result.capabilities.filter((capability): capability is MachineExtensionCapability => Boolean(
      capability && (capability.status === 'active' || capability.status === 'inactive'),
    ));
    capabilities.forEach(capability => reportCapability(options.report, capability));
    let closed = false;
    return {
      ...result,
      extensions,
      handles,
      shutdown: async (deadline) => {
        if (closed) return;
        closed = true;
        let firstError: unknown;
        for (const handle of handles) {
          try { await handle.close(deadline); } catch (error) { firstError ??= error; }
        }
        try { await result.shutdown(deadline); } catch (error) { firstError ??= error; }
        if (firstError !== undefined) throw firstError;
      },
    };
  } catch (error) {
    const reason = error instanceof Error && error.message === 'extension_conflict' ? 'conflict' : error instanceof Error && error.message === 'unbound_factory' ? 'unbound_factory' : 'import_failed';
    const capabilities = inactiveMachineCapabilities(reason);
    capabilities.forEach(capability => reportCapability(options.report, capability));
    return { extensions: [], capabilities, handles: [], shutdown: async () => {} };
  }
}

/**
 * Ownership tracker for the controlled resource seam. Foreign objects are
 * rejected, never instrumented or invalidated. Legacy callers can omit it and
 * keep their original caller-owned contract.
 */
export class ManagedOwnershipTracker<T extends object> {
  private readonly owned = new Set<T>();
  private readonly invalidated = new WeakSet<object>();

  own(resource: T): T {
    this.owned.add(resource);
    return resource;
  }

  adopt(expected: T, incoming: T): T {
    if (incoming !== expected) throw new Error('foreign_managed_resource');
    this.owned.add(incoming);
    return incoming;
  }

  isOwned(resource: object): boolean { return this.owned.has(resource as T); }

  invalidate(resource: T, invalidate: (resource: T) => void): void {
    if (!this.owned.has(resource) || this.invalidated.has(resource)) return;
    this.invalidated.add(resource);
    try { invalidate(resource); } finally { this.owned.delete(resource); }
  }

  invalidateAll(invalidate: (resource: T) => void): void {
    for (const resource of [...this.owned]) this.invalidate(resource, invalidate);
  }
}

/**
 * Public SDK lifecycle adapter. It only wraps public AgentSession APIs and the
 * public ExtensionRunner.emit/reload seams; it never touches private runner
 * fields or invents event metadata.
 */
export class ManagedSessionRuntime {
  private readonly safeError: () => void;
  private readonly onReloadFailure?: () => Promise<void>;
  private readonly wrappedRunners = new WeakSet<object>();
  private readonly runnerStates = new WeakMap<object, { startEntered: boolean; started: boolean; shutdownEntered: boolean; shutdownCompleted: boolean }>();
  private readonly originalReload = new WeakMap<object, (...args: any[]) => Promise<unknown>>();
  private readonly ownedRunnerResources = new ManagedOwnershipTracker<object>();
  private shutdownEmitted = false;

  constructor(safeError: () => void = fixedDiagnostic, onReloadFailure?: () => Promise<void>) {
    this.safeError = safeError;
    this.onReloadFailure = onReloadFailure;
  }

  bind(session: {
    bindExtensions?: (bindings: { mode: 'print'; onError: () => void }) => Promise<void>;
    extensionRunner?: { emit: (event: unknown) => Promise<unknown> };
    reload?: (options?: { beforeSessionStart?: () => void | Promise<void> }) => Promise<void>;
  }): Promise<void> {
    if (typeof session.bindExtensions !== 'function') return Promise.resolve();
    this.wrapSession(session);
    return session.bindExtensions({ mode: 'print', onError: () => this.safeError() });
  }

  wrapSession(session: {
    extensionRunner?: { emit: (event: unknown) => Promise<unknown> };
    reload?: (options?: { beforeSessionStart?: () => void | Promise<void> }) => Promise<void>;
  }): void {
    this.wrapRunner(session.extensionRunner);
    if (typeof session.reload !== 'function' || this.originalReload.has(session)) return;
    const original = session.reload.bind(session) as (...args: any[]) => Promise<unknown>;
    this.originalReload.set(session, original);
    session.reload = (async (options?: { beforeSessionStart?: () => void | Promise<void> }) => {
      try {
        return await original({
          ...options,
          beforeSessionStart: async () => {
            // SDK 1.1 creates the replacement runner before this public hook.
            this.wrapRunner(session.extensionRunner);
            await options?.beforeSessionStart?.();
          },
        });
      } catch (error) {
        this.invalidateOwned();
        try { await this.onReloadFailure?.(); } catch { this.safeError(); }
        throw error;
      }
    }) as typeof session.reload;
  }

  private wrapRunner(runner: { emit: (event: unknown) => Promise<unknown> } | undefined): void {
    if (!runner || this.wrappedRunners.has(runner)) return;
    this.wrappedRunners.add(runner);
    this.runnerStates.set(runner, { startEntered: false, started: false, shutdownEntered: false, shutdownCompleted: false });
    const emit = runner.emit.bind(runner);
    runner.emit = async (event: unknown) => {
      const type = typeof event === 'object' && event !== null ? (event as { type?: unknown }).type : undefined;
      const state = this.runnerStates.get(runner)!;
      if (type === 'session_start') {
        state.startEntered = true;
        this.ownedRunnerResources.own(runner);
        try {
          const result = await emit(event);
          state.started = true;
          return result;
        } catch (error) { throw error; }
      }
      if (type === 'session_shutdown') {
        state.shutdownEntered = true;
        try {
          const result = await emit(event);
          state.shutdownCompleted = true;
          return result;
        } catch (error) { throw error; }
      }
      return emit(event);
    };
  }

  adoptResource<T extends object>(expected: T, incoming: T): T {
    return this.ownedRunnerResources.adopt(expected as object, incoming as object) as T;
  }

  async emitShutdown(session: { extensionRunner?: { emit: (event: unknown) => Promise<unknown> } }, deadline = performance.now() + 1000): Promise<void> {
    if (this.shutdownEmitted) return;
    const runner = session.extensionRunner;
    if (!runner) return;
    const state = this.runnerStates.get(runner);
    if (!state?.started || state.shutdownEntered) return;
    this.shutdownEmitted = true;
    let late: Promise<unknown>;
    try { late = runner.emit({ type: 'session_shutdown', reason: 'quit' }); }
    catch { this.safeError(); return; }
    const remaining = Math.max(0, deadline - performance.now());
    await Promise.race([
      late.then(() => undefined, () => { this.safeError(); }),
      new Promise<void>(resolve => setTimeout(resolve, remaining)),
    ]);
    // Observe a handler that outlives the common budget without waiting for it.
    void late.then(() => undefined, () => this.safeError());
  }

  invalidateOwned(): void {
    this.ownedRunnerResources.invalidateAll(runner => {
      try { (runner as { invalidate?: (message?: string) => void }).invalidate?.('managed runtime closed'); } catch { this.safeError(); }
    });
  }
}

export function composeResourceLoaderOptions(context: ResourceLoaderFactoryContext, options: Record<string, unknown>, extensions: InlineExtension[]): Record<string, unknown> {
  const created = context.createDefault({ ...options, extensionFactories: extensions });
  if (!created || typeof created !== 'object') throw new Error('resource_loader_factory_failed');
  return { ...(options as Record<string, unknown>), extensionFactories: extensions };
}
