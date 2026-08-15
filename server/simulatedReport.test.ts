import { describe, expect, it, vi } from 'vitest';
import { buildSimulatedReportSystem, runSimulatedReport } from './simulatedReport';
import { callLLMJson } from './llmClient';

vi.mock('./llmClient', () => ({
  callLLMJson: vi.fn(),
}));

/** 合规的 LLM 报告输出（通过 normalizeReport 校验的最小样例） */
const validReportPayload = {
  title: '2026年半年度经营分析报告',
  summary: '整体经营稳中有进。',
  insights: [{ title: '增长', type: 'positive', content: '营收增长', actionItem: '扩大投放' }],
  kpiList: [{ label: '营收', value: '1.2亿', change: '+12%', status: 'good' }],
  charts: [{ title: '趋势', chartConfig: { type: 'line', xAxisKey: 'month', yAxisKeys: ['amount'] }, data: [], commentary: '逐月走高' }],
};

describe('buildSimulatedReportSystem: 演示模式报表 system prompt 组装', () => {
  it('guidance 存在时注入维度/指标摘要与 Schema 约束段', () => {
    const p = buildSimulatedReportSystem([{ name: 'orders' }], '维度: region 指标: amount');
    expect(p).toContain('维度: region 指标: amount');
    expect(p).toContain('严禁编造');
  });

  it('guidance 为空时不注入 Schema 段，仍保留输出结构说明', () => {
    const p = buildSimulatedReportSystem([], '');
    expect(p).not.toContain('【强制约束】');
    expect(p).toContain('请输出标准JSON报告对象');
  });
});

describe('runSimulatedReport: 演示模式报告生成', () => {
  it('合规报告通过校验：ok=true 且主题/自定义要求进入 user prompt', async () => {
    (callLLMJson as any).mockImplementation(async (_system: string, prompt: string) => {
      expect(prompt).toContain('销售分析');
      expect(prompt).toContain('重点关注华南');
      return JSON.stringify(validReportPayload);
    });
    const out = await runSimulatedReport({ templateType: '销售分析', customPrompt: '重点关注华南', schema: [], guidance: '' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.report.title).toContain('半年度');
  });

  it('报告缺少 title/summary（结构校验失败）：ok=false', async () => {
    (callLLMJson as any).mockResolvedValue('{"summary": "只有摘要"}');
    const out = await runSimulatedReport({ templateType: 't', customPrompt: 'c', schema: [], guidance: '' });
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.error).toBe('LLM 报告内容未通过结构化校验');
  });

  it('LLM 调用异常：ok=false 且透传错误信息（路由层降级 fallback）', async () => {
    (callLLMJson as any).mockRejectedValue(new Error('配额耗尽'));
    const out = await runSimulatedReport({ templateType: 't', customPrompt: 'c', schema: [], guidance: '' });
    expect(out.ok).toBe(false);
    if (out.ok === false) expect(out.error).toContain('配额耗尽');
  });
});
