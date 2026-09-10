import { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader, getAgentDir, type ToolDefinition, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { Artifact, NodeDefinition, WorkerExecutor, Capsule } from '@pi/workflow-contracts';
import { ArtifactContractError, validateSubmitArtifact, NODE_ARTIFACT_KINDS, ARTIFACT_JSON_SCHEMAS } from '@pi/workflow-contracts';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ActiveWorkerHandle, ActiveWorkerRegistry, WorkflowInteractionPort, WorkerModel, WorkerSessionLike } from './interaction.ts';
import type { RunControlWal } from './run-control-wal.ts';

type WorkerMessage = { role?: string; stopReason?: string; errorMessage?: string; content?: unknown };
type WorkerEvent = {
  type: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: WorkerMessage;
  messages?: readonly WorkerMessage[];
};
type WorkerSessionRuntime = WorkerSessionLike & { messages?: readonly WorkerMessage[] };

export type WorkerProgress =
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; result: unknown; isError: boolean }
  | { type: 'text'; text: string }
  | { type: 'artifact_fallback'; artifact: Artifact }
  | { type: 'model_end'; stopReason?: string; errorMessage?: string }
  | { type: 'artifact_attempt'; attempt: number; maxAttempts: number; reason: 'initial' | 'missing_artifact' | 'invalid_artifact' | 'transient_error' }
  /** 未知 node.id 无法绑定 per-kind schema（ARTIFACT_JSON_SCHEMAS 无对应 kind）时退回
   *  最小宽松 schema（只声明 kind），结构校验完全交给 execute 内权威层兜底；发本事件
   *  保证该降级在进度流中可见，不会被静默吞掉。 */
  | { type: 'schema_fallback'; nodeId: string }
  | { type: 'model_applied'; model: { provider: string; id: string }; modelCallRef: string };

export class WorkerArtifactSubmissionError extends Error {
  readonly code: string;
  readonly nodeId: string;
  constructor(code: string, nodeId: string, message: string) {
    super(message);
    this.name = 'WorkerArtifactSubmissionError';
    this.code = code;
    this.nodeId = nodeId;
  }
}

// 未知 node.id 的最小宽松 schema：只声明 kind 必填，其余字段交给 execute 内
// validateSubmitArtifact 权威校验兜底；同时发 schema_fallback progress 事件保证可见。
const FALLBACK_ARTIFACT_SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string' } },
  required: ['kind'],
  additionalProperties: true,
} satisfies ToolDefinition['parameters'];

// 每节点唯一 kind 的 JSON Schema 由 contracts 单一定义表派生（ARTIFACT_JSON_SCHEMAS），
// 注入 submit_artifact 工具声明进入口校验（pi convert → validate）；
// validateSubmitArtifact 仍是权威校验（语义/条件必填层）。
function artifactSchemaFor(nodeId: string, onProgress?: (progress: WorkerProgress) => void): ToolDefinition['parameters'] {
  const kind = NODE_ARTIFACT_KINDS[nodeId];
  const schema = kind ? (ARTIFACT_JSON_SCHEMAS as Record<string, Record<string, unknown>>)[kind] : undefined;
  if (schema) return schema;
  onProgress?.({ type: 'schema_fallback', nodeId });
  return FALLBACK_ARTIFACT_SCHEMA;
}

function submissionContract(nodeId: string): string {
  switch (nodeId) {
    case 'investigate':
      return "Call submit_artifact exactly once with {kind:'investigation', route:'local_fix'|'requirement_change'|'design_change'|'needs_more_evidence'|'blocked', evidence:string[], rootCause:string}. rootCause must state the verified cause or explicitly say evidence is insufficient.";
    case 'implement':
      return "Call submit_artifact exactly once with {kind:'implementation', artifact:{summary:string, filesChanged:string[], candidateRevision:string, prUrl?:string}}. candidateRevision is mandatory and must identify the exact revision/diff you changed. Do not claim a commit or PR unless you actually created it.";
    case 'verify':
      return "Call submit_artifact exactly once with {kind:'verification', accepted:boolean, evidence:string[], candidateRevision?:string, failure?:{kind:'implementation'|'configuration'|'external_condition', reason:string, responsibility?:string, resolution?:string}, conclusion:{status:'accepted'|'rejected'|'blocked'|'inconclusive'|'needs_more_evidence', summary:string}}. conclusion is mandatory for v2 workflows when CAPS.requiresArtifactConclusion is true. candidateRevision is mandatory on a repository-change path (CAPS.requiresRepositoryChange is true) and must equal the implementation candidateRevision; on a no-repository-change path it is optional — include the verified baseline/current state version only when it is identifiable (there is no implementation artifact to bind). Evidence must state what was verified. When accepted is false, failure is mandatory: kind 'implementation' means a code/repository change would fix the failure; 'configuration' means the failure is caused by configuration that only the user can change (not a repo change); 'external_condition' means missing permission/environment/external dependency, then include responsibility and resolution for unblocking.";
    case 'intake':
      return "Call submit_artifact exactly once with {kind:'intake', summary:string, overview:string, environment?:string, scope?:string, urgency?:'low'|'medium'|'high'|'critical'}. summary must be a one-sentence user-readable problem summary; overview a 2-3 sentence scene, impact and known context. Do not echo the raw problem text verbatim.";
    case 'investigation_review':
      return "Call submit_artifact exactly once with {kind:'investigation_review', rootCauseConclusion:string, evidenceSufficiency:'sufficient'|'insufficient', gaps:string[], conclusion:{status:'accepted'|'rejected'|'blocked'|'inconclusive'|'needs_more_evidence', summary:string}}. conclusion must summarize the review verdict.";
    case 'change_plan_review':
      return "Call submit_artifact exactly once with {kind:'change_plan_review', rootCauseAlignment:boolean, changedScope:string, risks:string[], compatibility:string[], verification:string[], rollback:string[], findings:{id:string, summary:string, severity?:'info'|'warning'|'blocker', disposition?:'open'|'closed'|'accepted_with_note'}[], conclusion:{status, summary}}. findings must list each review check.";
    case 'change_review':
      return "Call submit_artifact exactly once with {kind:'change_review', reviewedRevision?:string, prRef?:string, findings:{id:string, summary:string, severity?:'info'|'warning'|'blocker', disposition?:'open'|'closed'|'accepted_with_note'}[], findingDisposition:'all_closed'|'open', conclusion:{status, summary}}. findingDisposition must reflect whether all findings are closed.";
    default:
      return 'Call submit_artifact exactly once with the valid structured artifact for this workflow node.';
  }
}

function isTransientModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /connection error|econnreset|econnrefused|etimedout|network error|fetch failed|socket hang up|502|503|504|429/i.test(message);
}

function extractStructuredArtifact(text: string): unknown | undefined {
  const matches = [...text.matchAll(/```fix-artifact\s*\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1) return undefined;
  try {
    return JSON.parse(matches[0][1]);
  } catch {
    return undefined;
  }
}

function workerPrompt(node: NodeDefinition, task: unknown, capsule: Capsule, retryMessage?: string): string {
  const candidateRevisionRequired = capsule.requiresRepositoryChange === true
    ? 'candidateRevision is mandatory and must equal the implementation candidateRevision (the exact revision verified).'
    : 'candidateRevision is optional on this no-repository-change path; include the verified baseline/current state version only when it is identifiable.';
  const retryInstruction = retryMessage
    ? `\n${retryMessage}\nDo not answer with ordinary text. Call submit_artifact now.`
    : '';
  return [
    'You are executing one controlled workflow node.',
    submissionContract(node.id),
    'Do the investigation or implementation using the enabled tools. A text response is not a completion.',
    capsule.requiresArtifactConclusion === true
      ? 'This is a v2 workflow: conclusion.status and conclusion.summary are mandatory and must be your real business conclusion; the Runtime will not invent them.'
      : 'This legacy-compatible workflow may omit conclusion; the Runtime will not invent a missing conclusion.',
    'Before ending, call submit_artifact exactly once with the final structured result, then stop.',
    'If submit_artifact is unavailable, the only accepted text fallback is exactly one fenced block: ```fix-artifact followed by one JSON object satisfying the same contract, then ```.',
    `TASK:\n${String(task)}`,
    `CAPSULE:\n${JSON.stringify(capsule)}`,
    node.id === 'verify' ? candidateRevisionRequired : '',
    retryInstruction,
  ].join('\n');
}

/** 真实 SDK adapter；model/factory 显式注入，避免无模型时误调用 prompt。 */
export class PiSdkWorkerExecutor implements WorkerExecutor {
  private readonly options: {
    workerId?: string;
    model?: unknown;
    thinkingLevel?: unknown;
    skills?: string[];
    cwd?: string;
    createSession?: typeof createAgentSession;
    resourceLoader?: ResourceLoader;
    onProgress?: (progress: WorkerProgress) => void;
    live?: {
      registry: ActiveWorkerRegistry;
      interaction: WorkflowInteractionPort;
      wal: RunControlWal;
      parentSessionId: string;
      parentLeafId: string;
      sidecarDir?: string;
    };
  };

  constructor(options: {
    workerId?: string;
    model?: unknown;
    thinkingLevel?: unknown;
    skills?: string[];
    cwd?: string;
    createSession?: typeof createAgentSession;
    resourceLoader?: ResourceLoader;
    onProgress?: (progress: WorkerProgress) => void;
    live?: {
      registry: ActiveWorkerRegistry;
      interaction: WorkflowInteractionPort;
      wal: RunControlWal;
      parentSessionId: string;
      parentLeafId: string;
      sidecarDir?: string;
    };
  } = {}) {
    this.options = options;
  }

  // WorkerExecutor 接口 getter：execute 内不依赖它，仅暴露可审计的身份。
  get workerId(): string | undefined { return this.options.workerId; }

  async execute(node: NodeDefinition, task: unknown, capsule: Capsule): Promise<Artifact> {
    let captured: Artifact | undefined;
    let rejectedSubmission: ArtifactContractError | undefined;
    let fallbackRejected: ArtifactContractError | undefined;
    const submit: ToolDefinition = {
      name: 'submit_artifact',
      label: 'submit_artifact',
      description: 'Submit the required structured workflow artifact. Ordinary text is not accepted as completion.',
      promptSnippet: 'Submit the final structured workflow artifact. Ordinary text is not completion.',
      promptGuidelines: ['Before completing this workflow node, call submit_artifact exactly once with the required artifact.'],
      parameters: artifactSchemaFor(node.id, this.options.onProgress),
      execute: async (_id, params) => {
        try {
          validateSubmitArtifact(params);
        } catch (error) {
          if (error instanceof ArtifactContractError) rejectedSubmission = error;
          throw error;
        }
        const live = this.options.live;
        const execution = capsule as { runId?: string; nodeExecutionId?: string; workerId?: string };
        if (live && execution.runId === live.wal.runId) {
          captured = await live.interaction.bindArtifact(execution.runId, params) as Artifact;
        } else {
          captured = params;
        }
        return { content: [{ type: 'text', text: 'captured' }], details: {} };
      },
    };

    const requestedSkills = this.options.skills ?? node.profile?.skills ?? [];
    const loader = this.options.resourceLoader ?? new DefaultResourceLoader({
      cwd: this.options.cwd ?? process.cwd(),
      agentDir: getAgentDir(),
      // Worker 只能看到当前 Node 明确允许的 skill，不能继承主 Session 的全部 skill。
      skillsOverride: (base) => {
        const available = new Map(base.skills.map((skill) => [skill.name, skill]));
        const missing = requestedSkills.filter((name) => !available.has(name));
        if (missing.length) throw Error(`unknown node skill: ${missing.join(', ')}`);
        return { ...base, skills: requestedSkills.map((name) => available.get(name)!) };
      },
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await loader.reload();

    const scopedSkills = () => {
      const availableSkills = typeof loader.getSkills === 'function'
        ? loader.getSkills()
        : { skills: [], diagnostics: [] };
      const availableByName = new Map(availableSkills.skills.map((skill) => [skill.name, skill]));
      const missing = requestedSkills.filter((name) => !availableByName.has(name));
      if (missing.length) throw Error(`unknown node skill: ${missing.join(', ')}`);
      return {
        ...availableSkills,
        skills: requestedSkills.map((name) => availableByName.get(name)!),
      };
    };
    scopedSkills();
    // 即使 reload 后 catalogue 变化，session 也只看到当前 Node allowlist 中仍可解析的 skill。
    const scopedLoader = new Proxy(loader, {
      get(target, property) {
        if (property === 'getSkills') return scopedSkills;
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as ResourceLoader;

    const create = this.options.createSession ?? createAgentSession;
    if (!this.options.model && !this.options.createSession) throw Error('model must be explicitly configured');
    const live = this.options.live;
    let sessionManager = SessionManager.inMemory();
    let recoveredSessionFile: string | undefined;
    let durableWorkerSessionId: string | undefined;
    let durableAttemptId: string | undefined;
    if (live) {
      const execution = capsule as { nodeExecutionId: string; workerId: string; recoveryAttempt?: number };
      durableWorkerSessionId = randomUUID();
      durableAttemptId = randomUUID();
      // Establish logical identity and attempt before creating the Child. A
      // crash in createAgentSession therefore restores the same node attempt.
      live.wal.beginWorker({ nodeExecutionId: execution.nodeExecutionId, workerId: execution.workerId, workerSessionId: durableWorkerSessionId, attemptId: durableAttemptId, recoveryAttempt: execution.recoveryAttempt ?? 1, startup: true });
    }
    if (live) {
      const sessionDir = live.sidecarDir ?? join(live.wal.runDir, 'workers');
      mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
      chmodSync(sessionDir, 0o700);
      const execution = capsule as { nodeExecutionId?: string };
      const prior = live.wal.records().reverse().find((record) => record.type === 'worker' && ['session_started', 'session_published'].includes(String(record.payload.kind)) && record.payload.nodeExecutionId === execution.nodeExecutionId && typeof record.payload.sessionFile === 'string');
      if (prior && existsSync(String(prior.payload.sessionFile))) {
        recoveredSessionFile = String(prior.payload.sessionFile);
        sessionManager = SessionManager.open(recoveredSessionFile, sessionDir, this.options.cwd ?? process.cwd());
      } else {
        sessionManager = SessionManager.create(this.options.cwd ?? process.cwd(), sessionDir);
      }
    }
    const { session } = await create({
      tools: node.profile?.tools ?? [],
      customTools: [submit],
      resourceLoader: scopedLoader,
      sessionManager,
      // Child SettingsManager is deliberately in-memory. Passing the parent
      // manager here would make setModel mutate the user's global default.
      settingsManager: SettingsManager.inMemory(),
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.thinkingLevel !== undefined ? { thinkingLevel: this.options.thinkingLevel } : {}),
    } as unknown as Parameters<typeof createAgentSession>[0]);

    let liveHandle: ActiveWorkerHandle | undefined;
    if (live) {
      const execution = capsule as { runId: string; nodeExecutionId: string; workerId: string; recoveryAttempt?: number };
      const model = (this.options.model ?? (session as WorkerSessionLike).model) as WorkerModel | undefined;
      const workerSessionId = durableWorkerSessionId ?? String((session as WorkerSessionLike).sessionId ?? randomUUID());
      liveHandle = {
        runId: execution.runId,
        parentSessionId: live.parentSessionId,
        parentLeafId: live.parentLeafId,
        nodeExecutionId: execution.nodeExecutionId,
        workerId: execution.workerId,
        workerSessionId,
        attemptId: durableAttemptId ?? randomUUID(),
        recoveryAttempt: execution.recoveryAttempt ?? 1,
        actualModel: { provider: String(model?.provider ?? 'unknown'), id: String(model?.id ?? 'unknown') },
        status: 'starting',
        contextSupplementVersion: live.wal.getSupplementVersion(),
        session,
        wal: live.wal,
      };
      try {
        live.registry.register(liveHandle);
        live.wal.recordWorker({ kind: 'session_published', nodeExecutionId: execution.nodeExecutionId, workerId: execution.workerId, workerSessionId, sessionFile: sessionManager.getSessionFile?.(), piSessionId: (session as WorkerSessionLike).sessionId, ...(recoveredSessionFile ? { recoveredFromSessionFile: recoveredSessionFile } : {}) });
        await live.interaction.reconcileWorker(liveHandle);
      } catch (error) {
        live.registry.unregisterWorker(liveHandle.runId, liveHandle.workerSessionId);
        liveHandle.session.dispose?.();
        throw error;
      }
    }

    let streamedText = '';
    let lastAssistantText = '';
    let modelStopReason: string | undefined;
    let modelErrorMessage: string | undefined;
    let transientError: string | undefined;
    const tryCaptureFallback = async (text: string) => {
      const candidate = extractStructuredArtifact(text);
      if (candidate === undefined) return;
      try {
        validateSubmitArtifact(candidate);
        captured = liveHandle
          ? await live!.interaction.bindArtifact(liveHandle.runId, candidate) as Artifact
          : candidate;
        this.options.onProgress?.({ type: 'artifact_fallback', artifact: captured });
      } catch (error) {
        if (error instanceof ArtifactContractError) fallbackRejected = error;
      }
    };
    const workerSession = session as unknown as WorkerSessionRuntime;
    const textFromContent = (content: unknown): string => Array.isArray(content)
      ? content.filter((item): item is { type: string; text: string } => typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string').map((item) => item.text).join('')
      : '';
    const unsubscribe = workerSession.subscribe?.((rawEvent: unknown) => {
        const event = rawEvent as WorkerEvent;
        if (liveHandle && event.type === 'agent_start') liveHandle.status = 'streaming';
        if (liveHandle && event.type === 'turn_start') {
          const turnIndex = Number((event as WorkerEvent & { turnIndex?: number }).turnIndex ?? 0);
          const modelCallRef = `${liveHandle.workerSessionId}:turn:${turnIndex}`;
          void live!.interaction.recordModelTurnStart(liveHandle.runId, turnIndex, modelCallRef);
          const actual = (session as WorkerSessionLike).model;
          if (actual) {
            liveHandle.actualModel = { provider: String(actual.provider), id: String(actual.id) };
            this.options.onProgress?.({ type: 'model_applied', model: liveHandle.actualModel, modelCallRef });
          }
        }
        if (liveHandle && event.type === 'agent_settled') liveHandle.status = 'idle';
        if (event.type === 'tool_execution_start') {
          this.options.onProgress?.({ type: 'tool_start', name: event.toolName ?? 'unknown', args: event.args ?? {} });
        }
        if (event.type === 'tool_execution_end') {
          this.options.onProgress?.({ type: 'tool_end', name: event.toolName ?? 'unknown', result: event.result ?? '', isError: event.isError === true });
        }
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          streamedText += event.assistantMessageEvent.delta ?? '';
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          modelStopReason = event.message.stopReason;
          modelErrorMessage = event.message.errorMessage;
          const text = textFromContent(event.message.content);
          if (text.trim()) {
            lastAssistantText = text;
            this.options.onProgress?.({ type: 'text', text });
          }
        }
        if (liveHandle && event.type === 'turn_end') {
          const turnIndex = Number((event as WorkerEvent & { turnIndex?: number }).turnIndex ?? 0);
          void live!.interaction.recordModelCallCompleted(liveHandle.runId, `${liveHandle.workerSessionId}:turn:${turnIndex}`);
        }
        if (event.type === 'agent_end') {
          const assistant = Array.isArray(event.messages)
            ? [...event.messages].reverse().find((message) => message.role === 'assistant')
            : undefined;
          if (assistant) {
            modelStopReason = assistant.stopReason;
            modelErrorMessage = assistant.errorMessage;
            this.options.onProgress?.({ type: 'model_end', stopReason: modelStopReason, errorMessage: modelErrorMessage });
          }
        }
      });
    try {
      const maxArtifactAttempts = 2;
      const lastAssistantResponse = () => {
        const messages = workerSession.messages;
        const lastAssistant = Array.isArray(messages)
          ? [...messages].reverse().find((message) => message.role === 'assistant')
          : undefined;
        return textFromContent(lastAssistant?.content);
      };
      for (let attempt = 1; attempt <= maxArtifactAttempts && !captured; attempt += 1) {
        const rejection = rejectedSubmission ?? fallbackRejected;
        const reason = attempt === 1
          ? 'initial'
          : transientError
            ? 'transient_error'
            : rejection
              ? 'invalid_artifact'
              : 'missing_artifact';
        this.options.onProgress?.({ type: 'artifact_attempt', attempt, maxAttempts: maxArtifactAttempts, reason });
        const retryMessage = attempt === 1
          ? undefined
          : rejection
            ? `Your submitted artifact was rejected: ${rejection.code}: ${rejection.message}. Submit a corrected artifact that satisfies the contract.`
            : 'Your previous response did not call submit_artifact or provide the exact fix-artifact JSON fallback.';
        try {
          await session.prompt(workerPrompt(node, task, capsule, transientError
            ? `The previous model request failed transiently (${transientError}). Retry the same task now and submit the required artifact.`
            : retryMessage));
          transientError = undefined;
        } catch (error) {
          if (isTransientModelError(error)) {
            transientError = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 800);
            continue;
          }
          if (!rejectedSubmission) throw error;
        }
        if (!captured) await tryCaptureFallback(lastAssistantText || lastAssistantResponse() || streamedText);
      }
      if (!captured) {
        const rejection = rejectedSubmission ?? fallbackRejected;
        if (rejection) {
          throw new WorkerArtifactSubmissionError(
            rejection.code,
            node.id,
            `${node.id} submitted an invalid artifact: ${rejection.message}`,
          );
        }
        const response = [lastAssistantText, lastAssistantResponse(), streamedText].join('').trim().slice(-1200);
        const outcome = transientError
          ? { code: 'MODEL_RESPONSE_ERROR', detail: `; model: ${transientError}` }
          : modelStopReason === 'error' || modelStopReason === 'aborted'
            ? { code: 'MODEL_RESPONSE_ERROR', detail: modelErrorMessage ? `; model: ${modelErrorMessage}` : '' }
          : modelStopReason === 'length'
            ? { code: 'MODEL_RESPONSE_TRUNCATED', detail: '; model response reached its output limit' }
            : { code: 'ARTIFACT_NOT_SUBMITTED', detail: '' };
        throw new WorkerArtifactSubmissionError(
          outcome.code,
          node.id,
          `${node.id} did not produce a valid artifact after two attempts${outcome.detail}${response ? `; last worker response: ${response}` : ''}`,
        );
      }
      return captured;
    } finally {
      unsubscribe?.();
      if (liveHandle) {
        liveHandle.status = captured ? 'settled' : 'failed';
        try {
          live!.wal.recordWorker({ kind: 'session_settled', nodeExecutionId: liveHandle.nodeExecutionId, workerId: liveHandle.workerId, workerSessionId: liveHandle.workerSessionId, status: liveHandle.status });
        } finally {
          try {
            await live!.interaction.closeWorker(liveHandle.runId, liveHandle.status);
          } finally {
            liveHandle.session.dispose?.();
          }
        }
      }
    }
  }
}
