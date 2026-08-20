import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { WorkflowRuntime, bugFixDefinition, bugFixNodes, PiSessionRunStore, InMemoryUserDecisionGate, PiSdkWorkerExecutor, type UserDecisionArtifact, type WorkerExecutor } from '@pi/workflow-runtime';
import { loadModelPolicy, parseBugFixCommand, resolveModelRef } from './policy.ts';

export default function bugFixExtension(pi: ExtensionAPI) {
  const injected = (pi as ExtensionAPI & { bugFixWorker?: WorkerExecutor }).bugFixWorker;

  const prepareRun = (ctx: ExtensionCommandContext) => {
    // Older harnesses/hosts may not expose trust; retain the historical trusted default.
    const trusted = typeof (ctx as any).isProjectTrusted === 'function' ? (ctx as any).isProjectTrusted() : true;
    const policy = loadModelPolicy(trusted ? `${ctx.cwd}/.pi/workflow-models.json` : '/definitely/missing/workflow-models.json');
    const resolvedThinkingLevel = (ctx as any).thinkingLevel;
    const nodes = ['investigate', 'implement', 'verify'] as const;
    const workers: Record<string, WorkerExecutor> = {};
    const definitions: Record<string, ReturnType<typeof bugFixNodes>[string]> = {};
    const audits: any[] = [];
    for (const nodeId of nodes) {
      const configuredRef = policy.nodes[nodeId].configuredRef;
      const registry = (ctx as any).modelRegistry ?? {
        find: (provider: string, id: string) => injected && policy.nodes[nodeId].source === 'runtime-default' ? { provider, id } : undefined,
      };
      const resolved = resolveModelRef(configuredRef, (ctx as any).model ?? (injected ? { provider: 'injected', id: 'bugFixWorker' } : undefined), registry);
      const model = injected ? ((ctx as any).model ?? resolved) : resolved;
      const worker = injected ?? new PiSdkWorkerExecutor({ model, thinkingLevel: resolvedThinkingLevel, skills: policy.nodes[nodeId].skills, cwd: ctx.cwd });
      const definition = bugFixNodes(worker, { [nodeId]: policy.nodes[nodeId].skills })[nodeId];
      workers[nodeId] = worker;
      definitions[nodeId] = definition;
      audits.push({ runNode: nodeId, source: policy.nodes[nodeId].source, configuredRef, resolved: { provider: model.provider, id: model.id }, thinkingLevel: resolvedThinkingLevel, skills: definition.profile?.skills, tools: definition.profile?.tools });
    }
    return { policy, workers, definitions, audits, resolvedThinkingLevel };
  };

  const continueRun = async (ctx: ExtensionCommandContext, store: PiSessionRunStore, runId: string, problem: string, prepared: ReturnType<typeof prepareRun>, confirmationAlreadyGiven = false) => {
    for (const audit of prepared.audits) {
      const { runNode, ...data } = audit;
      pi.appendEntry('workflow-model-policy', { runId, nodeId: runNode, ...data });
    }
    const { workers, definitions } = prepared;
    const runtime = WorkflowRuntime.restore(bugFixDefinition, store, runId);
    let blockedInputUsed = false;
    let waitingUsed = false;
    let confirmationPending = confirmationAlreadyGiven;
    while (runtime.stage !== 'ACCEPTED') {
      if (runtime.stage === 'WAITING_FOR_USER') {
        if (waitingUsed || !ctx.hasUI || (!confirmationPending && !(await ctx.ui.confirm('Workflow needs confirmation', 'Investigation requests a design/requirement change. Continue investigating?')))) {
          ctx.ui.notify(`WAITING_FOR_USER: ${runId}`); return;
        }
        waitingUsed = true;
        confirmationPending = false;
        const requestId = store.loadLast(runId)?.pendingDecisionRequest!;
        const gate = new InMemoryUserDecisionGate();
        gate.decide({ kind: 'user_decision', decision: 'continue_investigating', requestId } as UserDecisionArtifact);
        runtime.setDecisionGate(gate); runtime.resume();
        continue;
      }
      const stage = runtime.stage;
      const nodeId = stage === 'INVESTIGATING' || stage === 'BLOCKED' ? 'investigate' : stage === 'IMPLEMENTING' ? 'implement' : 'verify';
      let capsule: Record<string, unknown> = {};
      if (stage === 'BLOCKED') {
        if (blockedInputUsed || !ctx.hasUI) { ctx.ui.notify(`BLOCKED: ${runId}`); return; }
        blockedInputUsed = true;
        const extra = (await ctx.ui.input('补充信息（取消或留空则保持 BLOCKED）', ''))?.trim();
        if (!extra) { ctx.ui.notify(`BLOCKED: ${runId}`); return; }
        capsule = { supplementalInformation: extra };
      }
      await runtime.runNode(definitions[nodeId], problem, capsule);
    }
    ctx.ui.notify(`ACCEPTED: ${runId}`);
  };

  const resumeFromSession = async (ctx: ExtensionCommandContext) => {
    const store = new PiSessionRunStore(ctx.sessionManager, (type, data) => pi.appendEntry(type, data as any));
    const checkpoint = store.latestUncompleted();
    if (!checkpoint || !checkpoint.problem) return;
    if (!ctx.hasUI || !(await ctx.ui.confirm('恢复 bugFix 工作流', `${checkpoint.problem}\n当前阶段：${checkpoint.stage}`))) return;
    try {
      const prepared = prepareRun(ctx);
      pi.appendEntry('workflow-command', { operation: 'session-resume', runId: checkpoint.runId, time: Date.now() });
      await continueRun(ctx, store, checkpoint.runId, checkpoint.problem, prepared, checkpoint.stage === 'WAITING_FOR_USER');
    }
    catch (error) { ctx.ui.notify(`bugFix failed: ${error instanceof Error ? error.message : String(error)}`); }
  };

  if (typeof (pi as any).on === 'function') (pi as any).on('session_start', async (event: any, ctx: ExtensionCommandContext) => {
    if (event.reason === 'resume') await resumeFromSession(ctx);
  });
  pi.registerCommand('bugFix', {
    description: 'Start a bug fix workflow: /bugFix <问题描述>',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseBugFixCommand(args);
      if (!parsed.valid) { ctx.ui.notify(parsed.usage!); return; }
      const store = new PiSessionRunStore(ctx.sessionManager, (type, data) => pi.appendEntry(type, data as any));
      const runId = `bugFix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        const prepared = prepareRun(ctx);
        pi.appendEntry('workflow-command', { operation: 'start', runId, time: Date.now() });
        store.saveCheckpoint({ runId, stage: 'INVESTIGATING', at: Date.now(), id: `${runId}-initial`, problem: parsed.problem });
        await continueRun(ctx, store, runId, parsed.problem!, prepared);
      }
      catch (error) { ctx.ui.notify(`bugFix failed: ${error instanceof Error ? error.message : String(error)}`); }
    },
  });
}
export { bugFixDefinition };
