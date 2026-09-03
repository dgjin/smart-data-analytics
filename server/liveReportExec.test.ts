/**
 * v0.9.20 报表生成效率优化单测（对照问数链路效率方案）：
 * ① 执行阶段并行化——多条查询计划 Promise.all 并发过安全执行层（墙钟=最慢一条，而非逐条相加），
 *    部分失败跳过、汇总保持计划原顺序（executedSqls 与 charts 索引对齐，下钻依赖）；
 * ② 阶段二接入 analysisStageRoute 快速模型路由（LLM_ANALYSIS_* 配置时生效，未配置回退主模型）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runLiveReport, type ReportQueryPlan } from './liveReport';
import { callLLMJson } from './llmClient';
import { executeSafeSql } from './sqlExecutor';

vi.mock('./llmClient', () => ({
  callLLMJson: vi.fn(),
  analysisStageRoute: vi.fn(() => ({ engine: 'ollama', model: 'qwen3:8b' })),
  sqlStageRoute: vi.fn(() => undefined),
}));
vi.mock('./sqlExecutor', () => ({ executeSafeSql: vi.fn() }));
vi.mock('./metrics', () => ({
  loadActiveMetrics: vi.fn().mockResolvedValue([]),
  matchMetrics: vi.fn().mockReturnValue([]),
  buildMetricPrompt: vi.fn().mockReturnValue(''),
}));
vi.mock('./knowledgeBase', () => ({ retrieveKnowledgeSnippets: vi.fn().mockResolvedValue('') }));

const mockedLLM = vi.mocked(callLLMJson);
const mockedExec = vi.mocked(executeSafeSql);

const STAGE2_JSON = JSON.stringify({
  title: '测试报表',
  summary: '摘要',
  insights: [],
  kpiList: [],
  commentaries: ['c1', 'c2', 'c3'],
});

function makePlans(n: number): { reportTitle: string; plans: ReportQueryPlan[] } {
  return {
    reportTitle: '测试报表',
    plans: Array.from({ length: n }, (_, i) => ({
      title: `图${i}`,
      sql: `SELECT dim, SUM(val) AS val FROM t1 /*p${i}*/ GROUP BY dim`,
      chartType: 'bar',
      xAxisKey: 'dim',
      yAxisKeys: ['val'],
      columnNames: { dim: '维度', val: '数值' },
      purpose: `用途${i}`,
    })),
  };
}

const BASE_INPUT = {
  templateType: '综合经营分析',
  customPrompt: '',
  schema: [
    {
      name: 't1',
      displayName: '测试表',
      columns: [
        ['dim', 'varchar', '维度'],
        ['val', 'decimal', '数值'],
      ],
    },
  ] as any[],
  guidance: '',
  dataSourceId: 'ds_perf',
  sensitiveRemoved: [] as string[],
};

/** 从 SQL 注释中提取计划序号（/*pN*\/） */
function planIdxOf(sql: unknown): number {
  const m = /\/\*p(\d+)\*\//.exec(String(sql));
  return m ? Number(m[1]) : -1;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLLM.mockResolvedValue(STAGE2_JSON);
});

describe('报表执行阶段并行化（v0.9.20）', () => {
  it('多条查询计划并发执行（最大在飞数=计划数），汇总保持计划原顺序', async () => {
    let inflight = 0;
    let maxInflight = 0;
    mockedExec.mockImplementation(async (_ds, sql) => {
      const idx = planIdxOf(sql);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // 序号越大返回越快（完成顺序与计划顺序相反），验证汇总顺序不依赖完成顺序
      await new Promise((r) => setTimeout(r, 60 - idx * 20));
      inflight--;
      return { ok: true, result: { rows: [{ dim: `d${idx}`, val: idx + 1 }], finalSql: String(sql), rowCount: 1 } } as any;
    });

    const approvedPlans = makePlans(3);
    const out = await runLiveReport({ ...BASE_INPUT, approvedPlans });

    expect(out.ok).toBe(true);
    expect(maxInflight).toBe(3); // 3 条计划真实并发（串行实现 maxInflight 恒为 1）
    if (out.ok) {
      // executedSqls 与 charts 严格按计划顺序（p0/p1/p2），不受完成顺序（p2 先回）影响
      expect(out.executedSqls.map((s) => planIdxOf(s))).toEqual([0, 1, 2]);
      expect(out.report.charts.map((c: any) => c.data[0].dim)).toEqual(['d0', 'd1', 'd2']);
      expect(out.totalRows).toBe(3);
    }
  });

  it('部分查询失败跳过，其余正常生成（executedSqls 与 charts 仍对齐）', async () => {
    mockedExec.mockImplementation(async (_ds, sql) => {
      const idx = planIdxOf(sql);
      if (idx === 1) return { ok: false, reason: '模拟执行失败' } as any;
      return { ok: true, result: { rows: [{ dim: `d${idx}`, val: idx }], finalSql: String(sql), rowCount: 2 } } as any;
    });

    const out = await runLiveReport({ ...BASE_INPUT, approvedPlans: makePlans(3) });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.executedSqls.map((s) => planIdxOf(s))).toEqual([0, 2]);
      expect(out.report.charts.map((c: any) => c.title)).toEqual(['图0', '图2']);
      expect(out.totalRows).toBe(4);
    }
  });

  it('全部查询失败返回 ok:false 且不进入阶段二', async () => {
    mockedExec.mockResolvedValue({ ok: false, reason: '模拟失败' } as any);

    const out = await runLiveReport({ ...BASE_INPUT, approvedPlans: makePlans(2) });

    expect(out.ok).toBe(false);
    // tsconfig 未开 strictNullChecks，!out.ok 真值反向收窄不可用，用等值收窄
    if (out.ok === false) expect(out.error).toBe('全部报表查询执行失败');
    expect(mockedLLM).not.toHaveBeenCalled();
  });
});

describe('报表阶段二快速模型路由（v0.9.20）', () => {
  it('阶段二调用携带 analysisStageRoute 路由', async () => {
    mockedExec.mockImplementation(async (_ds, sql) => {
      const idx = planIdxOf(sql);
      return { ok: true, result: { rows: [{ dim: `d${idx}`, val: 1 }], finalSql: String(sql), rowCount: 1 } } as any;
    });

    const out = await runLiveReport({ ...BASE_INPUT, approvedPlans: makePlans(2) });

    expect(out.ok).toBe(true);
    // approvedPlans 跳过阶段一，唯一一次 LLM 调用即阶段二
    expect(mockedLLM).toHaveBeenCalledTimes(1);
    expect(mockedLLM.mock.calls[0][3]).toEqual({ route: { engine: 'ollama', model: 'qwen3:8b' } });
  });
});
