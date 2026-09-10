import type { ExtensionAPI, InputEvent, InputEventResult, ExtensionContext } from '@earendil-works/pi-coding-agent';
type ExtensionCommandContext = ExtensionContext;
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Artifact,
  Checkpoint,
  DispositionArtifact,
  EffectivePolicy,
  InvestigationArtifact,
  NodeDefinition,
  NodeExecutionConfig,
  PendingDecisionKind,
  Stage,
  UserDecisionArtifact,
  VerificationArtifact,
} from '@pi/workflow-contracts';
import {
  ArtifactContractError,
  WorkflowRuntimeError,
  PiSdkWorkerExecutor,
  PiSessionRunStore,
  RunControlWalStore,
  WorkerSidecar,
  WorkflowRuntime,
  WorkerArtifactSubmissionError,
  type WorkerExecutor,
  type WorkerProgress,
  ActiveWorkerRegistry,
  WorkflowInteractionPort,
  RunControlWal,
  RunControlWalError,
  type ModelCandidate,
  type RunStore,
  type WorkerModel,
} from '@pi/workflow-runtime';
import {
  FIX_NODE_IDS,
  FIX_NODE_PROFILES,
  FIX_REVIEW_POLICIES,
  FIX_VERIFICATION_REQUIREMENT,
  FIX_WORKFLOW_VERSION,
  FIX_WORKER_NODE_IDS,
  buildFixV2Nodes,
  fixDefinitionV2,
  fixReasonToStage,
  makeReviewerNode,
  type FixNodeId,
  type FixWorkerNodeId,
} from './definition.ts';
import { loadEffectivePolicy } from './effective-policy.ts';
import { parseFixCommand, resolveModelRef, type ModelRef } from './policy.ts';
import { FIX_REVIEW_ACTIONS, FIX_REVIEW_REASONS, buildReviewPayload, checkVerificationAccepted, collectDecision, guardVerification, withGuardCode } from './v2-helpers.ts';

// ============================================================
// fix v2 Extension 适配层（骨架 + prepareRun）
//
// 本文件承载 fix v2 运行时与 Pi Extension 宿主之间的准备逻辑：
// 合并有效策略（loadEffectivePolicy）、按节点/评审参与者解析模型引用、
// 构造 5 个纯 worker 节点与 3 个评审节点的 executor 与 NodeDefinition，
// 并产出每次 Run 的审计载荷（audits）。
//
// 已实现 prepareRun / continueRun（fix v2 主循环）、handleFixCommand（/fix command 层）、
// runReviewCommand（/fix review 评审命令）、resumeFromSession（session_start resume 钩子）。
// ============================================================

// 宿主抽象：v2 运行时不直接依赖 ExtensionAPI，流程逻辑通过 host 网关访问
// trace / UI 状态 / 审计条目 / 消息推送，便于独立测试。
export interface FixHost {
  trace(content: string, level?: 'info' | 'error'): void;
  setWorkflowStatus(ctx: ExtensionCommandContext, text: string, working?: boolean): void;
  clearWorkflowWorking(ctx: ExtensionCommandContext): void;
  appendEntry(type: string, data: unknown): void;
  sendMessage?(options: { customType: string; content: string; display?: boolean; details?: Record<string, unknown> }): void;
}

// 3 个独立评审节点 id；评审 executor 由 prepareRun 按每个参与者独立 Worker 身份构造。
export const REVIEWABLE_REVIEW_NODE_IDS: Array<FixNodeId> = ['investigation_review', 'change_plan_review', 'change_review'];

export interface LiveRunBinding {
  runId: string;
  wal: RunControlWal;
  registry: ActiveWorkerRegistry;
  interaction: WorkflowInteractionPort;
  parentSessionId: string;
  parentLeafId: string;
  sidecarDir?: string;
  sidecar: WorkerSidecar;
  store: RunControlWalStore;
  previousEditor: ReturnType<ExtensionContext['ui']['getEditorComponent']>;
}

export interface LiveRunContext {
  binding: LiveRunBinding;
  promise: Promise<RunResult>;
  parentContext?: ExtensionContext;
}

/** Process-local owner for background Fix runs. It is intentionally not a second
 * Workflow state store: the WAL/Runtime remain authoritative. */
export class LiveFixRunManager {
  readonly registry = new ActiveWorkerRegistry();
  constructor() {}
  private readonly runs = new Map<string, LiveRunContext>();
  private readonly sidecars = new Map<string, WorkerSidecar>();
  private readonly interactions = new Map<string, WorkflowInteractionPort>();

  createBinding(ctx: ExtensionCommandContext, runId: string): LiveRunBinding {
    const parentSessionId = ctx.sessionManager.getSessionId?.() ?? process.env.PI_SESSION_ID ?? 'unknown-parent';
    const parentLeafId = ctx.sessionManager.getLeafId?.() ?? 'root';
    const rootDir = process.env.PI_CODING_AGENT_DIR;
    const wal = RunControlWal.open(runId, { rootDir, parentSessionId, parentLeafId, cwd: ctx.cwd });
    const sidecar = new WorkerSidecar(wal.runDir);
    this.sidecars.set(runId, sidecar);
    const modelCandidates = (): readonly ModelCandidate[] => {
      const scoped = ctx.scopedModels.map((item) => item.model);
      const available = (scoped.length ? scoped : ctx.modelRegistry.getAvailable()).filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
      // Pi 0.84.2 exposes input/api on Model, not a guessed supportsTools
      // flag. Unknown provider APIs are rejected rather than treated as capable.
      const toolApis = new Set(['anthropic-messages', 'openai-completions', 'openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'google-generative-ai', 'bedrock-converse-stream', 'vertex-ai']);
      return available.map((model) => ({
        ref: `${model.provider}/${model.id}`,
        model: model as WorkerModel,
        compatible: () => Array.isArray((model as { input?: readonly string[] }).input)
          && (model as { input: readonly string[] }).input.includes('text')
          && toolApis.has(String((model as { api?: unknown }).api)),
      }));
    };
    const interaction = new WorkflowInteractionPort(this.registry, modelCandidates);
    this.interactions.set(runId, interaction);
    const binding: LiveRunBinding = {
      runId,
      wal,
      registry: this.registry,
      interaction,
      parentSessionId,
      parentLeafId,
      sidecarDir: `${wal.runDir}/workers`,
      sidecar,
      store: new RunControlWalStore(wal),
      previousEditor: ctx.ui.getEditorComponent(),
    };
    this.registry.reserve({ runId, parentSessionId, parentLeafId, nodeExecutionId: `${runId}.starting.0`, status: 'starting', wal });
    return binding;
  }

  attach(run: LiveRunContext) {
    this.runs.set(run.binding.runId, run);
    void run.promise.then(() => undefined, () => undefined).finally(() => {
      this.runs.delete(run.binding.runId);
      this.registry.release(run.binding.runId);
      if (run.parentContext?.mode === 'tui') run.parentContext.ui.setEditorComponent(run.binding.previousEditor);
      this.interactions.delete(run.binding.runId);
      if (activeTraceId === run.binding.runId) activeTraceId = undefined;
      try { run.binding.wal.releaseLease(); } catch { /* durable WAL remains recoverable */ }
    });
  }
  activeFor(ctx: ExtensionCommandContext) { return this.registry.getForParent(ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId() ?? 'root'); }
  ownerFor(ctx: ExtensionContext) { return this.registry.ownerForParent(ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId() ?? 'root'); }
  hasOwner(ctx: ExtensionContext) { return this.ownerFor(ctx) !== undefined; }
  sidecar(runId: string) { return this.sidecars.get(runId); }
  gc(now = Date.now()) { return WorkerSidecar.gc(process.env.PI_CODING_AGENT_DIR, now); }
  async rebindParent(ctx: ExtensionCommandContext, runId: string): Promise<boolean> {
    if (this.registry.owner(runId)) throw new RunControlWalError('PARENT_REBIND_RUN_ACTIVE', 'stop the current Run before rebinding its parent');
    const confirmed = !ctx.hasUI || await ctx.ui.confirm('重新绑定 Fix 运行', `在当前工作目录重新绑定运行 ${runId}？原 runId 和历史父引用会保留。`);
    if (!confirmed) return false;
    RunControlWal.rebindParent(runId, {
      rootDir: process.env.PI_CODING_AGENT_DIR,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentLeafId: ctx.sessionManager.getLeafId?.() ?? 'root',
      cwd: ctx.cwd,
      confirmed: true,
    });
    return true;
  }
  submitSupplement(input: Parameters<WorkflowInteractionPort['submitSupplement']>[0]) {
    return this.interactions.get(input.runId)?.submitSupplement(input);
  }
  requestModelChange(input: Parameters<WorkflowInteractionPort['requestModelChange']>[0]) {
    return this.interactions.get(input.runId)?.requestModelChange(input);
  }
  openStore(ctx: ExtensionContext, runId: string): RunControlWalStore {
    const wal = RunControlWal.open(runId, { rootDir: process.env.PI_CODING_AGENT_DIR, parentSessionId: ctx.sessionManager.getSessionId(), parentLeafId: ctx.sessionManager.getLeafId() ?? 'root', cwd: ctx.cwd });
    return new RunControlWalStore(wal);
  }
  latestStore(ctx: ExtensionContext): { store: RunControlWalStore; checkpoint: Checkpoint } | undefined {
    const candidates: Array<{ store: RunControlWalStore; checkpoint: Checkpoint }> = [];
    for (const runId of RunControlWal.list().filter((id) => id.startsWith('fix-'))) {
      try {
        const store = this.openStore(ctx, runId);
        const checkpoint = store.loadLast(runId);
        if (checkpoint && checkpoint.stage !== 'ACCEPTED') candidates.push({ store, checkpoint });
        else store.wal.releaseLease();
      } catch { /* active or corrupt runs are not silently selected */ }
    }
    candidates.sort((a, b) => a.checkpoint.at - b.checkpoint.at);
    const selected = candidates.at(-1);
    for (const candidate of candidates.slice(0, -1)) { try { candidate.store.wal.releaseLease(); } catch { /* preserve selected recovery */ } }
    return selected;
  }
  async shutdown() {
    await Promise.all([...this.runs.values()].map((run) => run.binding.interaction.shutdown()));
    for (const owner of this.registry.allOwners()) owner.wal.markShutdown();
  }

  migrateLegacyCheckpoint(ctx: ExtensionCommandContext, checkpoint: Checkpoint) {
    const wal = RunControlWal.open(checkpoint.runId, {
      rootDir: process.env.PI_CODING_AGENT_DIR,
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentLeafId: ctx.sessionManager.getLeafId() ?? 'root',
      cwd: ctx.cwd,
    });
    try {
      const branch = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined);
      const source = [...branch].reverse().find((entry) => entry.type === 'custom' && entry.customType === 'workflow-run' && (entry.data as Checkpoint | undefined)?.id === checkpoint.id);
      if (!source || source.type !== 'custom' || !source.data) throw new Error('legacy checkpoint is not on the active parent branch');
      const sourceChecksum = createHash('sha256').update(JSON.stringify(source.data)).digest('hex');
      wal.migrateLegacyCheckpoint({ parentSessionId: ctx.sessionManager.getSessionId(), sourceEntryId: checkpoint.id, sourceChecksum, checkpoint });
    } finally {
      try { wal.releaseLease(); } catch { /* keep the WAL for explicit recovery */ }
    }
  }
}


type ReviewNodeId = 'investigation_review' | 'change_plan_review' | 'change_review';
type ModelPolicyAudit = { runNode: string; source: 'project-file' | 'runtime-default'; configuredRef: string; resolved?: { provider: string; id: string }; thinkingLevel: unknown; skills?: string[]; tools: string[] };
type ResultProjection = {
  kind?: string;
  conclusion?: { status?: string; summary?: string };
  summary?: string;
  overview?: string;
  rootCause?: string;
  evidence?: unknown[];
  risks?: string[];
  unverified?: string[];
  remainingRisk?: string[];
  dispositionType?: string;
  requiresRepositoryChange?: boolean;
  minimalScope?: string;
  verificationTarget?: string;
  filesChanged?: string[];
  candidateRevision?: string;
  prUrl?: string;
  artifact?: ResultProjection;
  failure?: { kind: string; reason: string; responsibility?: string; resolution?: string };
};

// 模块级当前 Run 的 traceId（迁移 legacy activeTraceId 语义）：
// host.trace 的 sendMessage 始终推送；appendEntry 仅在 activeTraceId 存在时写，
// 保证 /resume 后 audit 条目可回放。handleFixCommand / resumeFromSession 负责设置与复位。
let activeTraceId: string | undefined;

// 从 ExtensionAPI 构建 FixHost 网关：default export 闭包与 resumeFromSession 共用。
// sendMessage 存在性守卫兼容不暴露 sendMessage 的老宿主。
const makeFixHost = (pi: ExtensionAPI): FixHost => {
  const setWorkflowStatus = (ctx: ExtensionCommandContext, text: string, working = true) => {
      ctx.ui.setStatus?.('fix', text);
    ctx.ui.setWorkingMessage?.(text);
    ctx.ui.setWorkingVisible?.(working);
  };
  const clearWorkflowWorking = (ctx: ExtensionCommandContext) => {
    ctx.ui.setWorkingVisible?.(false);
  };
  const appendEntry = (type: string, data: unknown) => {
    pi.appendEntry(type, data);
  };
  const trace = (content: string, level: 'info' | 'error' = 'info') => {
    const timestamp = Date.now();
    const traceId = activeTraceId;
    const visible = `[fix${traceId ? ` traceId=${traceId}` : ''}] ${content}`;
    if (typeof pi.sendMessage === 'function') {
      pi.sendMessage({ customType: 'fix-trace', content: visible, display: true, details: { traceId, level, timestamp } });
    }
    // sendMessage 使 trace 可见；appendEntry 使 /resume 后可回放。
    if (traceId) appendEntry('workflow-trace', { runId: traceId, traceId, content, level, timestamp });
  };
  const sendMessage = (options: { customType: string; content: string; display?: boolean; details?: Record<string, unknown> }) => {
    if (typeof pi.sendMessage === 'function') pi.sendMessage({ ...options, display: options.display ?? true });
  };
  return { trace, setWorkflowStatus, clearWorkflowWorking, appendEntry, sendMessage };
};

// 判定单个节点的有效配置是否来自项目文件覆盖：与 FIX_NODE_PROFILES 默认值不一致即视为
// project-file（与 legacy policy.ts 的 source 语义对齐；项目文件显式写成默认值时
// 视为 runtime-default，属于可接受的边界差异）。
const nodeSource = (nodeId: FixNodeId, cfg: NodeExecutionConfig): 'project-file' | 'runtime-default' => {
  const profile = FIX_NODE_PROFILES[nodeId];
  const overridden = cfg.model !== profile.defaultModelRef
    || JSON.stringify(cfg.skills ?? []) !== JSON.stringify(profile.defaultSkills);
  return overridden ? 'project-file' : 'runtime-default';
};

// onProgress 照抄 legacy（extension.ts prepareRun）：文本/回退/结束/尝试/工具事件
// 分别走 host.trace 与 host.setWorkflowStatus，前缀携带 nodeId，状态文案附带模型引用。
const makeProgressHandler = (host: FixHost, ctx: ExtensionCommandContext, nodeId: string, model: { provider: string; id: string }) =>
  (progress: WorkerProgress) => {
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
      if (text) host.trace(`${nodeId} · 模型输出: ${text.slice(-1600)}`);
      return;
    }
    if (progress.type === 'artifact_fallback') {
      host.trace(`${nodeId} · Artifact accepted from strict structured-text fallback: ${summarize(progress.artifact)}`);
      return;
    }
    if (progress.type === 'model_applied') {
      host.setWorkflowStatus(ctx, `fix ${nodeId} · ${progress.model.provider}/${progress.model.id} · 模型已生效`, true);
      host.trace(`${nodeId} · model applied at ${progress.modelCallRef}: ${progress.model.provider}/${progress.model.id}`);
      return;
    }
    if (progress.type === 'model_end') {
      host.trace(`${nodeId} · model end: stopReason=${progress.stopReason ?? 'unknown'}${progress.errorMessage ? ` · ${progress.errorMessage}` : ''}`, progress.stopReason === 'error' || progress.stopReason === 'aborted' ? 'error' : 'info');
      return;
    }
    if (progress.type === 'artifact_attempt') {
      host.trace(`${nodeId} · artifact attempt ${progress.attempt}/${progress.maxAttempts} · ${progress.reason}`);
      return;
    }
    if (progress.type === 'schema_fallback') {
      // 未知 node.id 退宽松 schema 的降级可见事件（结构与语义校验仍由权威层兜底）。
      host.trace(`${nodeId} · schema fallback: no per-kind schema bound for node "${progress.nodeId}"; falling back to loose schema`, 'error');
      return;
    }
    if (progress.type === 'tool_start') {
      const detail = `tool start: ${progress.name} ${summarize(progress.args)}`;
      host.setWorkflowStatus(ctx, `fix ${nodeId} · ${model.provider}/${model.id} · ${detail}`);
      host.trace(`${nodeId} · ${detail}`);
    } else {
      const detail = `tool end: ${progress.name}${progress.isError ? ' ERROR' : ''} ${summarize(progress.result)}`;
      host.setWorkflowStatus(ctx, `fix ${nodeId} · ${model.provider}/${model.id} · ${detail}`);
      host.trace(`${nodeId} · ${detail}`, progress.isError ? 'error' : 'info');
    }
  };

const makeLiveProgressHandler = (host: FixHost, ctx: ExtensionCommandContext, nodeId: string, model: { provider: string; id: string }, live: LiveRunBinding) =>
  (progress: WorkerProgress) => {
    // Only public assistant text and tool invocation summaries enter the protected
    // display sidecar. Thinking deltas and tool results are deliberately dropped.
    if (progress.type === 'text' || progress.type === 'tool_start') {
      const ref = randomUUID();
      live.sidecar.append(progress.type === 'text'
        ? { ref, runId: live.runId, nodeId, eventKind: 'visible_text', text: progress.text.slice(-4000), occurredAt: new Date().toISOString() }
        : { ref, runId: live.runId, nodeId, eventKind: 'tool_start', toolName: progress.name, args: progress.args, occurredAt: new Date().toISOString() });
      host.sendMessage?.({ customType: 'fix-worker-event', content: `当前 Worker 有新的可见活动（${nodeId}，opaque ref ${ref}）`, display: true, details: { runId: live.runId, ref, nodeId, eventKind: progress.type === 'text' ? 'visible_text' : 'tool_start' } });
    }
    if (progress.type === 'model_applied') {
      host.setWorkflowStatus(ctx, `fix ${nodeId} · ${progress.model.provider}/${progress.model.id} · 模型已生效`, true);
      host.trace(`${nodeId} · model applied at ${progress.modelCallRef}: ${progress.model.provider}/${progress.model.id}`);
    } else if (progress.type === 'tool_start' || progress.type === 'tool_end') host.setWorkflowStatus(ctx, `fix ${nodeId} · ${model.provider}/${model.id} · 工具活动`, true);
  };

// 解析模型引用并计算本次使用的 model：
// - inherit：用 ctx.model（无 ctx.model 且无注入时抛错，语义沿用 resolveModelRef）；
// - 非 inherit：用 registry.find 解析，找不到回退（仅注入外壳存在时回退占位模型）；
// - registry 缺省回退与 model 最终取值照抄 legacy（extension.ts prepareRun）。
const resolveRunModel = (ctx: ExtensionCommandContext, configuredRef: string, injected: WorkerExecutor | undefined) => {
  const inherited = ctx.model ?? (injected ? { provider: 'injected', id: 'fixWorker' } : undefined);
  const registry = injected && !ctx.modelRegistry
    ? { find: (provider: string, id: string) => ({ provider, id }) }
    : ctx.modelRegistry;
  const resolved = resolveModelRef(configuredRef as ModelRef, inherited, registry);
  if (!injected && ctx.modelRegistry.hasConfiguredAuth?.(resolved) === false) throw Error(`model is not authenticated: ${configuredRef}`);
  return injected ? (ctx.model ?? resolved) : resolved;
};

// 构造一次 Run 的全部节点执行与评审准备信息。
// injected 为宿主注入的 WorkerExecutor（测试外壳或远程执行器）；存在时所有节点复用同一 executor。
export function prepareRun(
  ctx: ExtensionCommandContext,
  host: FixHost,
  injected?: WorkerExecutor,
  live?: LiveRunBinding,
): {
  policyDigest: string;
  effective: EffectivePolicy;
  definitions: Record<FixWorkerNodeId, NodeDefinition>;
  reviewers: Record<ReviewNodeId, NodeDefinition[]>;
  audits: ModelPolicyAudit[];
  resolvedThinkingLevel: unknown;
  live?: LiveRunBinding;
} {
  // 老版本宿主可能不暴露信任判定；沿用历史默认值（trusted）。
  const trusted = ctx.isProjectTrusted();
  const effective = loadEffectivePolicy(ctx.cwd, { trusted });
  const policyDigest = effective.digest;
  const resolvedThinkingLevel = ctx.thinkingLevel;

  const workers = {} as Record<FixWorkerNodeId, WorkerExecutor>;
  const reviewers = {
    investigation_review: [],
    change_plan_review: [],
    change_review: [],
  } as Record<ReviewNodeId, NodeDefinition[]>;
  const audits: ModelPolicyAudit[] = [];

  // 按 FIX_NODE_IDS 顺序逐节点准备：5 个纯 worker 节点构造 executor 并收集，
  // 3 个评审节点按 FIX_REVIEW_POLICIES 的参与者逐个构造独立评审者。
  for (const nodeId of FIX_NODE_IDS) {
    const cfg = effective.nodes[nodeId];
    if ((REVIEWABLE_REVIEW_NODE_IDS as readonly FixNodeId[]).includes(nodeId)) {
      const id = nodeId as ReviewNodeId;
      const policy = FIX_REVIEW_POLICIES[id];
      const built: NodeDefinition[] = [];
      let firstConfiguredRef: string = 'inherit';
      let firstModel: { provider: string; id: string } | undefined;
      let firstSkills: string[] | undefined;
      // 评审者按参与者顺序从 1 起编号（workerId: reviewer:<id>:<n>）。
      policy.reviewers.forEach((participant, i) => {
        const configuredRef = participant.model ?? cfg.model ?? 'inherit';
        const model = resolveRunModel(ctx, configuredRef, injected);
        const skills = participant.skills ?? cfg.skills;
        // injected 评审复用宿主注入的 execute，但必须声明独立 workerId：
        // requireIndependentWorker=true 下 reviewer 若无 workerId 或与被评审节点同 worker 会被运行时拒绝。
        const executor = injected
          ? { workerId: `injected:reviewer:${id}:${i + 1}`, execute: (node: NodeDefinition, task: unknown, capsule: Record<string, unknown>) => injected.execute(node, task, capsule) }
          : new PiSdkWorkerExecutor({
              model,
              thinkingLevel: resolvedThinkingLevel,
              skills,
              cwd: ctx.cwd,
              workerId: `reviewer:${id}:${i + 1}`,
              onProgress: live ? makeLiveProgressHandler(host, ctx, id, model, live) : makeProgressHandler(host, ctx, id, model),
              ...(live ? { live: { ...live } } : {}),
            });
        built.push(makeReviewerNode(id, executor));
        if (i === 0) {
          firstConfiguredRef = configuredRef;
          firstModel = { provider: model.provider, id: model.id };
          firstSkills = skills;
        }
      });
      reviewers[id] = built;
      // 评审节点审计取 reviewers[0]（首个评审者）的模型引用。
      audits.push({
        runNode: id,
        source: nodeSource(id, cfg),
        configuredRef: firstConfiguredRef,
        resolved: firstModel,
        thinkingLevel: resolvedThinkingLevel,
        skills: firstSkills,
        tools: cfg.tools ?? FIX_NODE_PROFILES[id].tools,
      });
      continue;
    }
    const workerNodeId = nodeId as FixWorkerNodeId;
    const configuredRef = cfg.model ?? 'inherit';
    const model = resolveRunModel(ctx, configuredRef, injected);
    const worker = injected ?? new PiSdkWorkerExecutor({
      model,
      thinkingLevel: resolvedThinkingLevel,
      skills: cfg.skills,
      cwd: ctx.cwd,
      workerId: `worker:${nodeId}`,
      onProgress: live ? makeLiveProgressHandler(host, ctx, nodeId, model, live) : makeProgressHandler(host, ctx, nodeId, model),
      ...(live ? { live: { ...live } } : {}),
    });
    workers[workerNodeId] = worker;
    audits.push({
      runNode: nodeId,
      source: nodeSource(nodeId, cfg),
      configuredRef,
      resolved: { provider: model.provider, id: model.id },
      thinkingLevel: resolvedThinkingLevel,
      skills: cfg.skills,
      tools: cfg.tools ?? FIX_NODE_PROFILES[nodeId].tools,
    });
  }

  const definitions = buildFixV2Nodes({
    intake: workers.intake,
    investigate: workers.investigate,
    disposition: workers.disposition,
    implement: workers.implement,
    verify: workers.verify,
  });

  return { policyDigest, effective, definitions, reviewers, audits, resolvedThinkingLevel, live };
}

// ============================================================
// continueRun：fix v2 主循环（Controller 语义）
//
// 负责一次 Run 的完整推进：按 runtime.stage 分派 7 个阶段分支，
// 执行 worker / 评审节点、写入审计条目、处理 BLOCKED 解锁与人工验收，
// 直到 ACCEPTED 后产出最终处置报告。所有宿主副作用经 host 网关，
// checkpoint 由 runtime.transition 自动写入，失败保留 checkpoint 供 /resume 恢复。
// ============================================================

export type PreparedRun = ReturnType<typeof prepareRun>;

type RunResult = 'accepted' | 'paused' | 'waiting' | 'blocked';
type RunReviewOptions = Parameters<WorkflowRuntime['runReview']>[3];

// 最终处置报告：由已校验 Artifact 投影，固定结构（L1 最终处置报告）。
// 现象字段投影自 Intake 的 summary/overview（用户可读字段），原始 problem（Run 级追溯事实）
// 不直接进入报告；缺少新字段的旧 checkpoint 按“尚未确认”处理，不做 phenomenon 降级。
// 模块级复用：continueRun 的 ACCEPTED 收尾与 /fix review approve（或 UI 验收）决策后均产出。
const buildFixReport = (results: Record<string, ResultProjection>): string => {
  const intake = results.intake ?? {};
  const investigation = results.investigation ?? {};
  const disposition = results.disposition ?? {};
  const implementation = results.implementation?.artifact ?? {};
  const verification = results.verification ?? {};
  const revision = implementation.candidateRevision ?? verification.candidateRevision ?? '未产生候选版本';
  const dispositionType = disposition.dispositionType ?? '未确认';
  // 「状态」按处置类型映射 L1 最终处置报告状态枚举（已解决/已缓解/未解决/无需修改/等待确认/已阻塞）。
  // 报告仅在 ACCEPTED（人工验收通过）后产出，故统一带（验收通过）后缀：
  // - remediation：修复切断根因因果链 → 已解决（L1「已解决」成立条件）；
  // - external_action：外部动作完成且验证证明处置后实际状态（原始现象已验证消失）→ 已解决；
  // - mitigation：只修补表面故障点，不得声称完整解决 → 已缓解；
  // - explanation：当前行为符合预期、不修改 → 无需修改；
  // - 其余（wait_decision / change_request / insufficient_evidence / 未确认）：L1 无对应的
  //   解决/缓解/无需修改语义，保守映射为「未解决」（L1 ACCEPTED 行允许“经明确接受决定的有限未解决结果”）。
  const dispositionReportStatus: Partial<Record<DispositionArtifact['dispositionType'], string>> = {
    remediation: '已解决',
    external_action: '已解决',
    mitigation: '已缓解',
    explanation: '无需修改',
  };
  // disposition 来自未类型化的 results 投影：索引前收窄到合同枚举，非法值走 fallback「未解决」。
  const reportStatus = `${dispositionReportStatus[dispositionType as DispositionArtifact['dispositionType']] ?? '未解决'}（验收通过）`;
  const evidenceLines = (items: unknown[]) =>
    items.length ? items.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`) : ['- 未提供'];
  const reviewConclusions = [results.investigation_review, results.change_plan_review, results.change_review]
    .filter(Boolean)
    .map((review: ResultProjection) => ({
      nodeId: review.kind,
      status: review.conclusion?.status,
      summary: review.conclusion?.summary,
    }));
  return [
    '# Fix 处置结果',
    '',
    '## 结论',
    `- 状态：${reportStatus}`,
    `- 处置类型：${dispositionType}`,
    `- 风险：${disposition.risks?.length ? disposition.risks.join('、') : '无'}`,
    `- 未验证：${verification.unverified?.length ? verification.unverified.join('、') : '无'}`,
    `- 剩余风险：${verification.remainingRisk?.length ? verification.remainingRisk.join('、') : '无'}`,
    '',
    '## 现象',
    typeof intake.summary === 'string' && intake.summary ? intake.summary : '尚未确认',
    ...(typeof intake.overview === 'string' && intake.overview ? [`> ${intake.overview}`] : []),
    '',
    '## 根因',
    investigation.rootCause ?? '未确认',
    '',
    '## 影响面',
    ...(investigation.evidence?.length
      ? investigation.evidence.map((item: unknown) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`)
      : ['- 未提供']),
    ...(verification.unverified?.length ? [`- 未覆盖影响面：${verification.unverified.join('、')}`] : []),
    '',
    '## 处置',
    `- 处置类型：${dispositionType}`,
    `- 是否需要仓库变更：${disposition.requiresRepositoryChange === true ? '是' : '否'}`,
    `- 最小修改范围：${disposition.minimalScope ?? '无'}`,
    `- 处置风险：${disposition.risks?.length ? disposition.risks.join('、') : '无'}`,
    `- 验证目标：${disposition.verificationTarget ?? '无'}`,
    '',
    '## 修改',
    implementation.summary ?? '未修改',
    ...(implementation.filesChanged?.length ? implementation.filesChanged.map((file: string) => `- ${file}`) : ['- 未修改文件']),
    `- 候选版本：${revision}`,
    ...(implementation.prUrl ? [`- PR: ${implementation.prUrl}`] : []),
    '',
    '## 验证',
    ...(verification.evidence?.length ? evidenceLines(verification.evidence) : ['- 未提供验证证据']),
    ...(verification.unverified?.length ? [`- 未验证：${verification.unverified.join('、')}`] : []),
    ...(verification.remainingRisk?.length ? [`- 剩余风险：${verification.remainingRisk.join('、')}`] : []),
    '',
    '## 引用',
    `- 候选版本：${revision}`,
    `- 处置结论：${disposition.conclusion?.summary ?? '未确认'}`,
    ...reviewConclusions.map((c) => `- ${c.nodeId}: ${c.status ?? 'unknown'}${c.summary ? ` · ${c.summary}` : ''}`),
  ].join('\n');
};

/**
 * 推进一次 fix v2 Run 直到 ACCEPTED，或返回等待态。
 * - 'accepted': 验收通过，已产出最终处置报告
 * - 'paused': 节点失败（重试后仍失败），checkpoint 保留，等待 /resume
 * - 'waiting': WAITING_FOR_USER 人工验收未完成（取消或无 UI）
 * - 'blocked': BLOCKED 无 UI 或用户未提供补充信息
 */
export async function continueRun(
  ctx: ExtensionCommandContext,
  store: RunStore,
  runId: string,
  problem: string,
  prepared: PreparedRun,
  host: FixHost,
  opts: { injected?: WorkerExecutor; confirmationAlreadyGiven?: boolean } = {},
): Promise<RunResult> {
  try {
    // 1. 审计：本次 Run 的模型策略逐节点落盘（runNode 字段映射为 nodeId）。
    for (const audit of prepared.audits) {
      const { runNode: nodeId, ...data } = audit;
      host.appendEntry('workflow-model-policy', { runId, traceId: runId, nodeId, ...data });
    }

    // 2. 恢复：校验 workflow 版本与策略摘要一致；checkpoint 缺失时从 INTAKE 起跑。
    // reviewPolicyFor 把当前有效评审策略绑定进 Runtime：runReview 只能用与之一致的策略（降级策略即拒），
    // change_plan_review 门禁按当前策略重算 quorum/摘要（配合账本周期防篡改）。
    const runtime = WorkflowRuntime.restore(fixDefinitionV2, store, runId, {
      expectedWorkflowVersion: FIX_WORKFLOW_VERSION,
      expectedPolicyDigest: prepared.policyDigest,
      reviewPolicyFor: (reviewArtifactKind) => FIX_REVIEW_POLICIES[reviewArtifactKind],
      // Runtime 审计事件接入 Fix 生产路径：restore 恢复的 run 同样落盘（FixAuditEvent 逐条写入
      // session entry，/resume 后可回放，与 workflow-trace 同一持久化通道）。
      auditSink: { append: (event) => host.appendEntry('workflow-audit', event) },
    });

    // 3. 局部结果集：按 kind 投影 runtime 已接受 Artifact；后续 appendArtifact 同步更新。
    const results: Record<string, ResultProjection> = Object.fromEntries(
      runtime.getArtifacts().map((artifact) => [artifact.kind, artifact as unknown as ResultProjection]),
    );

    const appendArtifact = (nodeId: string, artifact: Artifact) => {
      results[artifact.kind] = artifact as unknown as ResultProjection;
      host.trace(`${nodeId} · Artifact accepted: ${JSON.stringify(artifact).slice(0, 1600)}`);
    };

    // 4. 节点失败：写入 workflow-node-failure 审计，保留 checkpoint，通知用户。
    const pauseRecoverableNode = (nodeId: string, stage: string, error: { code?: string; message: string }) => {
      const errorDetail = error.message.replace(/\s+/g, ' ').slice(0, 1200);
      const detail = { runId, traceId: runId, nodeId, stage, code: error.code, message: errorDetail, at: Date.now() };
      host.appendEntry('workflow-node-failure', detail);
      host.trace(`${nodeId} · ${error.code ?? 'WORKFLOW_ERROR'}; ${stage} paused with checkpoint retained · ${errorDetail}`, 'error');
      host.clearWorkflowWorking(ctx);
      ctx.ui.notify(`${stage} paused: ${error.code ?? 'WORKFLOW_ERROR'}. TraceId: ${runId}. Use Pi /resume to retry ${nodeId}.`, 'error');
    };

    // 5. BLOCKED 解锁目标阶段：从恢复出的 checkpoint（blockedReturnStage）继承现场，
    // 否则默认 INVESTIGATING；写 blocker entry 时同步记录到 runtime 与 checkpoint，
    // 供跨 session 恢复不要在后续默认回滚到 INVESTIGATING。
    // 用对象包装持有 Stage，避免字面量初始化被类型窄化后影响后续比较。
    const blockedReturn: { stage: Stage } = { stage: runtime.getBlockedReturnStage() ?? 'INVESTIGATING' };
    const recordBlocker = (stage: Stage, returnStage: Stage, reason: string) => {
      blockedReturn.stage = returnStage;
      runtime.setBlockedReturnStage(returnStage);
      host.appendEntry('workflow-blocker', { runId, traceId: runId, stage, returnStage, reason, at: Date.now() });
    };

    // 6. 节点执行：executeNode 产出经运行时校验归档；提交类错误重试一次，再失败暂停。
    const exec = async (
      nodeId: FixWorkerNodeId,
      task: unknown,
      capsule?: Record<string, unknown>,
    ): Promise<{ artifact: Artifact; nodeId: FixWorkerNodeId } | 'paused'> => {
      let artifact: Artifact;
      const restoredNodeExecutionId = runtime.getNodeExecutionId(nodeId);
      const logicalNodeExecutionId = restoredNodeExecutionId ?? runtime.createNodeExecutionId(nodeId);
      let recoveryAttempt = restoredNodeExecutionId ? (runtime.getRecoveryAttempt(nodeId) ?? 0) + 1 : 1;
      const supplementRecords = prepared.live?.wal.records().filter((record) => record.type === 'supplement').map((record) => ({ supplementId: record.payload.supplementId, sequence: record.payload.sequence, text: record.payload.text })) ?? [];
      const liveCapsule = prepared.live && supplementRecords.length ? { supplementVersion: prepared.live.wal.getSupplementVersion(), supplements: supplementRecords } : {};
      try {
        const result = await runtime.executeNode(prepared.definitions[nodeId], task, { nodeExecutionId: logicalNodeExecutionId, recoveryAttempt, context: { ...liveCapsule, ...capsule } });
        artifact = result.artifact;
      } catch (firstError) {
        if (!(firstError instanceof WorkerArtifactSubmissionError) && !(firstError instanceof ArtifactContractError)) throw firstError;
        host.trace(`${nodeId} · ${firstError.code}; retrying with recovery attempt 2 · ${firstError.message}`);
        try {
          recoveryAttempt += 1;
          const result = await runtime.executeNode(prepared.definitions[nodeId], task, { nodeExecutionId: logicalNodeExecutionId, recoveryAttempt, context: { ...liveCapsule, ...capsule } });
          artifact = result.artifact;
        } catch (secondError) {
          if (!(secondError instanceof WorkerArtifactSubmissionError) && !(secondError instanceof ArtifactContractError)) throw secondError;
          pauseRecoverableNode(nodeId, runtime.stage, secondError);
          return 'paused';
        }
      }
      appendArtifact(nodeId, artifact);
      return { artifact, nodeId };
    };

    // 7. 评审节点：所有 reviewer 使用同一份 Run supplement 快照；不因
    // reviewer 顺序或当前 Child publication 改变上下文，且 Runtime 仍会为
    // 每个 reviewer 盖章独立的 nodeExecutionId/workerId。
    const liveRunCapsule = () => {
      const records = prepared.live?.wal.records().filter((record) => record.type === 'supplement') ?? [];
      return prepared.live && records.length
        ? { supplementVersion: prepared.live.wal.getSupplementVersion(), supplements: records.map((record) => ({ supplementId: record.payload.supplementId, sequence: record.payload.sequence, text: record.payload.text })) }
        : {};
    };
    const runReviewChecked = async (
      reviewNodeId: string,
      reviewers: NodeDefinition[],
      policy: Parameters<WorkflowRuntime['runReview']>[2],
      reviewOpts: RunReviewOptions,
    ) => {
      const review = await runtime.runReview(reviewNodeId, reviewers, policy, { ...reviewOpts, context: { ...liveRunCapsule(), ...(reviewOpts.context ?? {}) } });
      review.reviewArtifacts.forEach((artifact) => appendArtifact(reviewNodeId, artifact));
      return review;
    };

    // 8. 提炼三类评审结论（kind + conclusion status/summary），供决策载荷与报告引用。
    const extractReviewConclusions = () =>
      [results.investigation_review, results.change_plan_review, results.change_review]
        .filter(Boolean)
        .map((review: ResultProjection) => ({
          nodeId: review.kind,
          status: review.conclusion?.status,
          summary: review.conclusion?.summary,
        }));

    // 9. 最终处置报告见模块级 buildFixReport（continueRun 与 /fix review 复用，见 step 11）。

    // 10. 主循环：按阶段分派直至 ACCEPTED。恢复时仅首轮消费 WAL 投影出的评审节点；
    // 同一调用内评审拒绝回流后，必须重新执行业务节点而不是重复评审。
    let recoveredReviewNode = runtime.getActiveNodeId();
    while (runtime.stage !== 'ACCEPTED') {
      const stage = runtime.stage;
      host.setWorkflowStatus(ctx, `fix ${stage}`);
      host.trace(`fix ${stage} · continueRun`);

      switch (stage) {
        case 'INTAKE': {
          const r = await exec('intake', problem);
          if (r === 'paused') return 'paused';
          runtime.transition('INVESTIGATING', r.artifact);
          break;
        }
        case 'INVESTIGATING': {
          const recoveredReview = recoveredReviewNode === 'investigation_review'
            ? [...runtime.getArtifacts()].reverse().find((artifact) => artifact.kind === 'investigation')
            : undefined;
          if (recoveredReview) {
            const review = await runReviewChecked(
              'investigation_review',
              prepared.reviewers.investigation_review,
              FIX_REVIEW_POLICIES.investigation_review,
              { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review', context: { previousArtifact: recoveredReview } },
            );
            if (review.passed) runtime.transition('DISPOSITION', recoveredReview);
            else runtime.transition('INVESTIGATING', review.reviewArtifacts[0]);
            recoveredReviewNode = undefined;
            break;
          }
          const r = await exec('investigate', problem);
          if (r === 'paused') return 'paused';
          const investigation = r.artifact as InvestigationArtifact;
          if (investigation.route === 'needs_more_evidence' || investigation.route === 'blocked') {
            recordBlocker('INVESTIGATING', 'INVESTIGATING', investigation.rootCause ?? 'insufficient evidence');
            runtime.transition('BLOCKED', { kind: 'guard_rejection', error: 'evidence insufficient' } as Artifact);
            break;
          }
          const review = await runReviewChecked(
            'investigation_review',
            prepared.reviewers.investigation_review,
            FIX_REVIEW_POLICIES.investigation_review,
            { reviewedNodeId: 'investigate', reviewArtifactKind: 'investigation_review', context: { previousArtifact: r.artifact } },
          );
          if (review.passed) {
            runtime.transition('DISPOSITION', r.artifact);
          } else {
            runtime.transition('INVESTIGATING', review.reviewArtifacts[0]);
          }
          break;
        }
        case 'DISPOSITION': {
          const recoveredReview = recoveredReviewNode === 'change_plan_review'
            ? [...runtime.getArtifacts()].reverse().find((artifact) => artifact.kind === 'disposition') as DispositionArtifact | undefined
            : undefined;
          if (recoveredReview?.requiresRepositoryChange === true) {
            const review = await runReviewChecked(
              'change_plan_review',
              prepared.reviewers.change_plan_review,
              FIX_REVIEW_POLICIES.change_plan_review,
              { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review', context: { previousArtifact: recoveredReview } },
            );
            if (review.passed) runtime.transition('IMPLEMENTING', recoveredReview);
            else runtime.transition('DISPOSITION', review.reviewArtifacts[0]);
            recoveredReviewNode = undefined;
            break;
          }
          // F1：continue_disposition 的用户处置决定内容瞬态传给重跑的 disposition worker（worker
          // 在 capsule.userDecision 中读取“用户决定了什么”，避免重跑仍只带原始 problem 导致
          // wait_decision 反复循环）。来源：最新 checkpoint 的 decisionRecord——只有“刚被
          // continue_disposition 重开”的 DISPOSITION 现场才携带该记录（下一次 transition 即
          // 覆盖）；UI 流程（同一 continueRun 内回流）与 /fix review 后跨调用 /resume 均由此
          // 读回。记录无决定内容（legacy 决策）时按原始 problem 重跑，不退化为错误输入。
          const decisionRecord = store.loadLast(runId)?.decisionRecord;
          const dispositionInput = decisionRecord?.decision === 'continue_disposition'
            ? {
                decision: 'continue_disposition',
                ...(decisionRecord.note !== undefined ? { note: decisionRecord.note } : {}),
                ...(decisionRecord.reasonCode !== undefined ? { reasonCode: decisionRecord.reasonCode } : {}),
              }
            : undefined;
          const r = await exec('disposition', problem, dispositionInput === undefined ? undefined : { userDecision: dispositionInput });
          if (r === 'paused') return 'paused';
          const disposition = r.artifact as DispositionArtifact;
          if (disposition.dispositionType === 'insufficient_evidence') {
            recordBlocker('DISPOSITION', 'DISPOSITION', disposition.conclusion?.summary ?? 'insufficient evidence');
            runtime.transition('BLOCKED', { kind: 'guard_rejection', error: 'evidence insufficient' } as Artifact);
            break;
          }
          // D5：正式方案升级安全门。requiresFormalPlanReview===true 时，Core 正式方案采纳流程
          //（Proposal→Independent Review→Adoption）尚未实现，一律 BLOCKED（保守策略）：不静默进
          // IMPLEMENTING/VERIFYING。Worker 声明 false 不代表产品正式采纳、仅代表 Worker 判断，
          // 该边界在 L2 drift 表记录；“声明 true → BLOCKED”是当前唯一合法接线。
          if (disposition.requiresFormalPlanReview === true) {
            recordBlocker('DISPOSITION', 'DISPOSITION', '需要 Core 正式方案采纳（Proposal→Independent Review→Adoption），当前流程未实现');
            runtime.transition('BLOCKED', { kind: 'guard_rejection', error: 'formal plan review required but not implemented' } as Artifact);
            break;
          }
          // D3：需要用户决定（wait_decision）/ 外部动作完成（external_action）的处置先停
          // WAITING_FOR_USER（pendingDecisionKind 区分等待种类），不得直进 VERIFYING/IMPLEMENTING；
          // 用户决定后由 decide() 的 continue_disposition 回到 DISPOSITION（重落地处置）或
          // VERIFYING（外部动作完成证据）。
          if (disposition.dispositionType === 'wait_decision' || disposition.dispositionType === 'external_action') {
            runtime.setPendingDecisionKind(disposition.dispositionType === 'wait_decision' ? 'disposition_decision' : 'external_action_completion');
            runtime.transition('WAITING_FOR_USER', r.artifact);
            break;
          }
          if (disposition.requiresRepositoryChange === true) {
            const review = await runReviewChecked(
              'change_plan_review',
              prepared.reviewers.change_plan_review,
              FIX_REVIEW_POLICIES.change_plan_review,
              { reviewedNodeId: 'disposition', reviewArtifactKind: 'change_plan_review', context: { previousArtifact: r.artifact } },
            );
            if (review.passed) {
              runtime.transition('IMPLEMENTING', r.artifact);
            } else {
              runtime.transition('DISPOSITION', review.reviewArtifacts[0]);
            }
          } else {
            runtime.transition('VERIFYING', r.artifact);
          }
          break;
        }
        case 'IMPLEMENTING': {
          const recoveredReview = recoveredReviewNode === 'change_review'
            ? [...runtime.getArtifacts()].reverse().find((artifact) => artifact.kind === 'implementation') as Artifact | undefined
            : undefined;
          if (recoveredReview) {
            const review = await runReviewChecked(
              'change_review',
              prepared.reviewers.change_review,
              FIX_REVIEW_POLICIES.change_review,
              { reviewedNodeId: 'implement', reviewArtifactKind: 'change_review', context: { previousArtifact: recoveredReview } },
            );
            if (review.passed && runtime.changeReviewBindsImplementation((results.disposition as ResultProjection | undefined)?.requiresRepositoryChange === true)) runtime.transition('VERIFYING', recoveredReview);
            else if (review.passed) { pauseRecoverableNode('change_review', 'IMPLEMENTING', new WorkflowRuntimeError('CHANGE_REVIEW_NOT_BOUND', 'change_review must bind the current implementation candidateRevision before entering verification')); return 'paused'; }
            else runtime.transition('IMPLEMENTING', review.reviewArtifacts[0]);
            recoveredReviewNode = undefined;
            break;
          }
          const r = await exec('implement', problem);
          if (r === 'paused') return 'paused';
          const review = await runReviewChecked(
            'change_review',
            prepared.reviewers.change_review,
            FIX_REVIEW_POLICIES.change_review,
            { reviewedNodeId: 'implement', reviewArtifactKind: 'change_review', context: { previousArtifact: r.artifact } },
          );
          if (review.passed) {
            // 仓库变更路径下 change_review 必须绑定当前 implementation 的 candidateRevision：
            // 未绑定（含缺失/不一致）不得视为通过、不得以未绑定评审进入验证。
            if (!runtime.changeReviewBindsImplementation(results.disposition?.requiresRepositoryChange === true)) {
              pauseRecoverableNode('change_review', 'IMPLEMENTING', new WorkflowRuntimeError('CHANGE_REVIEW_NOT_BOUND', 'change_review must bind the current implementation candidateRevision before entering verification'));
              return 'paused';
            }
            runtime.transition('VERIFYING', r.artifact);
          } else {
            runtime.transition('IMPLEMENTING', review.reviewArtifacts[0]);
          }
          break;
        }
        case 'VERIFYING': {
          let r = await exec('verify', problem);
          if (r === 'paused') return 'paused';
          try {
            guardVerification(FIX_VERIFICATION_REQUIREMENT, r.artifact as VerificationArtifact, { requiresRepositoryChange: runtime.dispositionRequiresRepositoryChange() });
          } catch (guardError) {
            host.trace(`verify · 验证契约不满足，重试一次遵守契约: ${guardError instanceof Error ? guardError.message : String(guardError)}`);
            const retried = await exec('verify', problem, { supplementalInformation: '遵守验证契约：证据需带 tool:/test:/external 来源、必检项齐全且值显式为 true、无未验证项，并给出剩余风险' });
            if (retried === 'paused') return 'paused';
            r = retried;
            try {
              guardVerification(FIX_VERIFICATION_REQUIREMENT, r.artifact as VerificationArtifact, { requiresRepositoryChange: runtime.dispositionRequiresRepositoryChange() });
            } catch (secondGuardError) {
              pauseRecoverableNode('verify', 'VERIFYING', withGuardCode(secondGuardError));
              return 'paused';
            }
          }
          if (checkVerificationAccepted(r.artifact as VerificationArtifact)) {
            runtime.setPendingDecisionKind('final_acceptance');
            runtime.transition('WAITING_FOR_USER', r.artifact);
          } else {
            // 验证失败三向路由（D4）：实现可修复 → IMPLEMENTING；配置问题（无仓库变更，
            // 用户修改配置）→ WAITING_FOR_USER；权限/环境/外部依赖缺失 → BLOCKED。
            // 契约保证 accepted===false 必带 failure.kind；此处容错回退不改变契约权威。
            const failure = (r.artifact as VerificationArtifact).failure;
            if (failure?.kind === 'external_condition') {
              recordBlocker('VERIFYING', 'VERIFYING', failure.reason);
              runtime.transition('BLOCKED', { kind: 'guard_rejection', error: failure.reason } as Artifact);
            } else if (failure?.kind === 'configuration') {
              runtime.setPendingDecisionKind('configuration_wait');
              runtime.transition('WAITING_FOR_USER', r.artifact);
            } else {
              runtime.transition('IMPLEMENTING', r.artifact);
            }
          }
          break;
        }
        case 'WAITING_FOR_USER': {
          // 人工决定点：验证通过后进入最终验收（final_acceptance）；配置类验证失败
          //（accepted:false 且 failure.kind==='configuration'）等待用户修改配置（configuration_wait）；
          // D3 处置等待：wait_decision → disposition_decision（等用户处置决定），
          // external_action → external_action_completion（等外部动作完成证据）。
          const requestId = store.loadLast(runId)?.pendingDecisionRequest;
          const candidate = results.implementation?.artifact?.candidateRevision ?? results.verification?.candidateRevision;
          const reviewConclusions = extractReviewConclusions();
          const intakeSummary = typeof results.intake?.summary === 'string' && results.intake.summary ? results.intake.summary : '尚未确认';
          const intakeOverview = typeof results.intake?.overview === 'string' ? results.intake.overview : undefined;
          // 等待种类以 Runtime 持久化的 pendingDecisionKind 为准（D3 两类处置等待没有验证现场，
          // isPendingConfigurationWait 推导不出）；legacy checkpoint 缺字段时回退到 Verification 推导。
          const pendingWaitKind = runtime.getPendingDecisionKind();
          const isDispositionWait = isDispositionWaitKind(pendingWaitKind);
          const isConfigWait = (pendingWaitKind === 'configuration_wait') || (!isDispositionWait && runtime.isPendingConfigurationWait());
          const configReason = isConfigWait ? results.verification?.failure?.reason : undefined;
          const dispositionWaitNotice = isDispositionWait
            ? pendingWaitKind === 'disposition_decision'
              ? '- 等待你对处置作出决定（继续处置 / 打回）。'
              : '- 等待外部动作完成证据（完成后继续验证 / 打回）。'
            : undefined;
          const summary = [
            '# Fix 结果待确认',
            '',
            '## 现象',
            intakeSummary,
            ...(intakeOverview ? [intakeOverview] : []),
            '',
            '## 根因',
            results.investigation?.rootCause ?? '未确认',
            '',
            '## 处置',
            results.disposition?.conclusion?.summary ?? '未确认',
            '',
            '## 变更',
            results.implementation?.artifact?.summary ?? '无（未产生仓库变更）',
            '',
            // 处置等待没有验证现场：不展示验证区段（避免把旧/泛化信息当验证证据）。
            ...(isConfigWait || results.verification
              ? [
                  '## 验证',
                  ...(results.verification?.evidence?.length
                    ? results.verification.evidence.map((item: unknown) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`)
                    : ['- 未提供验证证据']),
                ]
              : []),
            ...(isConfigWait
              ? ['', '## 待用户处理', `- 阻塞原因（需用户修改配置或提供条件）：${configReason ?? '配置问题'}`, '- 当前 Agent 不直接修改配置，请在处理后继续。']
              : isDispositionWait
                ? ['', '## 待用户处理', dispositionWaitNotice!]
                : []),
            '',
            '## 风险',
            results.verification?.remainingRisk?.length ? results.verification.remainingRisk.join('、') : '无',
            '',
            '## 未验证',
            results.verification?.unverified?.length ? results.verification.unverified.join('、') : '无',
            '',
            '## 评审结论',
            ...reviewConclusions.map(
              (c) => `- ${c.nodeId}: ${c.status ?? 'unknown'}${c.summary ? ` · ${c.summary}` : ''}`,
            ),
          ].join('\n');
          const payload = buildReviewPayload(runId, requestId, {
            summary: results.intake?.summary,
            overview: results.intake?.overview,
            candidateRevision: candidate,
            rootCause: results.investigation?.rootCause,
            dispositionSummary: results.disposition?.conclusion?.summary,
            changeSummary: results.implementation?.artifact?.summary,
            filesChanged: results.implementation?.artifact?.filesChanged,
            evidence: results.verification?.evidence,
            unverified: results.verification?.unverified,
            remainingRisk: results.verification?.remainingRisk,
            ...(isConfigWait && results.verification?.failure ? { verificationFailure: results.verification.failure } : {}),
            reviewConclusions,
          });
          host.appendEntry('workflow-decision-pending', payload);
          host.sendMessage?.({
            customType: 'workflow-review',
            content: summary,
            display: true,
            details: { runId, stage: 'WAITING_FOR_USER', requestId },
          });
          ctx.ui.notify(`WAITING_FOR_USER<review pending> runId=${runId}`);

          // 收集中断返回 undefined（用户取消/RPC 无 UI）时保持 WAITING_FOR_USER。
          const hasSelect = typeof ctx.ui.select === 'function';
          // 配置类等待只提供“继续验证/拒绝”；D3 处置等待提供“继续（用户已决定/外部动作已完成）/打回/
          // 拒绝”（approve 在无验证现场时会被 acceptance 拒绝，不列为选项）；final_acceptance 只提供
          // 验收三动作，不展示 continue-disposition（无处置等待现场，decide 会抛 NOT_AVAILABLE）。
          const decision = await collectDecision(
            {
              hasUI: ctx.hasUI && hasSelect,
              notify: (message, type) => ctx.ui.notify(message, type),
              select: (title, options) => (hasSelect ? ctx.ui.select(title, options) : Promise.resolve(undefined)),
              // F1：continue-disposition 需要收集用户处置决定内容（note）；无 input 能力的宿主缺省跳过。
              input: typeof ctx.ui.input === 'function' ? (prompt, placeholder) => ctx.ui.input(prompt, placeholder ?? '') : undefined,
            },
            isDispositionWait
              ? {
                  requestId, candidateRevision: candidate, summary,
                  actions: pendingWaitKind === 'disposition_decision'
                    ? ['继续（已作出处置决定）', '打回（选择原因）', '拒绝']
                    : ['继续（外部动作已完成）', '打回（选择原因）', '拒绝'],
                }
              : isConfigWait
                ? { requestId, candidateRevision: candidate, summary, actions: ['继续验证（配置已修改）', '拒绝'] }
                // final_acceptance（或 legacy 验证已接受的等待）：只提供验收三动作，不展示无效的
                // continue-disposition 选项（选中后 decide 抛 CONTINUE_DISPOSITION_NOT_AVAILABLE 冒泡）。
                : { requestId, candidateRevision: candidate, summary, actions: ['通过并接受', '打回（选择原因）', '拒绝'] },
          );
          if (decision === undefined) {
            ctx.ui.notify(`WAITING_FOR_USER: ${runId}`);
            host.clearWorkflowWorking(ctx);
            return 'waiting';
          }
          const requiresChange = results.disposition?.requiresRepositoryChange === true;
          const acceptance = runtime.evaluateAcceptance({ userDecision: decision, requiresRepositoryChange: requiresChange });
          if (decision.decision === 'approve' && !acceptance.passed) {
            ctx.ui.notify(`WAITING_FOR_USER: 验收条件未满足（缺: ${acceptance.missing.join(', ')}）。Run 保持待确认: ${runId}`, 'warning');
            host.clearWorkflowWorking(ctx);
            return 'waiting';
          }
          runtime.decide(decision, { reasonToStage: fixReasonToStage, acceptance });
          break;
        }
        case 'BLOCKED': {
          // 无 UI 或用户未提供补充信息时保持 BLOCKED。
          if (!ctx.hasUI) {
            ctx.ui.notify(`BLOCKED: ${runId}`);
            host.clearWorkflowWorking(ctx);
            return 'blocked';
          }
          const extra = (await ctx.ui.input('补充信息（留空保持 BLOCKED）', ''))?.trim();
          if (!extra) {
            ctx.ui.notify(`BLOCKED: ${runId}`);
            host.clearWorkflowWorking(ctx);
            return 'blocked';
          }
          // 按解锁目标阶段选择 worker：INVESTIGATING→investigate、DISPOSITION→disposition、
          // VERIFYING→verify，其余回落到 investigate；guard 要求解锁 Artifact 与目标阶段 kind 匹配。
          const workerNode: FixWorkerNodeId =
            blockedReturn.stage === 'DISPOSITION' ? 'disposition' : blockedReturn.stage === 'VERIFYING' ? 'verify' : 'investigate';
          const r = await exec(workerNode, problem, { supplementalInformation: extra });
          if (r === 'paused') return 'paused';
          runtime.transition(blockedReturn.stage, r.artifact);
          break;
        }
        default:
          break;
      }
    }

    // 11. ACCEPTED：产出最终处置报告并收尾。
    const report = buildFixReport(results);
    host.appendEntry('workflow-fix-report', { runId, traceId: runId, report });
    host.trace(report);
    ctx.ui.notify(`ACCEPTED: ${runId}`);
    host.clearWorkflowWorking(ctx);
    return 'accepted';
  } catch (error) {
    // 提交类错误已在 exec 内部重试一次；此处兜底不再重试，保留 checkpoint。
    if (error instanceof WorkerArtifactSubmissionError || error instanceof ArtifactContractError) {
      host.trace(`${error.code}: ${error.message}`, 'error');
      ctx.ui.notify(`fix paused: ${error.code}`, 'error');
      host.clearWorkflowWorking(ctx);
      return 'paused';
    }
    // 其他错误（checkpoint 恢复 / 门禁 / 来源绑定等 Runtime 控制面错误）：trace + notify + 暂停
    // （不清 checkpoint 以便重试），错误码统一保留在通知与 trace 中。失败后清理 working 状态，
    // 避免 UI 一直显示执行中。
    const detail = withErrorCode(error instanceof Error ? error.message : String(error), error);
    host.trace(`failed · ${detail}`, 'error');
    ctx.ui.notify(`fix failed: ${detail}`, 'error');
    host.clearWorkflowWorking(ctx);
    return 'paused';
  }
}

// ============================================================
// command 层：/fix handler、/fix review 评审命令、session_start(resume) 与 default export
// ============================================================

// Runtime 控制面错误统一收敛为 `message (CODE)`：任何带稳定 code 的错误（CheckpointRestoreError /
// WorkflowRuntimeError / ReviewPolicyError / 合同错误）都保留 code 用于排障与自动化判定，
// 不因错误类型分支遗漏而退化为无 code 的自由文本。
const errorCodeOf = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
};
const withErrorCode = (message: string, error: unknown): string => {
  const code = errorCodeOf(error);
  return code === undefined ? message : `${message} (${code})`;
};

// 处置等待种类判定（pendingDecisionKind）：disposition_decision / external_action_completion 两类
// 处置等待才提供 continue-disposition 出口；final_acceptance / configuration_wait 不展示该动作
//（选中后 decide 会抛 CONTINUE_DISPOSITION_NOT_AVAILABLE，见 workflow-runtime decideCore）。
const isDispositionWaitKind = (kind: PendingDecisionKind | undefined): boolean =>
  kind === 'disposition_decision' || kind === 'external_action_completion';

// 由 checkpoint 现场推导“配置类验证失败等待”（与 runtime.isPendingConfigurationWait 语义一致：
// 最新 verification accepted=false 且 failure.kind=configuration），供 /fix review 无 action 路径
// 在 restore 之前按等待种类收窄动作集（legacy checkpoint 缺 pendingDecisionKind 时回退推导）。
const checkpointIsConfigWait = (checkpoint: Checkpoint): boolean => {
  const verification = [...(checkpoint.artifacts ?? [])].reverse().find((artifact) => artifact.kind === 'verification') as VerificationArtifact | undefined;
  return verification?.accepted === false && verification?.failure?.kind === 'configuration';
};

// 引号包裹的多词内容解析：`"..."` 剥掉最外层英文引号；无引号（单 token）保持原样（向后兼容）。
const unquoteContent = (token: string): string => {
  const quoted = /^"([\s\S]*)"$/.exec(token);
  return quoted ? quoted[1] : token;
};

// 应用一次人工最终验收决策：恢复 run（版本/策略摘要校验）、求值 acceptance、decide 并产出结果。
// 供 runReviewCommand 的两个分支（命令行已带 action / UI collectDecision 收集）复用；
// approve 通过时写最终处置报告（与 continueRun ACCEPTED 收尾共用模块级 buildFixReport）。
async function applyReviewDecision(
  ctx: ExtensionCommandContext,
  deps: { store: RunStore; host: FixHost; policyDigest?: string },
  runId: string,
  decision: UserDecisionArtifact,
): Promise<void> {
  // 恢复 run：workflow 版本必须匹配；policyDigest 未提供（undefined）时 restore 跳过摘要校验。
  // 策略变更时旧 checkpoint 的 digest 与当前有效策略不一致，restore 抛 POLICY_DIGEST_MISMATCH：
  // 决策被拒绝并明确通知，不能静默按旧策略继续验收。
  let runtime: WorkflowRuntime;
  try {
    runtime = WorkflowRuntime.restore(fixDefinitionV2, deps.store, runId, {
      expectedWorkflowVersion: FIX_WORKFLOW_VERSION,
      expectedPolicyDigest: deps.policyDigest,
      reviewPolicyFor: (reviewArtifactKind) => FIX_REVIEW_POLICIES[reviewArtifactKind],
      // 决策路径的 Runtime 审计事件同样落盘（与 continueRun 一致）。
      auditSink: { append: (event) => deps.host.appendEntry('workflow-audit', event) },
    });
  } catch (error) {
    // 任何带稳定 code 的 Runtime 控制错误都保留 code（策略拒绝 / 身份冲突 / 账本不一致 / 来源绑定）。
    const code = errorCodeOf(error) ?? 'RESTORE_FAILED';
    deps.host.trace(`fix review restore rejected · ${code}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    ctx.ui.notify(`fix review 决策被拒绝（${code}）: ${runId}`, 'warning');
    return;
  }
  // 不再自动补齐 candidateRevision：run 已产生候选版本时，approve 决策缺失或不匹配必须被拒绝；
  // 只有显式匹配的版本可以继续（版本绑定校验由 runtime.decide 强制）。
  // requiresRepositoryChange 取“最新” disposition：旧处置不覆盖新处置。
  const requiresRepositoryChange = runtime.dispositionRequiresRepositoryChange();
  const acceptance = runtime.evaluateAcceptance({ userDecision: decision, requiresRepositoryChange });
  if (decision.decision === 'approve' && !acceptance.passed) {
    ctx.ui.notify(`fix review 验收条件未满足（缺: ${acceptance.missing.join(', ')}）: ${runId}`, 'warning');
    return;
  }
  let outcome: { outcome: 'accepted' | 'reopened' | 'blocked'; toStage?: Stage } | undefined;
  try {
    outcome = runtime.decide(decision, { reasonToStage: fixReasonToStage, acceptance });
  } catch (error) {
    // 决策被拒绝而非执行失败：approve 缺版本/版本不匹配等应明确通知用户，不当作通用 run 失败。
    const code = errorCodeOf(error) ?? 'DECISION_FAILED';
    deps.host.trace(`fix review decision rejected · ${code}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    ctx.ui.notify(`fix review 决策被拒绝（${code}）: ${runId}`, 'warning');
    return;
  }
  if (outcome.outcome === 'accepted') {
    const report = buildFixReport(
      Object.fromEntries(runtime.getArtifacts().map((a) => [a.kind, a])),
    );
    deps.host.appendEntry('workflow-fix-report', { runId, traceId: runId, report });
    deps.host.trace(report);
    ctx.ui.notify(`ACCEPTED: ${runId}`);
    return;
  }
  ctx.ui.notify(`fix review ${outcome.outcome}${outcome.toStage ? ` -> ${outcome.toStage}` : ''}: ${runId}`);
}

// /fix review 评审命令：定位一个 WAITING_FOR_USER 的待最终验收 run 并处理用户决策。
// 用法：/fix review [runId] [approve|request-changes <原因码>|reject [原因码]|continue-verification|continue-disposition]
// - 无 action：只展示待评审详情（sendMessage + notify）；有 UI 时用 collectDecision 交互收集；
// - 有 action（approve / request-changes / reject / continue-verification / continue-disposition）：校验后构造 user_decision 并 applyReviewDecision。
// runId 缺省时取最近未完成且 stage=WAITING_FOR_USER 的 run；否则 loadLast(runIdToken) 并校验 stage。
async function runReviewCommand(
  ctx: ExtensionCommandContext,
  args: string,
  deps: { store: PiSessionRunStore; host: FixHost; policyDigest?: string; live?: LiveFixRunManager },
): Promise<void> {
  let reviewStore: RunStore = deps.store;
  let reviewWal: RunControlWal | undefined;
  let liveCheckpoint: Checkpoint | undefined;
  if (deps.live && typeof ctx.sessionManager.getSessionId === 'function') {
    try {
      const runIdMatch = args.match(/^review(?:\s+(\S+))?/);
      const selected = runIdMatch?.[1] ? { store: deps.live.openStore(ctx, runIdMatch[1]), checkpoint: undefined } : deps.live.latestStore(ctx);
      if (selected) { reviewStore = selected.store; reviewWal = selected.store.wal; liveCheckpoint = selected.checkpoint; }
    } catch (error) {
      ctx.ui.notify(`fix review WAL recovery failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return;
    }
  }
  const releaseReviewLease = () => { if (reviewWal) { try { reviewWal.releaseLease(); } catch { /* preserve WAL for explicit recovery */ } reviewWal = undefined; } };
  // 动作后的剩余全部内容作为 note/reasonCode 载体（P3）：continue-disposition 需要承载含空格的
  // 多词决定内容，支持引号包裹（`"..."`）；无引号的单 token 保持向后兼容。
  const match = args.match(/^review(?:\s+(\S+))?(?:\s+(approve|request-changes|reject|continue-verification|continue-disposition))?(?:\s+(.+))?\s*$/);
  const runIdToken = match?.[1] || undefined;
  const action = match?.[2] as 'approve' | 'request-changes' | 'reject' | 'continue-verification' | 'continue-disposition' | undefined;
  const reasonToken = match?.[3] || undefined;
  // 引号包裹的多词内容：`/fix review <runId> continue-disposition "用户决定按 mitigation 处置"`；
  // 无引号单 token 保持原样（向后兼容）。request-changes 的原因码仍必须是 FIX_REVIEW_REASONS 枚举值。
  const content = reasonToken === undefined ? undefined : unquoteContent(reasonToken.trim());

  const trusted = ctx.isProjectTrusted();
  const currentPolicyDigest = loadEffectivePolicy(ctx.cwd, { trusted }).digest;
  // 当前命令必须按当前有效策略恢复；调用方传入的旧 digest 不能绕过策略变更。
  const reviewDeps = { ...deps, policyDigest: currentPolicyDigest };

  // 定位 run：给 runIdToken 则 loadLast 并校验 stage；否则取最近未完成的 WAITING_FOR_USER run。
  const checkpoint = runIdToken ? reviewStore.loadLast(runIdToken) : liveCheckpoint ?? deps.store.latestUncompleted();
  if (!checkpoint || checkpoint.stage !== 'WAITING_FOR_USER') {
    releaseReviewLease();
    ctx.ui.notify('no pending fix review');
    return;
  }
  const runId = checkpoint.runId;
  const requestId = reviewStore.loadLast(runId)?.pendingDecisionRequest;
  const candidate = reviewStore.loadLast(runId)?.candidateRevision;

  // 无 action：只展示待评审详情（不写 entry）；有 UI 时用 collectDecision 收集决策（视为有 action 继续）。
  if (!action) {
    deps.host.sendMessage?.({
      customType: 'workflow-review',
      content: `fix review pending · runId: ${runId}${requestId ? ` · requestId: ${requestId}` : ''}`,
      display: true,
      details: { runId, requestId },
    });
    ctx.ui.notify(`fix review pending: ${runId}`);
    if (ctx.hasUI && typeof ctx.ui.select === 'function') {
      // 按等待种类（checkpoint.pendingDecisionKind；legacy 缺字段时由验证现场推导）收窄动作集：
      // 处置等待才展示 continue-disposition；configuration_wait 只提供“继续验证/拒绝”；
      // final_acceptance 只提供验收三动作，不展示无效的 continue-disposition 选项。
      const pendingKind = checkpoint.pendingDecisionKind;
      const isDispositionWait = isDispositionWaitKind(pendingKind);
      const isConfigWait = pendingKind === 'configuration_wait' || (!isDispositionWait && checkpointIsConfigWait(checkpoint));
      const actions = isDispositionWait
        ? pendingKind === 'disposition_decision'
          ? ['继续（已作出处置决定）', '打回（选择原因）', '拒绝']
          : ['继续（外部动作已完成）', '打回（选择原因）', '拒绝']
        : isConfigWait
          ? ['继续验证（配置已修改）', '拒绝']
          : ['通过并接受', '打回（选择原因）', '拒绝'];
      const decision = await collectDecision(
        {
          hasUI: true,
          notify: (message, type) => ctx.ui.notify(message, type),
          select: (title, options) => ctx.ui.select(title, options),
          // F1：continue-disposition 需要收集用户处置决定内容（note）；无 input 能力的宿主缺省跳过。
          input: typeof ctx.ui.input === 'function' ? (prompt, placeholder) => ctx.ui.input(prompt, placeholder ?? '') : undefined,
        },
        { requestId, candidateRevision: candidate, actions },
      );
      if (decision) await applyReviewDecision(ctx, { ...deps, store: reviewStore, policyDigest: currentPolicyDigest }, runId, decision);
    }
    releaseReviewLease();
    return;
  }

  // 有 action：动作必须属于 FIX_REVIEW_ACTIONS 值域（regex 已限五值，此处防御性校验）；
  // request-changes 必须给原因码且 ∈ FIX_REVIEW_REASONS 值；continue-disposition 必须携带
  // 用户处置决定内容（reasonCode 承载，与 UI 的 note 同为决定内容载体）；
  // approve / reject / continue-verification 原因码可选。
  if (!(Object.values(FIX_REVIEW_ACTIONS) as string[]).includes(action)) {
    releaseReviewLease();
    ctx.ui.notify('usage: /fix review <runId> approve|request-changes|reject|continue-verification|continue-disposition');
    return;
  }
  let reasonCode: string | undefined;
  if (action === 'request-changes') {
    if (!content || !(Object.values(FIX_REVIEW_REASONS) as string[]).includes(content)) {
      releaseReviewLease();
      ctx.ui.notify('usage: /fix review <runId> request-changes <原因码>');
      return;
    }
    reasonCode = content;
  } else if (action === 'continue-disposition') {
    // F1：continue_disposition 必须携带用户决定内容，避免无内容继续造成 wait_decision 反复循环。
    // 内容可含空格：引号包裹或多 token 整体作为内容；无引号单 token 保持兼容。
    if (!content) {
      releaseReviewLease();
      ctx.ui.notify('usage: /fix review <runId> continue-disposition <处置决定内容>');
      return;
    }
    reasonCode = content;
  } else {
    reasonCode = content;
  }
  const decision: UserDecisionArtifact = {
    kind: 'user_decision',
    decision: action === 'request-changes'
      ? 'request_changes'
      : action === 'continue-verification'
        ? 'continue_verification'
        : action === 'continue-disposition'
          ? 'continue_disposition'
          : action,
    // stage=WAITING_FOR_USER 的 checkpoint 必带 pendingDecisionRequest（runtime.transition 生成）。
    requestId: requestId!,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    ...(candidate !== undefined ? { candidateRevision: candidate } : {}),
  };
  await applyReviewDecision(ctx, { ...reviewDeps, store: reviewStore }, runId, decision);
  releaseReviewLease();
}

// /fix 主命令入口：review 分支转交 runReviewCommand；problem 分支校验问题描述、生成 runId、
// prepareRun、写 INTAKE checkpoint（含 workflowVersion 与本 Run 的 policyDigest）后进入 continueRun。
// deps.policyDigest 专供 review 分支恢复时校验策略摘要；problem 分支使用 prepared.policyDigest。
export async function handleFixCommand(
  ctx: ExtensionCommandContext,
  args: string,
  deps: { store: PiSessionRunStore; host: FixHost; injected?: WorkerExecutor; policyDigest?: string; live?: LiveFixRunManager },
): Promise<void> {
  const trimmed = args.trim();
  if (/^review(\s|$)/.test(trimmed)) {
    await runReviewCommand(ctx, trimmed, deps);
    return;
  }
  const parsed = parseFixCommand(trimmed);
  if (!parsed.valid) {
    ctx.ui.notify(parsed.usage!);
    return;
  }
  const runId = `fix-${Date.now()}-${randomUUID()}`;
  // In the real Extension host, the Worker is a background Child AgentSession.
  // Tests and explicitly injected executors retain the synchronous compatibility path.
  if (deps.live && !deps.injected) {
    if (deps.live.hasOwner(ctx)) {
      ctx.ui.notify('当前 Fix 仍在执行，不能同时启动第二个接收者', 'warning');
      return;
    }
    let binding: LiveRunBinding | undefined;
    try {
      binding = deps.live.createBinding(ctx, runId);
      installLiveModelControls(ctx, deps.live, binding);
      deps.host.appendEntry('workflow-command', { operation: 'start', runId, traceId: runId, time: Date.now() });
      const prepared = prepareRun(ctx, deps.host, undefined, binding);
      binding.store.saveCheckpoint({
        runId, schemaVersion: 1, stage: 'INTAKE', at: Date.now(), id: `${runId}-initial`, problem: parsed.problem,
        workflowVersion: FIX_WORKFLOW_VERSION, policyDigest: prepared.policyDigest,
      });
      deps.host.setWorkflowStatus(ctx, 'fix INTAKE · background Worker', true);
      activeTraceId = runId;
      const promise = continueRun(ctx, binding.store, runId, parsed.problem!, prepared, deps.host, { injected: undefined });
      deps.live.attach({ binding, promise, parentContext: ctx });
      return;
    } catch (error) {
      deps.live.registry.release(runId);
      try { binding?.wal.releaseLease(); } catch { /* preserve the WAL for explicit recovery */ }
      ctx.ui.notify(`fix 未启动（${error instanceof Error ? error.message : String(error)}）`, 'error');
      deps.host.clearWorkflowWorking(ctx);
      return;
    }
  }
  try {
    activeTraceId = runId;
    deps.host.setWorkflowStatus(ctx, 'fix INTAKE · preparing worker');
    const prepared = prepareRun(ctx, deps.host, deps.injected);
    deps.host.trace('trace started · new workflow');
    deps.host.appendEntry('workflow-command', { operation: 'start', runId, traceId: runId, time: Date.now() });
    deps.store.saveCheckpoint({
      runId,
      schemaVersion: 1,
      stage: 'INTAKE',
      at: Date.now(),
      id: `${runId}-initial`,
      problem: parsed.problem,
      workflowVersion: FIX_WORKFLOW_VERSION,
      policyDigest: prepared.policyDigest,
    });
    await continueRun(ctx, deps.store, runId, parsed.problem!, prepared, deps.host, { injected: deps.injected });
  } catch (error) {
    // 兜底恢复：提交类错误在 continueRun/exec 内部已重试一次，此处保留 checkpoint。
    deps.host.clearWorkflowWorking(ctx);
    const message = error instanceof Error ? error.message : String(error);
    const recovery = error instanceof WorkerArtifactSubmissionError
      ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry ${error.nodeId}.`
      : error instanceof ArtifactContractError
        ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry the current stage.`
        : '';
    deps.host.setWorkflowStatus(ctx, `fix failed · ${message}`, false);
    deps.host.trace(`failed · ${message}${recovery}`, 'error');
    ctx.ui.notify(`fix failed: ${message}${recovery}`, 'error');
  } finally {
    activeTraceId = undefined;
  }
}

// session_start(reason='resume') 恢复入口：取最近未完成 checkpoint，用户确认后重新 prepareRun
// 并从 checkpoint 阶段继续；WAITING_FOR_USER 阶段跳过重复确认（决策已由用户发起）。
// host 缺省时用 makeFixHost(pi) 自建（与 default export 闭包等价，host 无内部状态）。
export async function resumeFromSession(pi: ExtensionAPI, ctx: ExtensionCommandContext, host?: FixHost, live?: LiveFixRunManager): Promise<void> {
  const gateway = host ?? makeFixHost(pi);
  const injected = (pi as ExtensionAPI & { fixWorker?: WorkerExecutor }).fixWorker;
  const store = new PiSessionRunStore(ctx.sessionManager, (type, data) => pi.appendEntry(type, data));
  const liveCandidate = live && !injected ? live.latestStore(ctx) : undefined;
  const checkpoint = liveCandidate?.checkpoint ?? store.latestUncompleted();
  if (!checkpoint || !checkpoint.problem) { try { liveCandidate?.store.wal.releaseLease(); } catch { /* best effort */ } return; }
  if (!ctx.hasUI || !(await ctx.ui.confirm('恢复 fix 工作流', `${checkpoint.problem}\n当前阶段：${checkpoint.stage}`))) { try { liveCandidate?.store.wal.releaseLease(); } catch { /* best effort */ } return; }
  try { liveCandidate?.store.wal.releaseLease(); } catch { /* reacquire through the binding below */ }
  // Legacy parent checkpoints are imported once into the protected WAL before
  // a resumed Worker can start. Conflicts and branch ambiguity fail closed.
  if (live && !injected && !liveCandidate) {
    try { live.migrateLegacyCheckpoint(ctx, checkpoint); }
    catch (error) { ctx.ui.notify(`Fix 恢复失败：无法迁移 legacy checkpoint（${error instanceof Error ? error.message : String(error)}）`, 'error'); return; }
  }
  let binding: LiveRunBinding | undefined;
  let handedOff = false;
  try {
    binding = live && !injected ? live.createBinding(ctx, checkpoint.runId) : undefined;
    if (binding && live) installLiveModelControls(ctx, live, binding);
    const prepared = prepareRun(ctx, gateway, injected, binding);
    const runStore: RunStore = binding?.store ?? store;
    if (binding && !binding.store.loadLast(checkpoint.runId)) runStore.saveCheckpoint(checkpoint);
    activeTraceId = checkpoint.runId;
    gateway.trace(`trace started · resumed from ${checkpoint.stage}`);
    gateway.appendEntry('workflow-command', {
      operation: 'session-resume',
      runId: checkpoint.runId,
      traceId: checkpoint.runId,
      time: Date.now(),
    });
    const promise = continueRun(ctx, runStore, checkpoint.runId, checkpoint.problem, prepared, gateway, {
      injected,
      confirmationAlreadyGiven: checkpoint.stage === 'WAITING_FOR_USER',
    });
    if (binding && live) {
      live.attach({ binding, promise, parentContext: ctx });
      handedOff = true;
      return;
    }
    await promise;
  } catch (error) {
    try { binding?.wal.releaseLease(); } catch { /* preserve the WAL for explicit recovery */ }
    gateway.clearWorkflowWorking(ctx);
    const message = error instanceof Error ? error.message : String(error);
    const recovery = error instanceof WorkerArtifactSubmissionError
      ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry ${error.nodeId}.`
      : error instanceof ArtifactContractError
        ? ` ${error.code}; checkpoint retained. Use Pi /resume to retry the current stage.`
        : '';
    gateway.setWorkflowStatus(ctx, `fix failed · ${message}`, false);
    gateway.trace(`failed · ${message}${recovery}`, 'error');
    ctx.ui.notify(`fix failed: ${message}${recovery}`, 'error');
  } finally {
    if (!handedOff) activeTraceId = undefined;
  }
}

function authenticatedModelRefs(ctx: ExtensionContext): string[] {
  const scoped = ctx.scopedModels.map((item) => item.model);
  const models = (scoped.length ? scoped : ctx.modelRegistry.getAvailable()).filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
  return models.map((model) => `${model.provider}/${model.id}`);
}

function installLiveModelControls(ctx: ExtensionContext, live: LiveFixRunManager, binding: LiveRunBinding): void {
  if (ctx.mode !== 'tui') return;
  if (ctx.ui.getEditorComponent() !== binding.previousEditor) return;
  const previous = binding.previousEditor;
  ctx.ui.setEditorComponent((tui, theme, keybindings) => {
    // Compose with the editor installed by another extension. Do not silently
    // replace its editing/history behavior; CustomEditor is only the fallback.
    const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    const select = async () => {
      const worker = live.activeFor(ctx);
      if (!worker) { ctx.ui.notify('当前没有可切换模型的 Worker', 'warning'); return; }
      const candidates = authenticatedModelRefs(ctx);
      if (!candidates.length) { ctx.ui.notify('当前 Worker 没有已认证的可选模型', 'warning'); return; }
      const selected = await ctx.ui.select('选择当前 Worker 模型', candidates);
      if (!selected) return;
      const result = await workerInteractionModel(live, worker, selected);
      ctx.ui.notify(result?.state === 'pending' ? `模型已请求，待下一次调用生效：${selected}` : `模型切换${result?.state ?? 'failed'}`, result?.state === 'failed' ? 'error' : 'info');
    };
    const cycle = async (direction: 1 | -1) => {
      const worker = live.activeFor(ctx);
      if (!worker) return;
      const candidates = authenticatedModelRefs(ctx);
      const current = `${worker.actualModel.provider}/${worker.actualModel.id}`;
      const index = candidates.indexOf(current);
      const next = candidates[(index + direction + candidates.length) % candidates.length];
      if (next) await workerInteractionModel(live, worker, next);
    };
    const onAction = (editor as unknown as { onAction?: (action: string, handler: () => void) => void }).onAction;
    if (onAction) {
      onAction.call(editor, 'app.model.select', () => { void select(); });
      onAction.call(editor, 'app.model.cycleForward', () => { void cycle(1); });
      onAction.call(editor, 'app.model.cycleBackward', () => { void cycle(-1); });
    }
    return editor;
  });
}

// fix v2 Extension 入口：register /fix 命令 + session_start(resume) 钩子。
export default function fixExtensionV2(pi: ExtensionAPI) {
  const host = makeFixHost(pi);
  const live = new LiveFixRunManager();

  pi.on('input', async (event: InputEvent, ctx): Promise<InputEventResult> => {
    const owner = live.ownerFor(ctx);
    if (!owner || event.source === 'extension' || event.text.startsWith('/')) return { action: 'continue' };
    // Ownership is checked before Child lookup: starting, settlement, and the
    // publication gap are all handled locally and never leak to the parent.
    try {
      const expectedNodeExecutionId = live.activeFor(ctx)?.nodeExecutionId ?? owner.nodeExecutionId;
      const result = await workerInteraction(live, owner.runId, expectedNodeExecutionId, event.text, event.images);
      if (result?.state !== 'enqueue_accepted') {
        try { ctx.ui.setEditorText(event.text); } catch { /* best effort */ }
        ctx.ui.notify(`补充信息未投递：${result?.error ?? result?.state ?? 'unknown'}；文本已保留`, 'warning');
      }
    } catch (error) {
      try { ctx.ui.setEditorText(event.text); } catch { /* best effort */ }
      ctx.ui.notify(`补充信息未投递，文本已保留：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
    return { action: 'handled' };
  });
  pi.on('session_before_tree', async (_event, ctx) => ({ cancel: live.hasOwner(ctx) }));
  pi.on('session_before_switch', async (_event, ctx) => ({ cancel: live.hasOwner(ctx) }));
  pi.on('session_before_fork', async (_event, ctx) => ({ cancel: live.hasOwner(ctx) }));
  pi.on('session_shutdown', async () => { await live.shutdown(); });
  pi.on('session_start', async (event, ctx) => {
    live.gc();
    if (event.reason === 'resume') {
      const unfinished = RunControlWal.list().filter((runId) => runId.startsWith('fix-'));
      if (unfinished.length) ctx.ui.notify(`发现 ${unfinished.length} 个可恢复的 Fix 运行；请确认后使用 Pi /resume`, 'warning');
      await resumeFromSession(pi, ctx, host, live);
    }
  });

  if (typeof pi.registerMessageRenderer === 'function') {
    pi.registerMessageRenderer<LiveWorkerMessageDetails>('fix-worker-event', (message) => {
      const details = message.details;
      if (!details) return undefined;
      const projection = live.sidecar(details.runId)?.get(details.ref);
      if (!projection) return { render: () => ['Worker activity unavailable'], invalidate: () => {} };
      const text = projection.eventKind === 'visible_text'
        ? projection.text ?? ''
        : `tool: ${projection.toolName ?? 'unknown'} ${JSON.stringify(projection.args ?? {}).slice(0, 500)}`;
      return { render: (width: number) => new Text(renderWorkerText(text, width), 0, 0).render(width), invalidate: () => {} };
    });
  }

  pi.registerCommand('fix', {
    description: 'Start a Fix workflow: /fix <问题描述>',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const rebind = /^rebind\s+(\S+)$/u.exec(args.trim());
      if (rebind) {
        try {
          const rebound = await live.rebindParent(ctx, rebind[1]!);
          ctx.ui.notify(rebound ? `Fix 运行 ${rebind[1]} 已在当前目录重新绑定` : '已取消重新绑定', rebound ? 'info' : 'warning');
        } catch (error) { ctx.ui.notify(`Fix 重新绑定失败：${error instanceof Error ? error.message : String(error)}`, 'error'); }
        return;
      }
      const store = new PiSessionRunStore(ctx.sessionManager, (type, data) => pi.appendEntry(type, data));
      await handleFixCommand(ctx, args, { store, host, injected: (pi as ExtensionAPI & { fixWorker?: WorkerExecutor }).fixWorker, live });
    },
  });
}

interface LiveWorkerMessageDetails { runId: string; ref: string; nodeId: string; eventKind: 'visible_text' | 'tool_start'; }

/** Use Pi's terminal-width primitives rather than JS string slicing. */
export function renderWorkerText(text: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  return wrapTextWithAnsi(text, safeWidth).map((line) => truncateToWidth(line, safeWidth, '')).join('\n');
}

type SupplementImages = Parameters<WorkflowInteractionPort['submitSupplement']>[0]['images'];
async function workerInteraction(live: LiveFixRunManager, runId: string, expectedNodeExecutionId: string, text: string, images?: SupplementImages) {
  return live.submitSupplement({ runId, expectedNodeExecutionId, text, images });
}
async function workerInteractionModel(live: LiveFixRunManager, worker: NonNullable<ReturnType<LiveFixRunManager['activeFor']>>, modelRef: string) {
  return live.requestModelChange({ runId: worker.runId, expectedNodeExecutionId: worker.nodeExecutionId, modelRef });
}

// 供测试与运行时壳使用的定义导出保留。
export { fixDefinitionV2 } from './definition.ts';