import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { dirname } from 'node:path';
import { readMachinePreference, readMachinePreferenceSync, updateMachinePreference, settingsFile } from './machine-settings.ts';
import { FastController, type FastContextLike } from './fast.ts';
import { captureFastEnabledEvent, commitFastEnabledEvent, type FastEnabledRecord } from './fast-enabled-event.ts';
import { createMetricScope, drainLocal, noteMetricFailure, submitMetric, shutdownDeadline } from '@pi/project-metrics/client';
import { UsageController, type UsageContextLike, type UsageModelLike } from './usage.ts';

function asUsageContext(context: ExtensionContext): UsageContextLike {
  return context as unknown as UsageContextLike;
}

function asFastContext(context: ExtensionContext): FastContextLike {
  return context as unknown as FastContextLike;
}

export {
  FastController,
  FAST_ENV_NAME,
  FAST_COST_CORRECTION_MODEL_IDS,
  FAST_STATUS_CONSTANTS,
  formatFastDisplay,
  getFastState,
  isFastEligible,
} from './fast.ts';
export {
  consumeFastBootstrap,
  FAST_REQUESTED_EVENT,
  parseFastRequestedEvent,
  publishFastRequested,
} from './interop.ts';
export type { FastEventBusLike, FastRequestedEvent } from './interop.ts';
export type { FastContextLike, FastDisplaySnapshot, FastDisplayTheme, FastState } from './fast.ts';
export { UsageController, fetchUsageSnapshot, formatProgressBar, formatUsageSnapshot, parseUsagePayload, USAGE_STATUS_CONSTANTS } from './usage.ts';
export type {
  Availability,
  FetchLike,
  FetchUsageOptions,
  UsageContextLike,
  UsageDisplaySnapshot,
  UsageModelLike,
  UsageThemeLike,
  UsageWidgetFactory,
  UsageWidgetLike,
  UsageWindow,
} from './usage.ts';

export type ManagedExtensionContext = { settingsFile: string; agentType: 'main' | 'subagent' | 'unknown' };
type ManagedCleanup = { shutdown(deadline: number): Promise<void> };
type ManagedFactory = ((pi: ExtensionAPI) => void | Promise<void>) & { managedShutdown?: (deadline: number) => Promise<void> };
export function createManagedExtensionFactory(context: ManagedExtensionContext): ManagedFactory {
  const generations = new Set<ManagedCleanup>();
  const factory = ((pi: ExtensionAPI) => {
    const cleanup = codexUsageStatusExtension(pi, { settingsFile: context.settingsFile, agentType: context.agentType });
    generations.add(cleanup);
  }) as ManagedFactory;
  factory.managedShutdown = async (deadline) => {
    let firstError: unknown;
    for (const cleanup of [...generations]) {
      try { await cleanup.shutdown(deadline); } catch (error) { firstError ??= error; }
    }
    if (firstError !== undefined) throw firstError;
  };
  return factory;
}
export default function codexUsageStatusExtension(pi: ExtensionAPI, dependencies: { writeFastEnabledEvent?: (record: FastEnabledRecord) => Promise<FastEnabledRecord>; submitMetric?: typeof submitMetric; settingsFile?: string; agentType?: 'main' | 'subagent' | 'unknown' } = {}): ManagedCleanup {
  const metricAgentDir = dependencies.settingsFile ? dirname(dependencies.settingsFile) : getAgentDir();
  const enqueueMetric = dependencies.submitMetric ?? submitMetric;
  const usageController = new UsageController();
  const fastController = new FastController(false);
  const machinePreferenceFile = settingsFile(dependencies.settingsFile);
  let commandIntent = fastController.requestedOn;
  let observedMachineValue: boolean | undefined;
  let preferenceQueue: Promise<unknown> = Promise.resolve();
  const canUseMachinePreference = (_context: FastContextLike) => true;
  const applyMachineValue = (value: boolean, context: FastContextLike, announce = false) => {
    const previous = fastController.requestedOn;
    commandIntent = value;
    fastController.setRequested(value, context, announce);
  };
  const refreshPreference = async (context: FastContextLike, initialize = false) => {
    const result = await readMachinePreference('fast', machinePreferenceFile);
    if (!result.valid) {
      // A bad read is fail-closed for request rewriting but never rewrites the machine file.
      observedMachineValue = undefined;
      if (initialize) applyMachineValue(false, context);
      return { requested: false, changed: false, readFailed: true, saved: false };
    }
    const value = result.value ?? false;
    const changed = observedMachineValue !== undefined && observedMachineValue !== value;
    observedMachineValue = value;
    if (initialize || commandIntent !== value || fastController.requestedOn !== value) applyMachineValue(value, context);
    return { requested: value, changed, readFailed: false, saved: true };
  };
  const refreshPreferenceSync = (context: FastContextLike) => {
    const result = readMachinePreferenceSync('fast', machinePreferenceFile);
    if (!result.valid) { applyMachineValue(false, context); return false; }
    const value = result.value ?? false; observedMachineValue = value; if (fastController.requestedOn !== value) applyMachineValue(value, context); return true;
  };
  let metricScope = createMetricScope();
  const pending = new Set<Promise<void>>();
  let closed = false;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (deadline: number): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    const scope = metricScope;
    scope.close();
    shutdownPromise = (async () => {
      let firstError: unknown;
      for (const cleanup of [() => fastController.shutdown(), () => usageController.shutdown()]) {
        try { await cleanup(); } catch (error) { firstError ??= error; }
      }
      const complete = await drainLocal(Math.max(0, deadline - performance.now()), pending);
      if (!complete || performance.now() >= deadline) noteMetricFailure();
      if (firstError !== undefined) throw firstError;
    })();
    return shutdownPromise;
  };
  const rotateScope = () => { metricScope.close(); metricScope = createMetricScope(); };
  const warn = (context: FastContextLike, scope: typeof metricScope) => {
    if (scope.closed || scope !== metricScope) return;
    try { context.ui.notify('本次计量记录无法确认', 'warning'); } catch { /* the original command error remains authoritative */ }
  };
  const recordInBackground = (context: FastContextLike) => {
    const scope = metricScope;
    if (pending.size >= 32) { noteMetricFailure(); warn(context, scope); return; }
    let fact: FastEnabledRecord;
    let agentDir: string | undefined;
    try { fact = captureFastEnabledEvent(); if (!dependencies.writeFastEnabledEvent) agentDir = metricAgentDir; }
    catch { noteMetricFailure(); warn(context, scope); return; }
    // The fact is captured now, but both writer and outbox start in the next turn.
    // This registration has no file access and never enters the command's await chain.
    const task = new Promise<void>(resolve => { setImmediate(resolve); }).then(async () => {
      let wrote = false;
      try {
        const committed = await (dependencies.writeFastEnabledEvent ? dependencies.writeFastEnabledEvent(fact) : commitFastEnabledEvent(fact, agentDir));
        if (committed.eventId !== fact.eventId || committed.occurredAt !== fact.occurredAt || committed.source !== fact.source || committed.schemaVersion !== fact.schemaVersion) throw new Error('metrics_record_mismatch');
        wrote = true;
        await enqueueMetric(Object.freeze({ schemaVersion: 1, eventId: fact.eventId, kind: 'fast_enabled', occurredAt: fact.occurredAt, dataset: 'live' }), scope);
      } catch {
        if (!wrote) noteMetricFailure();
        warn(context, scope);
      }
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  pi.registerCommand('fast', {
    description: 'Toggle Codex Fast priority processing: /fast [on|off]',
    handler: async (args, context) => {
      const fastContext = asFastContext(context);
      const parts = args.trim() === '' ? [] : args.trim().split(/\s+/u);
      const action = parts[0] ?? 'toggle';
      const valid = parts.length <= 1 && (parts.length === 0 || action === 'on' || action === 'off');
      let commandTransition = false;
      let commandError: unknown;
      await (preferenceQueue = preferenceQueue.then(async () => {
        const beforeRefresh = fastController.requestedOn;
        const disk = await readMachinePreference('fast', machinePreferenceFile);
        if (disk.valid) { observedMachineValue = disk.value ?? false; applyMachineValue(observedMachineValue, fastContext); }
        else applyMachineValue(false, fastContext);
        if (!valid || !fastContext.hasUI) { fastController.handleCommand(args, fastContext); return; }
        const target = action === 'on' ? true : action === 'off' ? false : !fastController.requestedOn;
        commandTransition = !beforeRefresh && target;
        try { applyMachineValue(target, fastContext, true); } catch (error) { commandError ??= error; }
        const saved = await updateMachinePreference('fast', target, machinePreferenceFile);
        observedMachineValue = saved.saved ? target : observedMachineValue;
        if (!saved.saved) { try { fastContext.ui.notify('Fast 仅当前实例生效；本机偏好保存无法确认。', 'warning'); } catch {} }
      }).catch((error) => { commandError ??= error; }));
      usageController.updateFastDisplay(fastController.getDisplaySnapshot());
      if (commandTransition) recordInBackground(fastContext);
      if (commandError !== undefined) throw commandError;
    },
  });

  pi.on('session_start', async (_event, context) => {
    rotateScope();
    const fastContext = asFastContext(context);
    const result = await refreshPreference(fastContext, true);
    if (result.readFailed && context.hasUI) { try { context.ui.notify('Fast 本机设置读取失败；当前请求保持关闭。', 'warning'); } catch {} }
    fastController.handle(fastContext);
    usageController.handle(asUsageContext(context), undefined, false, fastController.getDisplaySnapshot());
  });

  pi.on('input', async (_event, context) => {
    const fastContext = asFastContext(context);
    await refreshPreference(fastContext);
    fastController.handle(fastContext);
    usageController.handle(asUsageContext(context), undefined, false, fastController.getDisplaySnapshot());
  });

  pi.on('model_select', (event, context) => {
    const fastContext = asFastContext(context);
    fastController.handle(fastContext, event.model, true);
    usageController.handle(asUsageContext(context), event.model as UsageModelLike, true, fastController.getDisplaySnapshot());
  });

  pi.on('agent_settled', (_event, context) => {
    const fastContext = asFastContext(context);
    fastController.handle(fastContext);
    usageController.handle(asUsageContext(context), undefined, false, fastController.getDisplaySnapshot());
  });

  pi.on('before_provider_request', (event, context) => {
    try { if (!refreshPreferenceSync(asFastContext(context))) return undefined; } catch { return undefined; }
    return fastController.rewriteProviderPayload(event.payload, asFastContext(context));
  });

  pi.on('message_end', (event, context) => {
    return fastController.rewriteAssistantMessage(event.message, asFastContext(context));
  });

  // Before-events can be cancelled. Tree navigation stays in the same session
  // and has no session_start; rotate only after it actually succeeds.
  pi.on('session_tree', () => { rotateScope(); });
  pi.on('session_shutdown', async (event) => {
    await shutdown(shutdownDeadline(event as object, 1000));
  });
  return { shutdown };
}
