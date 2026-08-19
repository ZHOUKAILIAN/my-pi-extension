import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import {
  WorkflowRuntime,
  bugFixDefinition,
  bugFixNodes,
  PiSessionRunStore,
  InMemoryUserDecisionGate,
  type UserDecisionArtifact,
  type WorkerExecutor,
} from '@pi/workflow-runtime';

/** 命令只编排显式操作；未注入 worker 时绝不偷偷调用模型。 */
export default function bugFixExtension(pi: ExtensionAPI) {
  const worker = (pi as ExtensionAPI & { bugFixWorker?: WorkerExecutor }).bugFixWorker;

  pi.registerCommand('bugFix', {
    description: 'Start/resume/decision for bug fix workflow',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const store = new PiSessionRunStore(ctx.sessionManager, (type, data) => pi.appendEntry(type, data));
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const operation = parts[0] ?? 'start';
      const requestedRunId = parts.find((part) => part.startsWith('runId='))?.slice(6);
      const runId = requestedRunId ?? store.latestRunId() ?? `bugFix-${Date.now()}`;
      const runtime = WorkflowRuntime.restore(bugFixDefinition, store, runId);

      if (operation === 'decision') {
        const latest = store.loadLast(runId);
        const requestId = parts.find((part) => part.startsWith('requestId='))?.slice(10);
        // decision 必须校验 requestId，防止旧请求或伪造请求改变状态。
        if (runtime.stage !== 'WAITING_FOR_USER' || latest?.pendingDecisionRequest !== requestId) {
          ctx.ui.notify('invalid or stale decision request');
          return;
        }
        const gate = new InMemoryUserDecisionGate();
        gate.decide({ kind: 'user_decision', decision: 'continue_investigating', requestId, source: 'command' } as UserDecisionArtifact);
        runtime.setDecisionGate(gate);
        runtime.resume();
        ctx.ui.notify(`resumed ${runId}`);
        return;
      }

      if (operation !== 'start' && operation !== 'resume') {
        ctx.ui.notify('usage: /bugFix start|resume|decision runId=... requestId=...');
        return;
      }
      if (!worker) {
        // 无 worker 时不执行模型，命令只创建初始 checkpoint。
        if (!store.loadLast(runId)) {
          store.saveCheckpoint({ runId, stage: runtime.stage, at: Date.now(), id: `${runId}-initial` });
        }
        ctx.ui.notify(`${operation}d; no WorkerExecutor/model configured, no model was executed`);
        return;
      }
      if (operation === 'start' && !store.loadLast(runId)) {
        store.saveCheckpoint({ runId, stage: runtime.stage, at: Date.now(), id: `${runId}-initial` });
      }

      const nodes = bugFixNodes(worker);
      while (runtime.stage !== 'ACCEPTED' && runtime.stage !== 'WAITING_FOR_USER') {
        // BLOCKED 也必须回到 investigate；合法新证据由 Guard 放行，不能永久卡死。
        const node = runtime.stage === 'INVESTIGATING' || runtime.stage === 'BLOCKED'
          ? nodes.investigate
          : runtime.stage === 'IMPLEMENTING' ? nodes.implement : nodes.verify;
        await runtime.runNode(node, runtime.stage.toLowerCase(), {});
      }
      ctx.ui.notify(`${runtime.stage}: ${runId}`);
    },
  });
}

export { bugFixDefinition };
