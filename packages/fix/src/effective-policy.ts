import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { EffectivePolicy, ExecutionPolicy, NodeExecutionConfig } from '@pi/workflow-contracts';
import type { ModelRef } from './policy.ts';
import {
  FIX_WORKFLOW_ID,
  FIX_WORKFLOW_VERSION,
  FIX_NODE_IDS,
  FIX_NODE_PROFILES,
  FIX_REVIEW_POLICIES,
  FIX_VERIFICATION_REQUIREMENT,
  FIX_ACCEPTANCE,
  type FixNodeId,
} from './definition.ts';

// ============================================================
// Fix 有效策略合并（L2 §3「Policy 默认值与项目配置」）
//
// 职责：把 Runtime Defaults 与可信项目文件（.pi/workflow.json，迁移期回退
// .pi/workflow-models.json）合并为一次 Run 实际使用的 EffectivePolicy，
// 并生成确定性 digest 供 checkpoint 恢复时比对。项目文件只能覆盖每个
// Node 的模型和 Skill，不能改变流程、Stage、Transition、Guard、工具边界
// 或 Acceptance 最低条件。
// ============================================================

// 执行策略：固定 Runtime 默认值，项目文件不可覆盖。
export const FIX_EXECUTION_POLICY: ExecutionPolicy = {
  maxAttemptsPerNode: 2,
  retryTransientModelErrors: true,
  retryContractErrors: true,
  checkpointAfter: ['INTAKE', 'INVESTIGATING', 'DISPOSITION', 'IMPLEMENTING', 'VERIFYING', 'BLOCKED', 'WAITING_FOR_USER'],
  resume: { requireWorkflowVersionMatch: true, requirePolicyDigestMatch: true, requireSchemaVersionCompatibility: true },
};

// 主流程 Transition 简表（L2 §2 阶段图 / §3 默认配置表）；after 为描述性代码。
const FIX_MAIN_TRANSITIONS: { from: string; to: string; after: string }[] = [
  { from: 'INTAKE', to: 'INVESTIGATING', after: 'intake_accepted' },
  { from: 'INVESTIGATING', to: 'INVESTIGATING', after: 'investigation_review_needs_more_evidence' },
  { from: 'INVESTIGATING', to: 'DISPOSITION', after: 'investigation_review_accepted' },
  { from: 'DISPOSITION', to: 'DISPOSITION', after: 'change_plan_review_rejected' },
  { from: 'DISPOSITION', to: 'IMPLEMENTING', after: 'change_plan_review_accepted' },
  { from: 'DISPOSITION', to: 'VERIFYING', after: 'no_repository_change' },
  { from: 'IMPLEMENTING', to: 'IMPLEMENTING', after: 'change_review_needs_changes' },
  { from: 'IMPLEMENTING', to: 'VERIFYING', after: 'change_review_accepted' },
  { from: 'VERIFYING', to: 'WAITING_FOR_USER', after: 'verification_accepted' },
  { from: 'VERIFYING', to: 'IMPLEMENTING', after: 'verification_requires_change' },
  { from: 'WAITING_FOR_USER', to: 'ACCEPTED', after: 'human_approved' },
  { from: 'WAITING_FOR_USER', to: 'IMPLEMENTING', after: 'human_requested_changes' },
  { from: 'WAITING_FOR_USER', to: 'BLOCKED', after: 'human_rejected' },
];

// 单个 Node 的项目覆盖：model 缺省 = undefined，表示沿用 Runtime 默认模型。
export interface ProjectNodeOverride {
  model?: ModelRef;
  skills?: string[];
}

export interface ProjectWorkflowPolicy {
  nodes: Partial<Record<FixNodeId, ProjectNodeOverride>>;
}

// 合法模型引用：'inherit' 或 'provider/id'（规则与 policy.ts validRef 一致）。
function validRef(value: unknown): value is ModelRef {
  return value === 'inherit' || (typeof value === 'string' && /^[^/]+\/[^/]+$/.test(value));
}

// 合法 Skill 列表：非空数组、小写字母数字加连字符、无重复（规则沿用 policy.ts validSkills，
// 额外要求非空数组，显式空数组视为非法覆盖）。
function validSkills(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((skill) => typeof skill === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(skill))
    && new Set(value).size === value.length;
}

// 解析 .pi/workflow.json（严格 schema，失败抛带路径的 Error）。
// 顶层只允许 version?: 1 与 nodes?: object；nodes 的 key 必须是 FIX_NODE_IDS 之一，
// 节点 value 允许 undefined（跳过）或对象，对象只允许 model/skills 两个字段。
export function parseProjectWorkflowPolicy(raw: unknown, path: string): ProjectWorkflowPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`invalid workflow policy schema/version: ${path}`);
  const file = raw as Record<string, unknown>;
  if (Object.keys(file).some((key) => key !== 'version' && key !== 'nodes')) throw Error(`invalid workflow policy schema/version: ${path}`);
  if (file.version !== undefined && file.version !== 1) throw Error(`invalid workflow policy schema/version: ${path}`);
  if (file.nodes !== undefined && (typeof file.nodes !== 'object' || file.nodes === null || Array.isArray(file.nodes))) throw Error(`invalid workflow policy schema/version: ${path}`);

  const rawNodes = (file.nodes ?? {}) as Record<string, unknown>;
  const nodes: ProjectWorkflowPolicy['nodes'] = {};
  for (const key of Object.keys(rawNodes)) {
    if (!(FIX_NODE_IDS as readonly string[]).includes(key)) throw Error(`unknown workflow policy node ${key}: ${path}`);
    const value = rawNodes[key];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`invalid workflow policy node ${key}: ${path}`);
    const node = value as Record<string, unknown>;
    if (Object.keys(node).some((field) => field !== 'model' && field !== 'skills')) throw Error(`invalid workflow policy node ${key}: ${path}`);
    if (node.model !== undefined && !validRef(node.model)) throw Error(`invalid workflow policy node ${key}: ${path}`);
    if (node.skills !== undefined && !validSkills(node.skills)) throw Error(`invalid workflow policy node ${key}: ${path}`);
    const entry: ProjectNodeOverride = {};
    if (node.model !== undefined) entry.model = node.model as ModelRef;
    if (node.skills !== undefined) entry.skills = node.skills as string[];
    nodes[key as FixNodeId] = entry;
  }
  return { nodes };
}

// 适配迁移期旧配置 .pi/workflow-models.json（loadModelPolicy 的顶层格式）：
// 映射为统一覆盖形态 { nodes: { model?, skills? } }；default 展开为
// investigate/implement/verify 三个 worker 节点的 model 缺省值；只允许这三个 key。
export function parseLegacyWorkflowPolicy(raw: unknown, path: string): ProjectWorkflowPolicy {
  const LEGACY_NODES = ['investigate', 'implement', 'verify'] as const;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error(`invalid workflow policy schema/version: ${path}`);
  const file = raw as Record<string, unknown>;
  if (file.version !== undefined && file.version !== 1) throw Error(`invalid workflow policy schema/version: ${path}`);
  if (file.default !== undefined && !validRef(file.default)) throw Error(`invalid workflow policy schema/version: ${path}`);
  if (file.nodes !== undefined && (typeof file.nodes !== 'object' || file.nodes === null || Array.isArray(file.nodes))) throw Error(`invalid workflow policy schema/version: ${path}`);

  const rawNodes = (file.nodes ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(rawNodes)) {
    if (!(LEGACY_NODES as readonly string[]).includes(key)) throw Error(`unknown workflow policy node ${key}: ${path}`);
  }

  const defaultRef = file.default === undefined ? undefined : (file.default as ModelRef);
  const nodes: ProjectWorkflowPolicy['nodes'] = {};
  for (const nodeId of LEGACY_NODES) {
    const value = rawNodes[nodeId];
    let model: ModelRef | undefined = defaultRef;
    let skills: string[] | undefined;
    if (value !== undefined) {
      if (validRef(value)) {
        model = value;
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const node = value as Record<string, unknown>;
        if (node.model !== undefined && !validRef(node.model)) throw Error(`invalid workflow policy node ${nodeId}: ${path}`);
        if (node.skills !== undefined && !validSkills(node.skills)) throw Error(`invalid workflow policy node ${nodeId}: ${path}`);
        if (Object.keys(node).some((field) => field !== 'model' && field !== 'skills')) throw Error(`invalid workflow policy node ${nodeId}: ${path}`);
        model = node.model !== undefined ? (node.model as ModelRef) : defaultRef;
        skills = node.skills;
      } else {
        throw Error(`invalid workflow policy node ${nodeId}: ${path}`);
      }
    }
    const entry: ProjectNodeOverride = {};
    if (model !== undefined) entry.model = model;
    if (skills !== undefined) entry.skills = skills;
    nodes[nodeId] = entry;
  }
  return { nodes };
}

// 读取并解析 JSON；解析失败抛带路径的错误。
function readJson(path: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    throw Error(`invalid workflow policy JSON: ${path}`);
  }
}

// 每个 Node 合并为 NodeExecutionConfig：model = 项目覆盖 ?? defaultModelRef（必须存在）；
// skills = 项目覆盖 ?? defaultSkills；tools/context 来自 FIX_NODE_PROFILES。
function buildNodeConfigs(overrides: ProjectWorkflowPolicy['nodes']): Record<FixNodeId, NodeExecutionConfig> {
  const configs = {} as Record<FixNodeId, NodeExecutionConfig>;
  for (const nodeId of FIX_NODE_IDS) {
    const profile = FIX_NODE_PROFILES[nodeId];
    const override = overrides[nodeId];
    const config: NodeExecutionConfig = {
      model: override?.model ?? profile.defaultModelRef,
      skills: [...(override?.skills ?? profile.defaultSkills)],
      tools: [...profile.tools],
    };
    if (profile.context) config.context = [...profile.context];
    configs[nodeId] = config;
  }
  return configs;
}

// 用合并覆盖组装完整有效策略（不含 digest）；固定引用各策略常量。
function assemble(overrides: ProjectWorkflowPolicy['nodes']): Omit<EffectivePolicy, 'digest'> {
  return {
    workflow: {
      id: FIX_WORKFLOW_ID,
      definitionVersion: FIX_WORKFLOW_VERSION,
      initialStage: 'INTAKE',
      transitions: [...FIX_MAIN_TRANSITIONS],
    },
    nodes: buildNodeConfigs(overrides),
    review: FIX_REVIEW_POLICIES,
    verification: FIX_VERIFICATION_REQUIREMENT,
    acceptance: FIX_ACCEPTANCE,
    execution: FIX_EXECUTION_POLICY,
  };
}

// 加载本次 Run 实际使用的有效策略。
// untrusted：忽略项目文件，直接用 Runtime 默认（与 loadModelPolicy 对不存在路径的语义一致）。
// trusted：优先 .pi/workflow.json，不存在则回退 .pi/workflow-models.json，都没有则纯默认。
export function loadEffectivePolicy(cwd: string, opts: { trusted: boolean }): EffectivePolicy {
  if (!opts.trusted) {
    const policy = assemble({});
    return { ...policy, digest: computePolicyDigest(policy) };
  }
  const workflowJsonPath = join(cwd, '.pi', 'workflow.json');
  const legacyPath = join(cwd, '.pi', 'workflow-models.json');
  if (fs.existsSync(workflowJsonPath)) {
    const overrides = parseProjectWorkflowPolicy(readJson(workflowJsonPath), workflowJsonPath);
    const policy = assemble(overrides.nodes);
    return { ...policy, digest: computePolicyDigest(policy) };
  }
  if (fs.existsSync(legacyPath)) {
    const overrides = parseLegacyWorkflowPolicy(readJson(legacyPath), legacyPath);
    const policy = assemble(overrides.nodes);
    return { ...policy, digest: computePolicyDigest(policy) };
  }
  const policy = assemble({});
  return { ...policy, digest: computePolicyDigest(policy) };
}

// 规范化 JSON：递归 key 排序、去掉 undefined 值、保留数组顺序；sha256 十六进制输出。
// 必须确定性：相同输入两次调用结果一致。
export function computePolicyDigest(policy: Omit<EffectivePolicy, 'digest'>): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) continue;
        out[key] = canonicalize(item);
      }
      return out;
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(policy))).digest('hex');
}