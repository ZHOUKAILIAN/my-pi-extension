import type {
  AcceptanceDefinition,
  Artifact,
  ArtifactConclusion,
  DispositionArtifact,
  InvestigationArtifact,
  NodeDefinition,
  ReviewPolicy,
  Stage,
  VerificationRequirement,
  WorkflowDefinition,
  WorkerExecutor,
} from '@pi/workflow-contracts';
import type { ModelRef } from './policy.ts';

// ============================================================
// fix v2 工作流定义（业务 Truth Source）
//
// 本文件承载 Fix Extension 的产品流程语义：阶段、节点、处置分支、回流与验收。
// 依据 docs/01-产品定义/扩展/fix-扩展.md（L1）与
// docs/02-产品实现/fix-runtime-technical-design.md（L2：§1 阶段、§2 节点表与工具表、
// §3 模型建议与审查策略、§5 验证要求、§7 验收清单与最终处置）。
// ============================================================

export const FIX_WORKFLOW_VERSION = 'fix-v2';
export const FIX_WORKFLOW_ID = 'fix';
// v2 工作流的“产生来源”绑定：无外部 source resolver 时，Runtime 以定义声明的 sourceVersion 作为
// 可验证的来源事实（新 run 的 artifact 盖章与 checkpoint 顶层来源都引用它）。受控终局 ACCEPTED 恢复
// 要求 checkpoint 顶层来源等于本声明——unbound 或任意伪造字符串都不是完整 V2 来源事实（与决策记录、
// 验收重算、版本绑定共同构成完整验收证明）。
export const FIX_SOURCE_VERSION = 'fix-source-v1';

// 人工 request-changes / reject 的结构化原因码；Controller 将其确定性映射到回流阶段，
// 不允许 Worker 根据自由文本自行选择 Transition。
export type FixReasonCode =
  | 'root_cause_or_impact'
  | 'fix_incomplete_or_regression'
  | 'requirement_disposition_error'
  | 'missing_external_condition';

// 原因码 → 回流目标 Stage（L1「人工发现错误后的回流」表）。
export const FIX_REASON_TO_STAGE: Record<FixReasonCode, Stage> = {
  root_cause_or_impact: 'INVESTIGATING',
  fix_incomplete_or_regression: 'IMPLEMENTING',
  requirement_disposition_error: 'DISPOSITION',
  missing_external_condition: 'BLOCKED',
};

export function fixReasonToStage(reasonCode?: string): Stage {
  return reasonCode && reasonCode in FIX_REASON_TO_STAGE ? FIX_REASON_TO_STAGE[reasonCode as FixReasonCode] : 'IMPLEMENTING';
}

// v2 全部节点 id：5 个纯 worker 节点 + 3 个独立评审节点。
export const FIX_NODE_IDS = ['intake', 'investigate', 'investigation_review', 'disposition', 'change_plan_review', 'implement', 'change_review', 'verify'] as const;
export type FixNodeId = typeof FIX_NODE_IDS[number];

// 评审契约：被评审节点 → 对应评审节点及评审 Artifact kind。
// 评审节点不是纯 worker 节点：由上层在 prepare 时按每个评审者独立 workerId 构造，
// 不通过时由 Controller 按固定回退边恢复，不由 Worker 自行选择下一步。
export const FIX_SPECIAL_NODES: Record<string, { nodeId: FixNodeId; reviewArtifactKind: Artifact['kind'] }> = {
  investigate: { nodeId: 'investigation_review', reviewArtifactKind: 'investigation_review' },
  disposition: { nodeId: 'change_plan_review', reviewArtifactKind: 'change_plan_review' },
  implement: { nodeId: 'change_review', reviewArtifactKind: 'change_review' },
};

// 节点轮廓：默认工具、默认模型引用、默认 Skill 与注入上下文。
// defaultModelRef 是节点默认模型引用；modelRecommendation 仅为设计文档的非绑定建议说明，
// 最终生效模型由策略合并决定（.pi/workflow.json 可覆盖，但不能改变流程与 Guard）。
export interface NodeProfile {
  tools: string[];
  defaultModelRef: ModelRef;
  defaultSkills: string[];
  context?: string[];
  modelRecommendation?: string;
}

// 工具表与模型建议表：默认工具按合同工具名声明；review 节点只读 + 提交 Artifact。
export const FIX_NODE_PROFILES: Record<FixNodeId, NodeProfile> = {
  intake: {
    tools: ['read', 'submit_artifact'],
    defaultModelRef: 'inherit',
    defaultSkills: [],
  },
  investigate: {
    tools: ['read', 'submit_artifact'],
    defaultModelRef: 'smartingredients/gpt-5.6-sol',
    defaultSkills: [],
    context: ['problem', 'intake', 'project_knowledge'],
    modelRecommendation: '设计建议调查/验证使用高推理模型（gpt-5.6-sol）；非绑定说明，仅记录设计意图',
  },
  investigation_review: {
    tools: ['read', 'submit_artifact'],
    defaultModelRef: 'inherit',
    defaultSkills: [],
    context: ['problem', 'intake', 'investigation'],
  },
  disposition: {
    tools: ['read', 'submit_artifact'],
    defaultModelRef: 'inherit',
    defaultSkills: [],
    context: ['investigation', 'investigation_review', 'project_knowledge'],
  },
  change_plan_review: {
    tools: ['read', 'submit_artifact'],
    defaultModelRef: 'inherit',
    defaultSkills: [],
  },
  implement: {
    tools: ['read', 'edit', 'write', 'submit_artifact'],
    defaultModelRef: 'smartingredients/gpt-5.6-terra',
    defaultSkills: ['tdd'],
    context: ['problem', 'investigation', 'investigation_review', 'disposition', 'accepted_plan'],
    modelRecommendation: '设计建议实现使用工具型模型（gpt-5.6-terra）；非绑定说明，仅记录设计意图',
  },
  change_review: {
    tools: ['read', 'submit_artifact'],
    defaultModelRef: 'inherit',
    defaultSkills: [],
  },
  verify: {
    tools: ['read', 'submit_artifact'],
    defaultModelRef: 'smartingredients/gpt-5.6-sol',
    defaultSkills: [],
    context: ['problem', 'investigation', 'disposition', 'implementation', 'change_review'],
    modelRecommendation: '设计建议调查/验证使用高推理模型（gpt-5.6-sol）；非绑定说明，仅记录设计意图',
  },
};

// 三类评审策略（设计 §3 评审配置 / §5 审查策略）：并行评审、quorum、
// 独立 Worker 身份约束与排除节点；requiredApprovals 不可低于设计默认值。
export const FIX_REVIEW_POLICIES: Record<string, ReviewPolicy> = {
  investigation_review: {
    reviewers: [{ model: 'inherit', skills: [] }],
    mode: 'parallel',
    requiredApprovals: 1,
    requireIndependentWorker: true,
    excludeNodes: ['investigate'],
    onRejected: 'return_to_investigation',
  },
  change_plan_review: {
    reviewers: [
      { model: 'inherit', skills: [] },
      { model: 'inherit', skills: [] },
    ],
    mode: 'parallel',
    requiredApprovals: 2,
    requireIndependentWorker: true,
    excludeNodes: ['investigate', 'implement'],
    requiredChecks: ['root_cause_alignment', 'minimal_scope', 'risk_and_compatibility', 'verification_plan', 'rollback_plan'],
    onRejected: 'return_to_disposition',
  },
  change_review: {
    reviewers: [{ model: 'inherit', skills: [] }],
    mode: 'parallel',
    requiredApprovals: 1,
    requireIndependentWorker: true,
    excludeNodes: ['implement'],
    onRejected: 'return_to_implementation',
  },
};

// 验证要求（设计 §6）：四类必检、工具/测试证据、候选版本绑定、未验证项与剩余风险。
export const FIX_VERIFICATION_REQUIREMENT: VerificationRequirement = {
  requiredChecks: ['original_issue', 'root_cause_cut', 'identified_impact_surface', 'regression_and_compatibility'],
  requireToolOrTestEvidence: true,
  requireCandidateRevisionMatch: true,
  allowUnverified: false,
  requireRemainingRisk: true,
  onRejected: 'return_to_implementation',
};

// 验收清单（设计 §7）：进入 ACCEPTED 前必须通过的整体条件；产生仓库候选变更时才
// 强制 change_plan_review / implementation / change_review 条件组。
// investigation_accepted：调查自身必须构成可接受事实（conclusion accepted + route 可行动），
// 与配对 investigation_review 共同保证“调查通过的证据链”后才允许进入处置。
export const FIX_ACCEPTANCE: AcceptanceDefinition = {
  humanFinalApproval: true,
  verification: FIX_VERIFICATION_REQUIREMENT,
  requires: [
    'intake_accepted',
    'investigation_accepted',
    'investigation_review_accepted',
    'disposition_accepted',
    'verification_accepted',
    'candidate_revision_consistent',
    'human_final_approval',
  ],
  repositoryChangeRequires: ['change_plan_review_accepted', 'implementation_accepted', 'change_review_accepted'],
};

// Guard 失败统一抛带原因码的错误，便于调用方与测试断言。
const failTransition = (from: Stage, to: Stage, code: string): never => {
  throw new Error(`INVALID_TRANSITION ${from}->${to}: ${code}`);
};

// 按 kind 收窄 Artifact 联合类型；不匹配时走 fail 回调抛 INVALID_TRANSITION。
const requireArtifactKind = <K extends Artifact['kind']>(
  artifact: Artifact | undefined,
  kind: K,
  fail: () => never,
): Extract<Artifact, { kind: K }> => {
  if (artifact?.kind !== kind) fail();
  return artifact as Extract<Artifact, { kind: K }>;
};

// D3/D5 防御纵深共享判定：处置声明需要用户决定（wait_decision）或外部动作完成（external_action）时
// 必须先停 WAITING_FOR_USER（DISPOSITION_WAITING_REQUIRED），不得直进 IMPLEMENTING/VERIFYING。
const isDispositionWait = (disposition: DispositionArtifact): boolean =>
  disposition.dispositionType === 'wait_decision' || disposition.dispositionType === 'external_action';

// 声明需要正式方案评审的处置不得静默进实现/验证（FORMAL_PLAN_REVIEW_REQUIRED；B5：先 BLOCKED，
// Core 正式方案采纳流程未实现）。与 extension-v2 DISPOSITION 分支的保守策略同源。
const requiresFormalPlanReview = (disposition: DispositionArtifact): boolean =>
  disposition.requiresFormalPlanReview === true;

// fix v2 工作流定义：边守卫按 §1 阶段图与 §5 Transition Guard 目标实现。
// 不列出（含 ACCEPTED 任何转出、BLOCKED 之外的未知边）一律拒绝。
export const fixDefinitionV2: WorkflowDefinition = {
  id: FIX_WORKFLOW_ID,
  version: FIX_WORKFLOW_VERSION,
  sourceVersion: FIX_SOURCE_VERSION,
  initialStage: 'INTAKE',
  requiresArtifactConclusion: true,
  // 终局能力显式声明：人工最终验收由 Runtime decide() 控制（受控终局）。
  decision: 'user',
  acceptance: FIX_ACCEPTANCE,
  guard(from, to, artifact) {
    switch (`${from}->${to}`) {
      case 'INTAKE->INVESTIGATING':
        requireArtifactKind(artifact, 'intake', () => failTransition(from, to, 'MISSING_INTAKE'));
        break;
      case 'INVESTIGATING->INVESTIGATING': {
        const review = requireArtifactKind(artifact, 'investigation_review', () => failTransition(from, to, 'EVIDENCE_INSUFFICIENT'));
        if (review.conclusion.status !== 'rejected') failTransition(from, to, 'EVIDENCE_INSUFFICIENT');
        break;
      }
      case 'INVESTIGATING->DISPOSITION': {
        // 离开 INVESTIGATING 进入处置前，调查自身必须是可接受事实：conclusion accept 且
        // route 是可行动的处置路线。调查被拒（rejected/blocked）或证据不足（needs_more_evidence）
        // 必须回流调查或阻塞，不得以“被拒调查 + 通过的评审”进入处置。
        const investigation = requireArtifactKind(artifact, 'investigation', () => failTransition(from, to, 'MISSING_INVESTIGATION')) as InvestigationArtifact & { conclusion?: ArtifactConclusion };
        if (investigation.conclusion?.status !== 'accepted') failTransition(from, to, 'INVESTIGATION_NOT_ACCEPTED');
        if (!['local_fix', 'requirement_change', 'design_change'].includes(investigation.route)) failTransition(from, to, 'INVESTIGATION_ROUTE_NOT_ACTIONABLE');
        break;
      }
      case 'INVESTIGATING->BLOCKED':
        requireArtifactKind(artifact, 'guard_rejection', () => failTransition(from, to, 'MISSING_BLOCKER'));
        break;
      case 'DISPOSITION->DISPOSITION': {
        const review = requireArtifactKind(artifact, 'change_plan_review', () => failTransition(from, to, 'PLAN_REVIEW_NOT_REJECTED'));
        if (review.conclusion.status !== 'rejected') failTransition(from, to, 'PLAN_REVIEW_NOT_REJECTED');
        break;
      }
      case 'DISPOSITION->IMPLEMENTING': {
        const disposition = requireArtifactKind(artifact, 'disposition', () => failTransition(from, to, 'REPOSITORY_CHANGE_NOT_DECLARED'));
        if (disposition.requiresRepositoryChange !== true) failTransition(from, to, 'REPOSITORY_CHANGE_NOT_DECLARED');
        // D3/D5 防御纵深：需用户决定或外部动作的处置不得直进 IMPLEMENTING（必须先停
        // WAITING_FOR_USER）；声明需要正式方案评审的处置必须先走 Core 正式方案采纳流程（未实现时
        // 一律 BLOCKED，见 extension-v2 DISPOSITION 分支），不得静默进实现。
        if (isDispositionWait(disposition)) failTransition(from, to, 'DISPOSITION_WAITING_REQUIRED');
        if (requiresFormalPlanReview(disposition)) failTransition(from, to, 'FORMAL_PLAN_REVIEW_REQUIRED');
        break;
      }
      case 'DISPOSITION->VERIFYING': {
        const disposition = requireArtifactKind(artifact, 'disposition', () => failTransition(from, to, 'REPOSITORY_CHANGE_STATE_MISMATCH'));
        if (disposition.requiresRepositoryChange !== false) failTransition(from, to, 'REPOSITORY_CHANGE_STATE_MISMATCH');
        // D3/D5 防御纵深（同上）：wait_decision / external_action 处置必须先停 WAITING_FOR_USER
        //（无用户决定/外部完成证据不得进 VERIFYING）；requiresFormalPlanReview 处置不得静默进验证。
        if (isDispositionWait(disposition)) failTransition(from, to, 'DISPOSITION_WAITING_REQUIRED');
        if (requiresFormalPlanReview(disposition)) failTransition(from, to, 'FORMAL_PLAN_REVIEW_REQUIRED');
        break;
      }
      case 'DISPOSITION->WAITING_FOR_USER': {
        // D3：处置需要用户决定（wait_decision）或外部动作完成（external_action）时，先进入
        // WAITING_FOR_USER 等待（pendingDecisionKind = disposition_decision / external_action_completion）；
        // 声明需要正式方案评审的处置不得走该等待边（B5：先 BLOCKED，正式方案流程未实现）。
        const disposition = requireArtifactKind(artifact, 'disposition', () => failTransition(from, to, 'NOT_DISPOSITION_WAITING'));
        if (!isDispositionWait(disposition)) failTransition(from, to, 'NOT_DISPOSITION_WAITING');
        if (requiresFormalPlanReview(disposition)) failTransition(from, to, 'FORMAL_PLAN_REVIEW_REQUIRED');
        break;
      }
      case 'DISPOSITION->BLOCKED':
        requireArtifactKind(artifact, 'guard_rejection', () => failTransition(from, to, 'MISSING_BLOCKER'));
        break;
      case 'IMPLEMENTING->IMPLEMENTING': {
        const review = requireArtifactKind(artifact, 'change_review', () => failTransition(from, to, 'CHANGE_REVIEW_NOT_REJECTED'));
        if (review.conclusion.status !== 'rejected' && review.findingDisposition !== 'open') failTransition(from, to, 'CHANGE_REVIEW_NOT_REJECTED');
        break;
      }
      case 'IMPLEMENTING->VERIFYING':
        requireArtifactKind(artifact, 'implementation', () => failTransition(from, to, 'MISSING_IMPLEMENTATION'));
        break;
      case 'VERIFYING->IMPLEMENTING': {
        const verification = requireArtifactKind(artifact, 'verification', () => failTransition(from, to, 'VERIFICATION_NOT_FAILED'));
        if (verification.accepted !== false) failTransition(from, to, 'VERIFICATION_NOT_FAILED');
        // 只有实现类失败允许回流实现；配置/外部条件类失败不得走 VERIFYING->IMPLEMENTING。
        if (verification.failure?.kind !== 'implementation') failTransition(from, to, 'VERIFICATION_FAILURE_NOT_IMPLEMENTATION');
        break;
      }
      case 'VERIFYING->WAITING_FOR_USER': {
        const verification = requireArtifactKind(artifact, 'verification', () => failTransition(from, to, 'VERIFICATION_NOT_ACCEPTED'));
        // 验收通过，或配置类失败（需用户修改配置）都进入 WAITING_FOR_USER；
        // 其余失败类别（实现/外部条件）不允许走该边。
        if (verification.accepted !== true && verification.failure?.kind !== 'configuration') failTransition(from, to, 'VERIFICATION_NOT_ACCEPTED');
        break;
      }
      case 'VERIFYING->BLOCKED':
        requireArtifactKind(artifact, 'guard_rejection', () => failTransition(from, to, 'MISSING_BLOCKER'));
        break;
      case 'WAITING_FOR_USER->ACCEPTED': {
        // ACCEPTED 只能由 WorkflowRuntime.decide() 的受控 approve 路径进入；
        // Definition 的公开 transition/guard 不接受任何直接跳转。
        failTransition(from, to, 'ACCEPTED_IS_CONTROLLER_ONLY');
      }
      case 'WAITING_FOR_USER->INVESTIGATING': {
        const decision = requireArtifactKind(artifact, 'user_decision', () => failTransition(from, to, 'REASON_NOT_ROOT_CAUSE_OR_IMPACT'));
        if (decision.decision !== 'request_changes' || decision.reasonCode !== 'root_cause_or_impact') failTransition(from, to, 'REASON_NOT_ROOT_CAUSE_OR_IMPACT');
        break;
      }
      case 'WAITING_FOR_USER->IMPLEMENTING': {
        const decision = requireArtifactKind(artifact, 'user_decision', () => failTransition(from, to, 'REASON_NOT_FIX_INCOMPLETE'));
        if (decision.decision !== 'request_changes' || decision.reasonCode !== 'fix_incomplete_or_regression') failTransition(from, to, 'REASON_NOT_FIX_INCOMPLETE');
        break;
      }
      case 'WAITING_FOR_USER->DISPOSITION': {
        const decision = requireArtifactKind(artifact, 'user_decision', () => failTransition(from, to, 'REASON_NOT_DISPOSITION_ERROR'));
        // 两种合法出口：打回（需求/处置方式错误）→ DISPOSITION 重做处置；
        // continue_disposition（用户已给出处置决定 / 外部动作已完成）→ DISPOSITION 落地新处置。
        if (decision.decision !== 'continue_disposition'
          && (decision.decision !== 'request_changes' || decision.reasonCode !== 'requirement_disposition_error')) {
          failTransition(from, to, 'REASON_NOT_DISPOSITION_ERROR');
        }
        break;
      }
      case 'WAITING_FOR_USER->VERIFYING': {
        const decision = requireArtifactKind(artifact, 'user_decision', () => failTransition(from, to, 'NOT_CONTINUE_VERIFICATION'));
        // 配置类验证失败后的继续验证动作（只能回 VERIFYING），或外部动作完成等待的继续
        //（外部动作已补完成证据，回 VERIFYING 按处置验证目标验证既有现场）。
        if (decision.decision !== 'continue_verification' && decision.decision !== 'continue_disposition') failTransition(from, to, 'NOT_CONTINUE_VERIFICATION');
        break;
      }
      case 'WAITING_FOR_USER->BLOCKED': {
        const decision = requireArtifactKind(artifact, 'user_decision', () => failTransition(from, to, 'NOT_REJECTED_OR_EXTERNAL_CONDITION'));
        if (!(decision.decision === 'reject' || (decision.decision === 'request_changes' && decision.reasonCode === 'missing_external_condition'))) failTransition(from, to, 'NOT_REJECTED_OR_EXTERNAL_CONDITION');
        break;
      }
      case 'BLOCKED->INVESTIGATING':
        requireArtifactKind(artifact, 'investigation', () => failTransition(from, to, 'MISSING_INVESTIGATION'));
        break;
      case 'BLOCKED->DISPOSITION':
        requireArtifactKind(artifact, 'disposition', () => failTransition(from, to, 'MISSING_DISPOSITION'));
        break;
      case 'BLOCKED->IMPLEMENTING':
        requireArtifactKind(artifact, 'implementation', () => failTransition(from, to, 'MISSING_IMPLEMENTATION'));
        break;
      case 'BLOCKED->VERIFYING':
        requireArtifactKind(artifact, 'verification', () => failTransition(from, to, 'MISSING_VERIFICATION'));
        break;
      default:
        failTransition(from, to, 'EDGE_NOT_ALLOWED');
    }
  },
  transition(from, to, artifact) {
    this.guard(from, to, artifact);
    return to;
  },
};

// 5 个纯 worker 节点 id（评审节点由 makeReviewerNode 独立构造）。
export type FixWorkerNodeId = 'intake' | 'investigate' | 'disposition' | 'implement' | 'verify';
export const FIX_WORKER_NODE_IDS: FixWorkerNodeId[] = ['intake', 'investigate', 'disposition', 'implement', 'verify'];

// 按节点轮廓生成单个节点定义（工具与 Skill 默认值来自 FIX_NODE_PROFILES）。
const workerNode = (nodeId: FixNodeId, executor?: WorkerExecutor): NodeDefinition => {
  const profile = FIX_NODE_PROFILES[nodeId];
  return {
    id: nodeId,
    worker: executor,
    profile: {
      tools: [...profile.tools],
      skills: [...profile.defaultSkills],
      ...(profile.context ? { context: [...profile.context] } : {}),
    },
  };
};

export function buildFixV2Nodes(workers: Partial<Record<FixWorkerNodeId, WorkerExecutor>>): Record<FixWorkerNodeId, NodeDefinition> {
  return Object.fromEntries(FIX_WORKER_NODE_IDS.map((nodeId) => [nodeId, workerNode(nodeId, workers[nodeId])])) as Record<FixWorkerNodeId, NodeDefinition>;
}

// 评审节点：executor 由上层按每个评审者独立 workerId 构造，profile 复用节点轮廓的工具/Skill。
export function makeReviewerNode(reviewNodeId: FixNodeId, executor: WorkerExecutor): NodeDefinition {
  return workerNode(reviewNodeId, executor);
}