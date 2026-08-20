import { createAgentSession, SessionManager, DefaultResourceLoader, getAgentDir, type ToolDefinition, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { Artifact, NodeDefinition, WorkerExecutor, Capsule } from '@pi/workflow-contracts';
import { ArtifactContractError, validateSubmitArtifact } from '@pi/workflow-contracts';

export type WorkerProgress =
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; result: unknown; isError: boolean }
  | { type: 'text'; text: string }
  | { type: 'artifact_fallback'; artifact: Artifact }
  | { type: 'model_end'; stopReason?: string; errorMessage?: string }
  | { type: 'artifact_attempt'; attempt: number; maxAttempts: number; reason: 'initial' | 'missing_artifact' | 'invalid_artifact' | 'transient_error' };

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

// Keep the schema dependency-free: Pi validates this JSON Schema-shaped object at
// the SDK boundary, while validateSubmitArtifact remains the Runtime authority.
const artifactSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['investigation', 'implementation', 'verification'] },
    route: { type: 'string', enum: ['local_fix', 'requirement_change', 'design_change', 'needs_more_evidence', 'blocked'] },
    rootCause: { type: 'string' },
    accepted: { type: 'boolean' },
    evidence: { type: 'array', items: { type: 'string' } },
    artifact: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        filesChanged: { type: 'array', items: { type: 'string' } },
        candidateRevision: { type: 'string' },
        prUrl: { type: 'string' },
      },
    },
    candidateRevision: { type: 'string' },
    prUrl: { type: 'string' },
  },
  required: ['kind'],
  additionalProperties: true,
} as any;

function submissionContract(nodeId: string): string {
  switch (nodeId) {
    case 'investigate':
      return "Call submit_artifact exactly once with {kind:'investigation', route:'local_fix'|'requirement_change'|'design_change'|'needs_more_evidence'|'blocked', evidence:string[], rootCause:string}. rootCause must state the verified cause or explicitly say evidence is insufficient.";
    case 'implement':
      return "Call submit_artifact exactly once with {kind:'implementation', artifact:{summary:string, filesChanged:string[], candidateRevision:string, prUrl?:string}}. candidateRevision is mandatory and must identify the exact revision/diff you changed. Do not claim a commit or PR unless you actually created it.";
    case 'verify':
      return "Call submit_artifact exactly once with {kind:'verification', accepted:boolean, evidence:string[], candidateRevision:string}. candidateRevision is mandatory and must identify the exact revision verified. Evidence must state what was verified.";
    default:
      return 'Call submit_artifact exactly once with the valid structured artifact for this workflow node.';
  }
}

function isTransientModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /connection error|econnreset|econnrefused|etimedout|network error|fetch failed|socket hang up|502|503|504|429/i.test(message);
}

function extractStructuredArtifact(text: string): unknown | undefined {
  const matches = [...text.matchAll(/```bugfix-artifact\s*\n([\s\S]*?)\n```/g)];
  if (matches.length !== 1) return undefined;
  try {
    return JSON.parse(matches[0][1]);
  } catch {
    return undefined;
  }
}

function workerPrompt(node: NodeDefinition, task: unknown, capsule: Capsule, retryMessage?: string): string {
  const retryInstruction = retryMessage
    ? `\n${retryMessage}\nDo not answer with ordinary text. Call submit_artifact now.`
    : '';
  return [
    'You are executing one controlled workflow node.',
    submissionContract(node.id),
    'Do the investigation or implementation using the enabled tools. A text response is not a completion.',
    'Before ending, call submit_artifact exactly once with the final structured result, then stop.',
    'If submit_artifact is unavailable, the only accepted text fallback is exactly one fenced block: ```bugfix-artifact followed by one JSON object satisfying the same contract, then ```.',
    `TASK:\n${String(task)}`,
    `CAPSULE:\n${JSON.stringify(capsule)}`,
    retryInstruction,
  ].join('\n');
}

/** 真实 SDK adapter；model/factory 显式注入，避免无模型时误调用 prompt。 */
export class PiSdkWorkerExecutor implements WorkerExecutor {
  private readonly options: {
    model?: unknown;
    thinkingLevel?: unknown;
    skills?: string[];
    cwd?: string;
    createSession?: typeof createAgentSession;
    resourceLoader?: ResourceLoader;
    onProgress?: (progress: WorkerProgress) => void;
  };

  constructor(options: {
    model?: unknown;
    thinkingLevel?: unknown;
    skills?: string[];
    cwd?: string;
    createSession?: typeof createAgentSession;
    resourceLoader?: ResourceLoader;
    onProgress?: (progress: WorkerProgress) => void;
  } = {}) {
    this.options = options;
  }

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
      parameters: artifactSchema,
      execute: async (_id, params) => {
        try {
          validateSubmitArtifact(params);
        } catch (error) {
          if (error instanceof ArtifactContractError) rejectedSubmission = error;
          throw error;
        }
        captured = params;
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
    const { session } = await create({
      tools: node.profile?.tools ?? [],
      customTools: [submit],
      resourceLoader: scopedLoader,
      sessionManager: SessionManager.inMemory(),
      ...(this.options.model ? { model: this.options.model as any } : {}),
      ...(this.options.thinkingLevel !== undefined ? { thinkingLevel: this.options.thinkingLevel } : {}),
    } as any);

    let streamedText = '';
    let lastAssistantText = '';
    let modelStopReason: string | undefined;
    let modelErrorMessage: string | undefined;
    let transientError: string | undefined;
    const tryCaptureFallback = (text: string) => {
      const candidate = extractStructuredArtifact(text);
      if (candidate === undefined) return;
      try {
        validateSubmitArtifact(candidate);
        captured = candidate;
        this.options.onProgress?.({ type: 'artifact_fallback', artifact: captured });
      } catch (error) {
        if (error instanceof ArtifactContractError) fallbackRejected = error;
      }
    };
    const unsubscribe = typeof (session as any).subscribe === 'function'
      ? (session as any).subscribe((event: any) => {
        if (event.type === 'tool_execution_start') {
          this.options.onProgress?.({ type: 'tool_start', name: event.toolName, args: event.args });
        }
        if (event.type === 'tool_execution_end') {
          this.options.onProgress?.({ type: 'tool_end', name: event.toolName, result: event.result, isError: event.isError });
        }
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          streamedText += event.assistantMessageEvent.delta;
        }
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          modelStopReason = event.message.stopReason;
          modelErrorMessage = event.message.errorMessage;
          const text = Array.isArray(event.message.content)
            ? event.message.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('')
            : '';
          if (text.trim()) {
            lastAssistantText = text;
            this.options.onProgress?.({ type: 'text', text });
          }
        }
        if (event.type === 'agent_end') {
          const assistant = Array.isArray(event.messages)
            ? [...event.messages].reverse().find((message: any) => message.role === 'assistant')
            : undefined;
          if (assistant) {
            modelStopReason = assistant.stopReason;
            modelErrorMessage = assistant.errorMessage;
            this.options.onProgress?.({ type: 'model_end', stopReason: modelStopReason, errorMessage: modelErrorMessage });
          }
        }
      })
      : undefined;
    try {
      const maxArtifactAttempts = 2;
      const lastAssistantResponse = () => {
        const messages = (session as any).messages;
        const lastAssistant = Array.isArray(messages)
          ? [...messages].reverse().find((message: any) => message.role === 'assistant')
          : undefined;
        return Array.isArray(lastAssistant?.content)
          ? lastAssistant.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('')
          : '';
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
            : 'Your previous response did not call submit_artifact or provide the exact bugfix-artifact JSON fallback.';
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
        if (!captured) tryCaptureFallback(lastAssistantText || lastAssistantResponse() || streamedText);
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
    }
  }
}
