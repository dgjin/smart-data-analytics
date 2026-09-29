/**
 * v0.9.85 首启初始化向导（前端）：跨组件共享类型与常量。
 * 契约对齐 server/setupWizard.ts 与 openapi.json Setup 分组（/api/setup/*）。
 */

export type WizardStatus = 'pending' | 'in_progress' | 'completed';

/** L3 卡片「继续配置」唤起 L1 覆盖层（SetupStatusCard → SetupWizardHost，window 事件解耦） */
export const SETUP_WIZARD_OPEN_EVENT = 'setup:wizard-open';

/** 向导层状态变化（完成/关闭）→ 通知 L3 卡片刷新（SetupWizardHost → SetupStatusCard） */
export const SETUP_REFRESH_EVENT = 'setup:refresh';

/** readiness 探针单检查项（server/infra/health.ts） */
export interface ReadinessCheck {
  ok: boolean;
  ms: number;
  error?: string;
}

/** GET /api/setup/state 的 env 字段（server/setupWizard.ts collectEnvSummary） */
export interface SetupEnvSummary {
  llm: { engine: string; model: string; label: string };
  embedding: { model: string };
  datasources: { total: number; connected: number; demoLoaded: boolean };
  health: { ok: boolean; status: string; checks: Record<string, ReadinessCheck>; timestamp: string };
}

export interface SetupWizardState {
  status: WizardStatus;
  currentStep: number;
  stepResults: Record<string, unknown>;
  pipelineTaskId: string | null;
  skippedUntil: string | null;
  startedBy: string;
  completedAt: string | null;
  updatedAt: string;
  env?: SetupEnvSummary;
  /** 初始化成果数字（数据源/表/向量切片/样例；Step⑤ 总结卡） */
  summary?: Record<string, number>;
}

/** POST /api/setup/probe 响应 */
export interface ProbeResult {
  ok: boolean;
  engine?: string;
  model?: string;
  label?: string;
  sample?: string;
  dims?: number;
  latencyMs?: number;
  error?: string;
}

export type SubtaskState = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

/** 流水线子任务（GET /api/setup/pipeline/:taskId 的 subtasks[]） */
export interface PipelineSubtask {
  key: string;
  label: string;
  state: SubtaskState;
  counters?: Record<string, number> | null;
  error?: string | null;
  ms?: number | null;
}

export interface PipelineProgress {
  taskId: string;
  status: string;
  progress?: string;
  error?: string | null;
  subtasks: PipelineSubtask[];
  result?: unknown;
}

/** Step④ 待办清单项（GET /api/setup/checklist） */
export interface SetupChecklistItem {
  key: string;
  title: string;
  detail: string;
  status: 'todo' | 'done' | 'warn';
  /** 深链标识：'admin:rules' / 'admin:thresholds' / 'admin:knowledge' / 'admin:examples' / 'setup:step2' */
  link?: string;
}

/** 五个 Step 组件的公共 props（SetupWizard 统一下发） */
export interface SetupStepProps {
  /** 当前向导状态（含 env / summary / 各步快照） */
  state: SetupWizardState;
  /** 重新拉取 GET /api/setup/state（探测后刷新 env 与快照） */
  refreshState: () => Promise<void>;
  /** 完成/跳过本步：交由 SetupWizard 持久化（POST /step）并更新本地状态 */
  onResult: (result: Record<string, unknown>) => Promise<void>;
  /** 通知「下一步」可用性 */
  onReadyChange: (ready: boolean) => void;
}

/** 五步定义（步骤轨与导航共用） */
export const SETUP_STEPS = [
  { key: 'env', title: '环境自检', desc: '数据库 / 模型 / 演示数据' },
  { key: 'model', title: '模型服务', desc: '对话与向量引擎探测' },
  { key: 'init', title: '自动初始化', desc: '数据源接入 + 六步流水线' },
  { key: 'checklist', title: '待办确认', desc: '铁律 / 阈值 / 知识样例' },
  { key: 'finish', title: '完成引导', desc: '就绪判定与首次问数' },
] as const;
