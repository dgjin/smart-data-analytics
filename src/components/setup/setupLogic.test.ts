/**
 * 首启初始化向导纯函数测试：显示判定 / 断点定位 / 计数格式化 / 步骤轨 / 就绪判定。
 */
import { describe, expect, it } from 'vitest';
import {
  countDoneSteps,
  formatCounters,
  isPipelineFinished,
  isSkipActive,
  isWizardActive,
  resolveInitialStep,
  stepTrackStates,
  summarizeReadiness,
} from './setupLogic';
import type { PipelineProgress, SetupWizardState } from './setupTypes';

function makeState(over: Partial<SetupWizardState> = {}): SetupWizardState {
  return {
    status: 'in_progress',
    currentStep: 0,
    stepResults: {},
    pipelineTaskId: null,
    skippedUntil: null,
    startedBy: 'admin',
    completedAt: null,
    updatedAt: '2026-09-29T10:00:00Z',
    ...over,
  };
}

function makePipeline(over: Partial<PipelineProgress> = {}): PipelineProgress {
  return { taskId: 't1', status: 'RUNNING', subtasks: [], ...over };
}

describe('isSkipActive：静默期判定', () => {
  it('null / 空 / 非法值视为未静默', () => {
    expect(isSkipActive(null)).toBe(false);
    expect(isSkipActive(undefined)).toBe(false);
    expect(isSkipActive('')).toBe(false);
    expect(isSkipActive('not-a-date')).toBe(false);
  });

  it('过去时间未静默；未来时间静默中', () => {
    const now = Date.parse('2026-09-29T10:00:00Z');
    expect(isSkipActive('2026-09-28T10:00:00Z', now)).toBe(false);
    expect(isSkipActive('2026-10-06T10:00:00Z', now)).toBe(true);
  });
});

describe('isWizardActive：L1/L2 引导活跃判定', () => {
  it('空状态 / 已完成 → 不活跃', () => {
    expect(isWizardActive(null)).toBe(false);
    expect(isWizardActive(makeState({ status: 'completed' }))).toBe(false);
  });

  it('pending/in_progress 且未静默 → 活跃', () => {
    expect(isWizardActive(makeState({ status: 'pending' }))).toBe(true);
    expect(isWizardActive(makeState())).toBe(true);
  });

  it('静默期内不活跃', () => {
    const now = Date.parse('2026-09-29T10:00:00Z');
    expect(isWizardActive(makeState({ skippedUntil: '2026-10-06T10:00:00Z' }), now)).toBe(false);
  });
});

describe('resolveInitialStep / countDoneSteps：断点续做', () => {
  it('空快照 → 第 1 步；缺失第一个 → 对应步', () => {
    expect(resolveInitialStep(makeState())).toBe(0);
    expect(resolveInitialStep(makeState({ stepResults: { '0': { a: 1 } } }))).toBe(1);
    expect(resolveInitialStep(makeState({ stepResults: { '0': {}, '1': {}, '3': {} } }))).toBe(2);
  });

  it('全部有快照 → 定位到完成页（4）', () => {
    expect(resolveInitialStep(makeState({ stepResults: { '0': {}, '1': {}, '2': {}, '3': {}, '4': {} } }))).toBe(4);
  });

  it('完成（含跳过）计数', () => {
    expect(countDoneSteps(null)).toBe(0);
    expect(countDoneSteps(makeState({ stepResults: { '0': {}, '2': { skipped: true } } }))).toBe(2);
    expect(countDoneSteps(makeState({ stepResults: { '0': {}, '1': {}, '2': {}, '3': {}, '4': {} } }))).toBe(5);
  });
});

describe('isPipelineFinished：流水线终态判定', () => {
  it('null → false；SUCCESS/FAILED → true', () => {
    expect(isPipelineFinished(null)).toBe(false);
    expect(isPipelineFinished(makePipeline({ status: 'SUCCESS' }))).toBe(true);
    expect(isPipelineFinished(makePipeline({ status: 'FAILED' }))).toBe(true);
  });

  it('全子任务离开 pending/running → true；存在 running → false', () => {
    const sub = (state: string) => ({ key: state, label: state, state: state as never });
    expect(isPipelineFinished(makePipeline({ subtasks: [sub('success'), sub('skipped')] }))).toBe(true);
    expect(isPipelineFinished(makePipeline({ subtasks: [sub('success'), sub('running')] }))).toBe(false);
    expect(isPipelineFinished(makePipeline({ subtasks: [] }))).toBe(false);
  });
});

describe('formatCounters：计数摘要文案', () => {
  it('空值 → 空串；已知键按序中文化', () => {
    expect(formatCounters(null)).toBe('');
    expect(formatCounters({ tables: 42, columns: 613 })).toBe('42 表 / 613 列');
    expect(formatCounters({ docs: 6, chunks: 120, pruned: 2 })).toBe('6 文档 / 120 切片 / 2 清理');
  });

  it('未知键以「k v」兜底（已知键优先保序）', () => {
    expect(formatCounters({ seeded: 8, skipped: 1 })).toBe('8 种子 / 1 跳过');
    expect(formatCounters({ arbitrary: 3 })).toBe('arbitrary 3');
  });
});

describe('stepTrackStates：步骤轨四态', () => {
  it('完成 / 跳过 / 进行中 / 未开始', () => {
    const state = makeState({ stepResults: { '0': {}, '1': { skipped: true } } });
    expect(stepTrackStates(state, 2)).toEqual(['done', 'skipped', 'active', 'todo', 'todo']);
  });
});

describe('summarizeReadiness：Step⑤ 就绪判定', () => {
  it('未配置模型且无数据源：模型/数据源阻断，向量/样例降质', () => {
    const rows = summarizeReadiness(makeState());
    expect(rows.map((r) => r.level)).toEqual(['block', 'block', 'warn', 'warn']);
  });

  it('探测通过 + 有数据源 + 有切片与样例：全部达标', () => {
    const state = makeState({
      stepResults: { '1': { llm: { ok: true } } },
      env: { llm: { engine: 'ollama', model: 'qwen', label: 'Ollama qwen' } } as never,
      summary: { datasources: 1, tables: 10, chunks: 120, examples: 8 },
    });
    const rows = summarizeReadiness(state);
    expect(rows.map((r) => r.level)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(rows[1].note).toBe('已接入 1 个');
  });

  it('已配置未探测：模型为降质提示（warn）', () => {
    const state = makeState({
      env: { llm: { engine: 'qwen', model: 'qwen3.8-max', label: 'Qwen qwen3.8-max' } } as never,
    });
    expect(summarizeReadiness(state)[0].level).toBe('warn');
  });
});
