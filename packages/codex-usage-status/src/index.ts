import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { UsageController, type UsageContextLike, type UsageModelLike } from './usage.ts';

function asUsageContext(context: ExtensionContext): UsageContextLike {
  return context as unknown as UsageContextLike;
}

export { UsageController, fetchUsageSnapshot, formatProgressBar, formatUsageSnapshot, parseUsagePayload, USAGE_STATUS_CONSTANTS } from './usage.ts';
export type {
  Availability,
  FetchLike,
  FetchUsageOptions,
  UsageContextLike,
  UsageDisplaySnapshot,
  UsageModelLike,
  UsageThemeLike,
  UsageWindow,
} from './usage.ts';

export default function codexUsageStatusExtension(pi: ExtensionAPI): void {
  const controller = new UsageController();

  pi.on('session_start', (_event, context) => {
    controller.handle(asUsageContext(context));
  });

  pi.on('input', (_event, context) => {
    controller.handle(asUsageContext(context));
  });

  pi.on('model_select', (event, context) => {
    controller.handle(asUsageContext(context), event.model as UsageModelLike, true);
  });

  pi.on('agent_settled', (_event, context) => {
    controller.handle(asUsageContext(context));
  });

  pi.on('session_shutdown', () => {
    controller.shutdown();
  });
}
