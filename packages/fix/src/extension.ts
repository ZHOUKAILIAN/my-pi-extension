import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { ArtifactContractError, WorkflowRuntime, fixDefinition, fixNodes, PiSessionRunStore, InMemoryUserDecisionGate, PiSdkWorkerExecutor, WorkerArtifactSubmissionError, type UserDecisionArtifact, type WorkerExecutor, type WorkerProgress } from '@pi/workflow-runtime';
import { loadModelPolicy, parseFixCommand, resolveModelRef } from './policy.ts';

export default function fixExtension(pi: ExtensionAPI) {
  const injected = (pi as ExtensionAPI & { fixWorker?: WorkerExecutor }).fixWorker;

  const setWorkflowStatus = (ctx: ExtensionCommandContext, text: string, working = true) => {
    const ui = (ctx as any).ui;
    ui?.setStatus?.('fix', text);
    ui?.setWorkingMessage?.(text);
    ui?.setWorkingVisible?.(working);
  };

  const clearWorkflowWorking = (ctx: ExtensionCommandContext) => {
    (ctx as any).ui?.setWorkingVisible?.(false);
  };

  // A workflow run has one stable public trace ID. It survives /resume and keys all audit entries.
  let activeTraceId: string | undefined;
  const trace = (content: string, level: 'info' | 'error' = 'info') => {
    const timestamp = Date.now();
    const traceId = activeTraceId;
    const visible = `[fix${traceId ? ` traceId=${traceId}` : ''}] ${content}`;
    if (typeof (pi as any).sendMessage === 'function') {
      pi.sendMessage({
        customType: 'fix-trace',
        content: visible,
        display: true,
        details: { traceId, level, timestamp },
      });
    }
    // sendMessage makes the trace visible; appendEntry makes it replayable after /resume.
    if (traceId) pi.appendEntry('workflow-trace', { runId: traceId, traceId, content, level, timestamp });
  };


  const prepareRun = (ctx: ExtensionCommandContext) => {
    // Older harnesses/hosts may not expose trust; retain the historical trusted default.
    const trusted = typeof (ctx as any).isProjectTrusted === 'function' ? (ctx as any).isProjectTrusted() : true;
    const policy = loadModelPolicy(trusted ? `${ctx.cwd}/.pi/workflow-models.json` : '/definitely/missing/workflow-models.json');
    const resolvedThinkingLevel = (ctx as any).thinkingLevel;
    const nodes = ['investigate', 'implement', 'verify'] as const;
    const workers: Record<string, WorkerExecutor> = {};
    const definitions: Record<string, ReturnType<typeof fixNodes>[string]> = {};
    const audits: any[] = [];
    for (const nodeId of nodes) {
      const configuredRef = policy.nodes[nodeId].configuredRef;
      const registry = (ctx as any).modelRegistry ?? {
        find: (provider: string, id: string) => injected && policy.nodes[nodeId].source === 'runtime-default' ? { provider, id } : undefined,
      };
      const resolved = resolveModelRef(configuredRef, (ctx as any).model ?? (injected ? { provider: 'injected', id: 'fixWorker' } : undefined), registry);
      const model = injected ? ((ctx as any).model ?? resolved) : resolved;
      const worker = injected ?? new PiSdkWorkerExecutor({
        model,
        thinkingLevel: resolvedThinkingLevel,
        skills: policy.nodes[nodeId].skills,
        cwd: ctx.cwd,
        onProgress: (progress: WorkerProgress) => {
          const summarize = (value: unknown) => {
            try {
              const text = JSON.stringify(value);
              return text.length > 800 ? `${text.slice(0, 800)}...` : text;
            } catch {
              return String(value);
            }
          };
          if (progress.type === 'text') {
            const text = progress.text.trim();
            if (text) trace(`${nodeId} · 模型输出: ${text.slice(-1600)}`);
            return;
          }
          if (progress.type === 'artifact_fallback') {
            trace(`${nodeId} · Artifact accepted from strict structured-text fallback: ${summarize(progress.artifact)}`);
            return;
          }
          if (progress.type === 'model_end') {
            trace(`${nodeId} · model end: stopReason=${progress.stopReason ?? 'unknown'}${progress.errorMessage ? ` · ${progress.errorMessage}` : ''}`, progress.stopReason === 'error' || progress.stopReason === 'aborted' ? 'error' : 'info');
            return;
          }
          if (progress.type === 'artifact_attempt') {
            trace(`${nodeId} · artifact attempt ${progress.attempt}/${progress.maxAttempts} · ${progress.reason}`);
            return;
          }
          if (progress.type === 'tool_start') {
            const detail = `tool start: ${progress.name} ${summarize(progress.args)}`;
            setWorkflowStatus(ctx, `fix ${nodeId} · ${model.provider}/${model.id} · ${detail}`);
            trace(`${nodeId} · ${detail}`);
          } else {
            const detail = `tool end: ${progress.name}${progress.isError ? ' ERROR' : ''} ${summarize(progress.result)}`;
            setWorkflowStatus(ctx, `fix ${nodeId} · ${model.provider}/${model.id} · ${detail}`);
            trace(`${nodeId} · ${detail}`, progress.isError ? 'error' : 'info');
          }
        },
      });
      const definition = fixNodes(worker, { [nodeId]: policy.nodes[nodeId].skills })[nodeId];
      workers[nodeId] = worker;
      definitions[nodeId] = definition;
      audits.push({ runNode: nodeId, source: policy.nodes[nodeId].source, configuredRef, resolved: { provider: model.provider, id: model.id }, thinkingLevel: resolvedThinkingLevel, skills: definition.profile?.skills, tools: definition.profile?.tools });
    }
    return { policy, workers, definitions, audits, resolvedThinkingLevel };
  };

  const continueRun = async (ctx: ExtensionCommandContext, store: PiSessionRunStore, runId: string, problem: string, prepared: ReturnType<typeof prepareRun>, confirmationAlreadyGiven = false) => {
    for (const audit of prepared.audits) {
      const { runNode, ...data } = audit;
      pi.appendEntry('workflow-model-policy', { runId, traceId: runId, nodeId: runNode, ...data });
    }
    const { workers, definitions } = prepared;
    const runtime = WorkflowRuntime.restore(fixDefinition, store, runId);
    let blockedInputUsed = false;
    let waitingUsed = false;
    let confirmationPending = confirmationAlreadyGiven;
    const artifacts: Record<string, any> = Object.fromEntries(runtime.getArtifacts().map((artifact) => [artifact.kind, artifact]));
    let previousArtifact: any = runtime.getArtifacts().at(-1);

    const appendArtifact = (nodeId: string, artifact: any) => {
      previousArtifact = artifact;
      artifacts[artifact.kind] = artifact;
      trace(`${nodeId} · Artifact accepted: ${JSON.stringify(artifact).slice(0, 1600)}`);
    };

    const pauseRecoverableNode = (nodeId: string, stage: string, error: WorkerArtifactSubmissionError | ArtifactContractError) => {
      const errorDetail = error.message.replace(/\s+/g, ' ').slice(0, 1200);
      const detail = { runId, traceId: runId, nodeId, stage, code: error.code, message: errorDetail, at: Date.now() };
      pi.appendEntry('workflow-node-failure', detail);
      trace(`${nodeId} · ${error.code}; ${stage} paused with checkpoint retained · ${errorDetail}`, 'error');
      clearWorkflowWorking(ctx);
      ctx.ui.notify(`${stage} paused: ${error.code}. TraceId: ${runId}. Use Pi /resume to retry ${nodeId}.`, 'error');
    };

    const fixReport = () => {
      const investigation = artifacts.investigation ?? {};
      const implementation = artifacts.implementation?.artifact ?? {};
      const verification = artifacts.verification ?? {};
      const revision = implementation.candidateRevision ?? verification.candidateRevision ?? 'not created';
      const pr = implementation.prUrl ?? 'not created';
      return [
        '# Fix Report',
        '',
        '## 现象',
        problem,
        '',
        '## 根因',
        investigation.rootCause ?? '未提供独立根因字段；请查看调查证据。',
        '',
        '## 证据',
        ...(investigation.evidence?.length ? investigation.evidence.map((item: string) => `- ${item}`) : ['- 未提供']),
        '',
        '## 修改',
        implementation.summary ?? '未提供修改摘要',
        ...(implementation.filesChanged?.length ? implementation.filesChanged.map((file: string) => `- ${file}`) : ['- 未提供修改文件列表']),
        '',
        '## 验证',
        ...(verification.evidence?.length ? verification.evidence.map((item: string) => `- ${item}`) : ['- 未提供验证证据']),
        '',
        `Candidate revision: ${revision}`,
        `PR: ${pr}`,
      ].join('\n');
    };
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
      const audit = prepared.audits.find((entry) => entry.runNode === nodeId);
      const skills = audit?.skills?.length ? ` · skills: ${audit.skills.join(',')}` : '';
      const stageMessage = `${stage} · ${audit?.resolved?.provider ?? 'worker'}/${audit?.resolved?.id ?? nodeId}${skills}`;
      setWorkflowStatus(ctx, `fix ${stageMessage}`);
      trace(stageMessage);
      let capsule: Record<string, unknown> = previousArtifact ? { previousArtifact } : {};
      if (stage === 'IMPLEMENTING' && previousArtifact?.kind === 'investigation') {
        trace(`implement · received investigation evidence (${previousArtifact.evidence?.length ?? 0} items)`);
      }
      if (stage === 'VERIFYING' && previousArtifact?.kind === 'implementation') {
        trace('verify · received implementation Artifact');
      }
      if (stage === 'BLOCKED') {
        if (blockedInputUsed || !ctx.hasUI) { ctx.ui.notify(`BLOCKED: ${runId}`); return; }
        blockedInputUsed = true;
        const extra = (await ctx.ui.input('补充信息（取消或留空则保持 BLOCKED）', ''))?.trim();
        if (!extra) { ctx.ui.notify(`BLOCKED: ${runId}`); return; }
        capsule = { supplementalInformation: extra };
      }
      let artifact: any;
      try {
        artifact = await runtime.runNode(definitions[nodeId], problem, capsule);
      } catch (firstError) {
        if (!(firstError instanceof WorkerArtifactSubmissionError) && !(firstError instanceof ArtifactContractError)) throw firstError;
        trace(`${nodeId} · ${firstError.code}; retrying with a new worker session`);
        setWorkflowStatus(ctx, `fix ${nodeId} · ${firstError.code} · retrying`);
        try {
          artifact = await runtime.runNode(definitions[nodeId], problem, capsule);
        } catch (secondError) {
          if (!(secondError instanceof WorkerArtifactSubmissionError) && !(secondError instanceof ArtifactContractError)) throw secondError;
          pauseRecoverableNode(nodeId, stage, secondError);
          return;
        }
      }
      appendArtifact(nodeId, artifact);
    }
    clearWorkflowWorking(ctx);
    trace(fixReport());
    ctx.ui.notify(`ACCEPTED: ${runId}`);
  };

  const resumeFromSession = async (ctx: ExtensionCommandContext) => {
    const store = new PiSessionRunStore(ctx.sessionManager, (type, data) => pi.appendEntry(type, data as any));
    const checkpoint = store.latestUncompleted();
    if (!checkpoint || !checkpoint.problem) return;
    if (!ctx.hasUI || !(await ctx.ui.confirm('恢复 fix 工作流', `${checkpoint.problem}\n当前阶段：${checkpoint.stage}`))) return;
    try {
      setWorkflowStatus(ctx, `fix ${checkpoint.stage} · resuming worker`);
      const prepared = prepareRun(ctx);
      activeTraceId = checkpoint.runId;
      trace(`trace started · resumed from ${checkpoint.stage}`);
      pi.appendEntry('workflow-command', { operation: 'session-resume', runId: checkpoint.runId, traceId: checkpoint.runId, time: Date.now() });
      await continueRun(ctx, store, checkpoint.runId, checkpoint.problem, prepared, checkpoint.stage === 'WAITING_FOR_USER');
    }
    catch (error) {
      clearWorkflowWorking(ctx);
      const message = error instanceof Error ? error.message : String(error);
      const recovery = error instanceof WorkerArtifactSubmissionError
        ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry ${error.nodeId}.`
        : error instanceof ArtifactContractError
          ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry the current stage.`
          : '';
      setWorkflowStatus(ctx, `fix failed · ${message}`, false);
      trace(`failed · ${message}${recovery}`, 'error');
      ctx.ui.notify(`fix failed: ${message}${recovery}`, 'error');
    } finally {
      activeTraceId = undefined;
    }
  };

  if (typeof (pi as any).on === 'function') (pi as any).on('session_start', async (event: any, ctx: ExtensionCommandContext) => {
    if (event.reason === 'resume') await resumeFromSession(ctx);
  });
  pi.registerCommand('fix', {
    description: 'Start a Fix workflow: /fix <问题描述>',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseFixCommand(args);
      if (!parsed.valid) { ctx.ui.notify(parsed.usage!); return; }
      const store = new PiSessionRunStore(ctx.sessionManager, (type, data) => pi.appendEntry(type, data as any));
      const runId = `fix-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        setWorkflowStatus(ctx, 'fix INVESTIGATING · preparing worker');
        const prepared = prepareRun(ctx);
        activeTraceId = runId;
        trace('trace started · new workflow');
        pi.appendEntry('workflow-command', { operation: 'start', runId, traceId: runId, time: Date.now() });
        store.saveCheckpoint({ runId, stage: 'INVESTIGATING', at: Date.now(), id: `${runId}-initial`, problem: parsed.problem });
        await continueRun(ctx, store, runId, parsed.problem!, prepared);
      }
      catch (error) {
        clearWorkflowWorking(ctx);
        const message = error instanceof Error ? error.message : String(error);
        const recovery = error instanceof WorkerArtifactSubmissionError
          ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry ${error.nodeId}.`
          : error instanceof ArtifactContractError
            ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry the current stage.`
            : '';
        setWorkflowStatus(ctx, `fix failed · ${message}`, false);
        trace(`failed · ${message}${recovery}`, 'error');
        ctx.ui.notify(`fix failed: ${message}${recovery}`, 'error');
      } finally {
        activeTraceId = undefined;
      }
    },
  });
}
export { fixDefinition };
