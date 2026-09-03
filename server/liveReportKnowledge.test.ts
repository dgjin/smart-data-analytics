/**
 * v0.9.19 报表阶段一知识库 RAG 注入单测：
 * 决策报表 SQL 生成与问数同口径——按「报表主题+额外要求」检索知识库片段注入阶段一 system prompt；
 * 检索为空/异常时降级不注入、不阻断报表生成；注入受 KNOWLEDGE_TOKEN_BUDGET 预算截断。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { generateReportPlans } from './liveReport';
import { callLLMJson } from './llmClient';
import { retrieveKnowledgeSnippets } from './knowledgeBase';
import { KNOWLEDGE_TOKEN_BUDGET } from './promptBudget';

vi.mock('./llmClient', () => ({ callLLMJson: vi.fn() }));
vi.mock('./knowledgeBase', () => ({ retrieveKnowledgeSnippets: vi.fn() }));
vi.mock('./metrics', () => ({
  loadActiveMetrics: vi.fn().mockResolvedValue([]),
  matchMetrics: vi.fn().mockReturnValue([]),
  buildMetricPrompt: vi.fn().mockReturnValue(''),
}));

const mockedLLM = vi.mocked(callLLMJson);
const mockedKb = vi.mocked(retrieveKnowledgeSnippets);

const PLAN_JSON = JSON.stringify({
  reportTitle: '测试报表',
  queries: [
    {
      title: '机构投放对比',
      sql: "SELECT JGMC, SUM(BNTFJE) AS amt FROM fct_jc_main_biz_stat WHERE BB = '1' GROUP BY JGMC",
      chartType: 'bar',
      xAxisKey: 'JGMC',
      yAxisKeys: ['amt'],
      columnNames: { JGMC: '机构名称', amt: '本年投放金额' },
      purpose: '对比各机构投放规模',
    },
  ],
});

const INPUT = {
  templateType: '综合经营分析',
  customPrompt: '关注不良资产投放',
  schema: [
    {
      name: 'fct_jc_main_biz_stat',
      displayName: '主业务统计',
      columns: [
        ['JGMC', 'varchar', '机构名称'],
        ['BNTFJE', 'decimal', '本年投放金额'],
        ['BB', 'varchar', '报表版本'],
        ['BBRQ', 'varchar', '报表日期'],
      ],
    },
  ] as any[],
  guidance: '',
  dataSourceId: 'ds_kb',
  sensitiveRemoved: [] as string[],
};

/** 首个 LLM 调用（阶段一）的 system prompt */
function stage1System(): string {
  return String(mockedLLM.mock.calls[0]?.[0] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLLM.mockResolvedValue(PLAN_JSON);
});

describe('报表阶段一知识库注入（v0.9.19）', () => {
  it('检索命中时知识片段注入 system prompt（含「必须遵循」强指令与口径内容）', async () => {
    mockedKb.mockResolvedValue(
      "业务知识库（管理员登记的权威口径与术语，生成 SQL 时**必须遵循**其中命中本问题的口径、枚举写法与计算规则）:\n- [投放口径速查] 四红线 R1+R2：必须用 MAX(BBRQ) 子查询且 BB='1'\n"
    );
    const out = await generateReportPlans(INPUT);
    expect(out.ok).toBe(true);
    expect(stage1System()).toContain('必须遵循');
    expect(stage1System()).toContain('四红线 R1+R2');
  });

  it('检索 query 为「报表主题 + 额外要求」（与指标层匹配输入一致），按数据源隔离', async () => {
    mockedKb.mockResolvedValue('');
    await generateReportPlans(INPUT);
    expect(mockedKb).toHaveBeenCalledWith('ds_kb', expect.stringContaining('综合经营分析'));
    expect(mockedKb).toHaveBeenCalledWith('ds_kb', expect.stringContaining('关注不良资产投放'));
  });

  it('检索为空时不注入知识块，报表生成不受影响', async () => {
    mockedKb.mockResolvedValue('');
    const out = await generateReportPlans(INPUT);
    expect(out.ok).toBe(true);
    expect(stage1System()).not.toContain('业务知识库');
  });

  it('检索异常降级为空串，不阻断报表生成', async () => {
    mockedKb.mockRejectedValue(new Error('db down'));
    const out = await generateReportPlans(INPUT);
    expect(out.ok).toBe(true);
    expect(stage1System()).not.toContain('业务知识库');
  });

  it('超长知识片段按 token 预算截断后注入', async () => {
    mockedKb.mockResolvedValue('x'.repeat(KNOWLEDGE_TOKEN_BUDGET * 3));
    const out = await generateReportPlans(INPUT);
    expect(out.ok).toBe(true);
    // 截断上限 floor(预算×1.5)，超出部分不得出现在 system prompt 中
    expect(stage1System()).not.toContain('x'.repeat(Math.floor(KNOWLEDGE_TOKEN_BUDGET * 1.5) + 1));
    expect(stage1System()).toContain('x'.repeat(100));
  });

  it('无 dataSourceId 时不发起检索', async () => {
    mockedKb.mockResolvedValue('业务知识库：不应出现');
    const out = await generateReportPlans({ ...INPUT, dataSourceId: '' });
    expect(out.ok).toBe(true);
    expect(mockedKb).not.toHaveBeenCalled();
    expect(stage1System()).not.toContain('业务知识库');
  });
});
