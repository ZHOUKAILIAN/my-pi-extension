import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FastController, type FastContextLike } from './fast.ts';
import { captureFastEnabledEvent, commitFastEnabledEvent, type FastEnabledRecord } from './fast-enabled-event.ts';
import { createMetricScope, drainLocal, noteMetricFailure, submitMetric } from '@pi/project-metrics/client';
import {
  consumeFastBootstrap,
  FAST_REQUESTED_EVENT,
  publishFastRequested,
  type FastEventBusLike,
} from './interop.ts';
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
  FAST_MODEL_IDS,
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

function sessionId(context: FastContextLike): string | undefined {
  try {
    const id = context.sessionManager?.getSessionId();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

function publishRequested(pi: ExtensionAPI, context: FastContextLike, requested: boolean): void {
  publishFastRequested(pi.events as FastEventBusLike, sessionId(context), requested);
}

export default function codexUsageStatusExtension(pi: ExtensionAPI, dependencies: { writeFastEnabledEvent?: (record: FastEnabledRecord) => Promise<FastEnabledRecord>; submitMetric?: typeof submitMetric } = {}): void {
  const enqueueMetric = dependencies.submitMetric ?? submitMetric;
  const usageController = new UsageController();
  const fastController = new FastController(consumeFastBootstrap());
  let metricScope = createMetricScope();
  const pending = new Set<Promise<void>>();
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
    try { fact = captureFastEnabledEvent(); if (!dependencies.writeFastEnabledEvent) agentDir = getAgentDir(); }
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
    description: 'Toggle Codex Fast priority processing: /fast [on|off|toggle|status]',
    handler: async (args, context) => {
      const fastContext = asFastContext(context);
      const previouslyRequested = fastController.requestedOn;
      try {
        if (fastController.handleCommand(args, fastContext)) {
          publishRequested(pi, fastContext, fastController.requestedOn);
        }
        usageController.updateFastDisplay(fastController.getDisplaySnapshot());
      } finally {
        // A notification or bus listener can throw after the intent has already changed.
        if (fastContext.hasUI && !previouslyRequested && fastController.requestedOn) recordInBackground(fastContext);
      }
    },
  });

  pi.on('session_start', (_event, context) => {
    rotateScope();
    const fastContext = asFastContext(context);
    fastController.handle(fastContext);
    usageController.handle(asUsageContext(context), undefined, false, fastController.getDisplaySnapshot());
    publishRequested(pi, fastContext, fastController.requestedOn);
  });

  pi.on('input', (_event, context) => {
    const fastContext = asFastContext(context);
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
    return fastController.rewriteProviderPayload(event.payload, asFastContext(context));
  });

  pi.on('message_end', (event, context) => {
    return fastController.rewriteAssistantMessage(event.message, asFastContext(context));
  });

  // Before-events can be cancelled. Tree navigation stays in the same session
  // and has no session_start; rotate only after it actually succeeds.
  pi.on('session_tree', () => { rotateScope(); });
  pi.on('session_shutdown', async (_event, context) => {
    const started = Date.now();
    const scope = metricScope;
    scope.close();
    let failed = false;
    let original: unknown;
    for (const cleanup of [() => publishRequested(pi, asFastContext(context), false), () => usageController.shutdown(), () => fastController.shutdown()]) {
      try { cleanup(); } catch (error) { if (!failed) { failed = true; original = error; } }
    }
    // One wall-clock budget for both the Fast writer and the metrics outbox.
    const complete = await drainLocal(Math.max(0, 1000 - (Date.now() - started)), pending);
    if (!complete) noteMetricFailure();
    if (failed) throw original;
  });
}
