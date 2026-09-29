/**
 * v0.9.85 首启初始化向导纯函数集（可单测）：显示判定 / 断点定位 / 计数格式化 / 就绪判定。
 * 组件只做渲染与副作用，判定逻辑集中在此，便于 node 环境直测。
 */
import { SETUP_STEPS } from './setupTypes';
import type { PipelineProgress, ProbeResult, SetupWizardState } from './setupTypes';

/** skipped_until 是否处于静默期（空值/非法值视为未静默） */
export function isSkipActive(skippedUntil: string | null | undefined, now: number = Date.now()): boolean {
  if (!skippedUntil) return false;
  const t = new Date(skippedUntil).getTime();
  return Number.isFinite(t) && t > now;
}

/** 引导是否处于活跃期（未完成且非静默）：L1 自动弹出与 L2 横幅共用 */
export function isWizardActive(state: SetupWizardState | null, now: number = Date.now()): boolean {
  if (!state) return false;
  if (state.status === 'completed') return false;
  return !isSkipActive(state.skippedUntil, now);
}

/** 断点续做：定位到第一个未完成步骤（有快照或跳过标记的视为完成；全有则到完成页） */
export function resolveInitialStep(state: SetupWizardState | null): number {
  const done = state?.stepResults || {};
  for (let i = 0; i < SETUP_STEPS.length; i += 1) {
    if (done[String(i)] == null) return i;
  }
  return SETUP_STEPS.length - 1;
}

/** 已完成（含跳过）步骤数，横幅「进度 N/5」用 */
export function countDoneSteps(state: SetupWizardState | null): number {
  const done = state?.stepResults || {};
  let n = 0;
  for (let i = 0; i < SETUP_STEPS.length; i += 1) {
    if (done[String(i)] != null) n += 1;
  }
  return n;
}

/** 流水线是否结束：任务已终态，或全部子任务离开 pending/running */
export function isPipelineFinished(p: PipelineProgress | null): boolean {
  if (!p) return false;
  if (p.status === 'SUCCESS' || p.status === 'FAILED') return true;
  return p.subtasks.length > 0 && p.subtasks.every((s) => s.state !== 'pending' && s.state !== 'running');
}

/** 子任务计数摘要 → 中文文案（42 表 / 613 列、120 切片、种子 8 条…；未知键以 k v 兜底） */
export function formatCounters(c?: Record<string, number> | null): string {
  if (!c) return '';
  const known: Array<[string, string]> = [
    ['tables', '表'],
    ['columns', '列'],
    ['capabilities', '项能力'],
    ['entries', '条目'],
    ['ironRules', '铁律'],
    ['docs', '文档'],
    ['chunks', '切片'],
    ['pruned', '清理'],
    ['seeded', '种子'],
    ['skipped', '跳过'],
  ];
  const parts: string[] = [];
  for (const [k, unit] of known) {
    if (c[k] != null) parts.push(`${c[k]} ${unit}`);
  }
  for (const [k, v] of Object.entries(c)) {
    if (!known.some(([kk]) => kk === k)) parts.push(`${k} ${v}`);
  }
  return parts.join(' / ');
}

/** 步骤轨图标语义 */
export type StepTrackState = 'done' | 'active' | 'skipped' | 'todo';

export function stepTrackStates(state: SetupWizardState | null, activeStep: number): StepTrackState[] {
  const done = state?.stepResults || {};
  return SETUP_STEPS.map((_, i) => {
    const r = done[String(i)] as { skipped?: boolean } | undefined;
    if (r != null) return r.skipped ? 'skipped' : 'done';
    return i === activeStep ? 'active' : 'todo';
  });
}

/** Step⑤ 就绪判定 */
export type ReadinessLevel = 'ok' | 'warn' | 'block';

export interface ReadinessRow {
  key: string;
  label: string;
  level: ReadinessLevel;
  note: string;
}

export function summarizeReadiness(state: SetupWizardState | null): ReadinessRow[] {
  const env = state?.env;
  const summary = state?.summary || {};
  const step2 = (state?.stepResults?.['1'] || {}) as { llm?: ProbeResult; skipped?: boolean };
  const llmOk = step2.llm?.ok === true;
  const llmConfigured = !!env?.llm?.label;
  const dsCount = Math.max(
    Number(summary.datasources) || 0,
    Number(env?.datasources?.total) || 0,
    Number(env?.datasources?.connected) || 0,
  );
  const chunks = Number(summary.chunks) || 0;
  const examples = Number(summary.examples) || 0;
  return [
    llmOk
      ? { key: 'llm', label: '对话模型', level: 'ok', note: '探测通过' }
      : llmConfigured
        ? { key: 'llm', label: '对话模型', level: 'warn', note: '已配置，建议回第②步点「测试对话」确认连通' }
        : { key: 'llm', label: '对话模型', level: 'block', note: '未配置——问数功能不可用' },
    dsCount > 0
      ? { key: 'datasource', label: '数据源', level: 'ok', note: `已接入 ${dsCount} 个` }
      : { key: 'datasource', label: '数据源', level: 'block', note: '无数据源——无数据可问' },
    chunks > 0
      ? { key: 'vector', label: '知识向量化', level: 'ok', note: `向量切片 ${chunks} 条` }
      : { key: 'vector', label: '知识向量化', level: 'warn', note: '无向量切片——检索退化为词法匹配' },
    examples > 0
      ? { key: 'examples', label: '样例库', level: 'ok', note: `few-shot 样例 ${examples} 条` }
      : { key: 'examples', label: '样例库', level: 'warn', note: '样例为空——冷启动准确率偏低' },
  ];
}
