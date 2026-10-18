import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FastController, type FastContextLike } from './fast.ts';
import { writeFastEnabledEvent } from './fast-enabled-event.ts';
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

export default function codexUsageStatusExtension(pi: ExtensionAPI): void {
  const usageController = new UsageController();
  const fastController = new FastController(consumeFastBootstrap());

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
        if (fastContext.hasUI && !previouslyRequested && fastController.requestedOn) {
          try {
            await writeFastEnabledEvent();
          } catch {
            try {
              fastContext.ui.notify('本次计量记录无法确认', 'warning');
            } catch {
              // A failed safety notice must not replace the command's original error.
            }
          }
        }
      }
    },
  });

  pi.on('session_start', (_event, context) => {
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

  pi.on('session_shutdown', (_event, context) => {
    publishRequested(pi, asFastContext(context), false);
    usageController.shutdown();
    fastController.shutdown();
  });
}
