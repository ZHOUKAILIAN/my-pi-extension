// legacy fixture：迁移自 workflow-runtime/src/index.ts 的旧 fixDefinition 导出。
// 仅用于 runtime 机制测试（run/restore/decide/user decision gate/verification retry），
// 不代表当前 fix 产品流程；当前产品流程使用 packages/fix 的 fixDefinitionV2。
import type { Artifact, Stage, WorkflowDefinition } from '../src/index.ts';

export const fixDefinition: WorkflowDefinition = {
  nodes: {},
  id: 'fix',
  initialStage: 'INVESTIGATING',
  guard(from, to, artifact) {
    const allowed: Record<Stage, Stage[]> = {
      INTAKE: [],
      INVESTIGATING: ['INVESTIGATING', 'IMPLEMENTING', 'BLOCKED', 'WAITING_FOR_USER'],
      IMPLEMENTING: ['VERIFYING', 'BLOCKED'],
      VERIFYING: ['ACCEPTED', 'IMPLEMENTING', 'BLOCKED'],
      BLOCKED: ['INVESTIGATING'],
      WAITING_FOR_USER: ['INVESTIGATING'],
      DISPOSITION: [],
      ACCEPTED: [],
    };
    // Guard 是状态机的越权边界：worker 只能提交事实，不能自行指定下一状态。
    if (!allowed[from]?.includes(to)) throw Error(`invalid transition ${from} -> ${to}`);
    if (to === 'IMPLEMENTING' && from === 'INVESTIGATING' && (!artifact || artifact.kind !== 'investigation' || artifact.route !== 'local_fix' || !artifact.evidence.length)) throw Error('invalid evidence');
    if (to === 'IMPLEMENTING' && from === 'VERIFYING' && (!artifact || artifact.kind !== 'verification' || artifact.accepted !== false || !artifact.evidence.length)) throw Error('invalid verification evidence');
    if (to === 'WAITING_FOR_USER' && (!artifact || artifact.kind !== 'investigation' || !['requirement_change', 'design_change'].includes(artifact.route) || !artifact.evidence.length)) throw Error('invalid investigation evidence');
    if (to === 'BLOCKED' && (!artifact || (artifact.kind !== 'investigation' && artifact.kind !== 'guard_rejection'))) throw Error('invalid block evidence');
    if (to === 'INVESTIGATING' && from === 'BLOCKED' && (!artifact || artifact.kind !== 'investigation' || !artifact.evidence.length)) throw Error('invalid investigation evidence');
    if (to === 'ACCEPTED' && (!artifact || artifact.kind !== 'verification' || artifact.accepted !== true || !artifact.evidence.length)) throw Error('invalid acceptance evidence');
  },
  transition(from, to, artifact) {
    this.guard(from, to, artifact);
    return to;
  },
};