/**
 * 帮助问答业务测试（v0.9.88 帮助中心「智能问答」）：
 * 历史清洗（非法项剔除 / 超长截断 / 仅保留最近 6 条）与提示词装配
 * （命中章节注入 system、history 拼入 user、文档缺失与空回答抛错、无命中如实标注「未检索到」）。
 * LLM 通道与文档读取全量 mock，不触网、不读真实文件。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ callLLMText: vi.fn() }));
vi.mock('../llm/llmClient', () => ({ callLLMText: h.callLLMText }));

const docs = vi.hoisted(() => ({ readManual: vi.fn(), readDoc: vi.fn() }));
vi.mock('./helpDocs', () => ({
  readManual: docs.readManual,
  readDoc: docs.readDoc,
  candidatePathsFor: () => ['/nonexistent/更新日志.md'],
  CHANGELOG_FILENAME: '更新日志.md',
}));

import { answerHelpQuestion, normalizeHelpHistory } from './helpAsk';

const MANUAL_DOC = {
  markdown: [
    '# 用户使用指南',
    '## 金额单位设置',
    '在「系统管理 → 展示与偏好」中设置全局金额单位，问数 / 报表 / 灵活查询默认跟随。',
    '## 报表导出',
    '报表支持导出 PDF 与 Word 文档。',
  ].join('\n'),
  updatedAt: '2026-09-29T00:00:00.000Z',
};

beforeEach(() => {
  h.callLLMText.mockReset();
  docs.readManual.mockReset();
  docs.readDoc.mockReset();
  docs.readManual.mockReturnValue(MANUAL_DOC);
  docs.readDoc.mockReturnValue(null);
});

describe('normalizeHelpHistory：对话历史清洗', () => {
  it('剔除非 user/assistant 角色与空内容项', () => {
    const out = normalizeHelpHistory([
      { role: 'system', content: '忽略我' },
      { role: 'user', content: '问题一' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: '回答一' },
    ]);
    expect(out).toEqual([
      { role: 'user', content: '问题一' },
      { role: 'assistant', content: '回答一' },
    ]);
  });

  it('单条截断到 300 字、仅保留最近 6 条', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `问题${i}` }));
    const out = normalizeHelpHistory(many);
    expect(out).toHaveLength(6);
    expect(out[0].content).toBe('问题4'); // 取尾部 6 条

    const long = normalizeHelpHistory([{ role: 'user', content: '字'.repeat(500) }]);
    expect(long[0].content).toHaveLength(300);
  });

  it('非数组输入 → 空数组', () => {
    expect(normalizeHelpHistory(undefined)).toEqual([]);
    expect(normalizeHelpHistory('abc')).toEqual([]);
    expect(normalizeHelpHistory(null)).toEqual([]);
  });
});

describe('answerHelpQuestion：检索装配与 LLM 调用', () => {
  it('命中章节注入 system（含来源与标题），user 携带问题原文', async () => {
    h.callLLMText.mockResolvedValue('在「系统管理 → 展示与偏好」中设置。');
    const out = await answerHelpQuestion('金额单位在哪里设置？');
    expect(out.answer).toBe('在「系统管理 → 展示与偏好」中设置。');
    expect(out.sections).toEqual(['用户使用指南 · 金额单位设置']);

    const [system, user] = h.callLLMText.mock.calls[0] as [string, string];
    expect(system).toContain('【用户使用指南 · 金额单位设置】');
    expect(system).toContain('展示与偏好');
    expect(system).toContain('不要编造');
    expect(user).toContain('用户问题：金额单位在哪里设置？');
    expect(user).not.toContain('最近对话'); // 无历史时不拼对话段
  });

  it('携带历史时以「最近对话」拼入 user，并保留指代语境', async () => {
    h.callLLMText.mockResolvedValue('可以。');
    await answerHelpQuestion('那报表呢？', [
      { role: 'user', content: '金额单位在哪里设置？' },
      { role: 'assistant', content: '在「系统管理 → 展示与偏好」中设置。' },
    ]);
    const [, user] = h.callLLMText.mock.calls[0] as [string, string];
    expect(user).toContain('最近对话');
    expect(user).toContain('助手：在「系统管理 → 展示与偏好」中设置。');
    expect(user).toContain('用户问题：那报表呢？');
  });

  it('检索无命中 → system 标注「未检索到相关章节」，sections 为空', async () => {
    h.callLLMText.mockResolvedValue('帮助文档中没有找到相关内容。');
    const out = await answerHelpQuestion('zzzz yyyy');
    expect(out.sections).toEqual([]);
    const [system] = h.callLLMText.mock.calls[0] as [string, string];
    expect(system).toContain('（未检索到相关章节）');
  });

  it('帮助文档全部缺失 → 抛错（由路由兜底 502）', async () => {
    docs.readManual.mockReturnValue(null);
    docs.readDoc.mockReturnValue(null);
    await expect(answerHelpQuestion('怎么用')).rejects.toThrow('帮助文档缺失');
    expect(h.callLLMText).not.toHaveBeenCalled();
  });

  it('LLM 返回空内容 → 抛错', async () => {
    h.callLLMText.mockResolvedValue('   ');
    await expect(answerHelpQuestion('金额单位在哪里设置？')).rejects.toThrow('AI 未返回内容');
  });

  it('更新日志作为补充来源参与检索时标注来源', async () => {
    docs.readDoc.mockReturnValue({ markdown: '## v0.9.80\n灵活查询画布字段图形化。', updatedAt: 'x' });
    h.callLLMText.mockResolvedValue('见更新日志。');
    const out = await answerHelpQuestion('灵活查询画布有什么变化？');
    expect(out.sections.some((s) => s.startsWith('更新日志 · '))).toBe(true);
  });
});
