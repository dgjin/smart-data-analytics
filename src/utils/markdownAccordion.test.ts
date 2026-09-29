/**
 * 帮助中心文档「模块抽屉」切分测试（v0.9.89）：
 * 头部段（h1 + 前言）归集、## 模块切分（标题不入正文）、### 子标题保留段内、
 * 空章节结构保留、空文档与异常输入兜底。
 */
import { describe, it, expect } from 'vitest';
import { splitDocForAccordion } from './markdownAccordion';

describe('splitDocForAccordion：Markdown → 抽屉段', () => {
  it('h1 与前言归头部段（title 为 null），## 为模块边界且标题不入正文', () => {
    const md = [
      '# 用户使用指南',
      '> 面向使用者的操作指南。',
      '## 1. 三分钟上手',
      '第一步：登录。',
      '## 2. 常见问题',
      'Q&A。',
    ].join('\n');
    const secs = splitDocForAccordion(md);
    expect(secs.map((s) => s.title)).toEqual([null, '1. 三分钟上手', '2. 常见问题']);
    expect(secs[0].markdown).toContain('# 用户使用指南');
    expect(secs[0].markdown).toContain('面向使用者的操作指南');
    expect(secs[1].markdown).toBe('第一步：登录。');
    expect(secs[1].markdown).not.toContain('##');
  });

  it('### 子标题保留在所属模块段内', () => {
    const md = ['## 3. 智能问答', '### 历史对话', '查看历史记录。', '## 4. 报告'].join('\n');
    const secs = splitDocForAccordion(md);
    expect(secs.map((s) => s.title)).toEqual(['3. 智能问答', '4. 报告']);
    expect(secs[0].markdown).toBe('### 历史对话\n查看历史记录。');
  });

  it('无标题文档 → 单个头部段；头部段全空白 → 丢弃', () => {
    expect(splitDocForAccordion('只有一段正文').map((s) => s.title)).toEqual([null]);
    expect(splitDocForAccordion('\n\n  \n')).toEqual([]);
  });

  it('空章节保留模块结构（正文为空串）；空文档 / 异常输入 → 空数组；h1 属头部段', () => {
    const secs = splitDocForAccordion('## 空模块\n## 有内容\nx');
    expect(secs).toEqual([
      { title: '空模块', markdown: '' },
      { title: '有内容', markdown: 'x' },
    ]);
    expect(splitDocForAccordion('')).toEqual([]);
    expect(splitDocForAccordion('# 仅主标题').map((s) => s.title)).toEqual([null]);
  });
});
