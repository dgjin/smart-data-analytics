/**
 * 帮助章节检索纯函数测试（v0.9.88 帮助中心「智能问答」）：
 * bigram 切分、Markdown 章节切分（父链标题 / 文档概述 / 空章节丢弃）、
 * 检索排序（标题命中加权、长章节长度惩罚）与 topK / maxChars 预算约束。
 */
import { describe, it, expect } from 'vitest';
import { bigramSet, selectHelpSections, splitMarkdownSections, stripQuestionFillers } from './helpSearch';

describe('bigramSet：文本 → bigram 集合', () => {
  it('中英文与数字小写化，剔除符号与空白', () => {
    const g = bigramSet('如何配置 DataSource？SQL-2');
    expect(g.has('如何')).toBe(true);
    expect(g.has('配置')).toBe(true);
    expect(g.has('da')).toBe(true); // datasource 已小写
    expect(g.has('sq')).toBe(true);
    expect(g.has('？')).toBe(false);
  });

  it('空文本 / 纯符号 → 空集合；单字符 → 自身', () => {
    expect(bigramSet('').size).toBe(0);
    expect(bigramSet(' ？!，。').size).toBe(0);
    expect([...bigramSet('好')]).toEqual(['好']);
  });
});

describe('stripQuestionFillers：问题侧疑问/口语词剔除', () => {
  it('剔除疑问与口语词，保留实词', () => {
    expect(stripQuestionFillers('怎么配置数据源')).toBe(' 配置数据源');
    expect(stripQuestionFillers('金额单位在哪里设置？')).toBe('金额单位 设置？');
    expect(stripQuestionFillers('为什么图表不能做环比')).toBe(' 图表不能做环比');
  });

  it('全部为填充词 / 空问题 → 回退原文，不产生空问题', () => {
    expect(stripQuestionFillers('怎么')).toBe('怎么');
    expect(stripQuestionFillers('')).toBe('');
  });
});

describe('splitMarkdownSections：Markdown → 章节', () => {
  it('## 与 ### 均为边界，### 标题自动拼接 ## 父级链', () => {
    const md = ['# 文档主标题', '', '## 一、开始', '内容A', '### 子节', '内容B', '## 二、进阶', '内容C'].join('\n');
    const secs = splitMarkdownSections(md);
    expect(secs.map((s) => s.title)).toEqual(['一、开始', '一、开始 · 子节', '二、进阶']);
    expect(secs[1].content).toBe('内容B');
  });

  it('首个标题前的非空内容归入「文档概述」；正文全空的章节丢弃', () => {
    const md = ['简介段落', '## 空节', '## 有内容', 'x'].join('\n');
    const secs = splitMarkdownSections(md);
    expect(secs.map((s) => s.title)).toEqual(['文档概述', '有内容']);
    expect(secs[0].content).toBe('简介段落');
  });

  it('空文档 / 仅主标题 → 空数组', () => {
    expect(splitMarkdownSections('')).toEqual([]);
    expect(splitMarkdownSections('# 只有主标题')).toEqual([]);
  });
});

describe('selectHelpSections：相关章节选取', () => {
  const docs = [
    {
      label: '用户使用指南',
      markdown: [
        '## 数据源管理',
        '在「数据管理」页签新增数据源，填写连接信息并测试连接。',
        '## 报表导出',
        '报表支持导出 PDF 与 Word 文档。',
      ].join('\n'),
    },
    {
      label: '更新日志',
      markdown: '## v0.9.80\n灵活查询表关系画布字段图形化。',
    },
  ];

  it('命中与问题最相关的章节，并标注来源文档', () => {
    const picked = selectHelpSections(docs, '怎么新增数据源？');
    expect(picked.length).toBeGreaterThan(0);
    expect(picked[0].title).toBe('数据源管理');
    expect(picked[0].source).toBe('用户使用指南');
  });

  it('疑问词先在问题侧剔除：不因父链标题含「怎么问」等错配章节', () => {
    const fillerDocs = [
      {
        label: 'D',
        markdown: [
          '## 3. 智能问答：怎么问、怎么看',
          '本大节介绍提问。',
          '### 历史对话',
          '查看历史记录。',
          '## 数据管理',
          '在数据源管理页新增数据源。',
        ].join('\n'),
      },
    ];
    const withFiller = selectHelpSections(fillerDocs, '怎么配置数据源？', { topK: 3 });
    const plain = selectHelpSections(fillerDocs, '配置数据源', { topK: 3 });
    expect(withFiller.map((s) => s.title)).toEqual(plain.map((s) => s.title)); // 含与不含填充词排序一致
    expect(plain[0].title).toBe('数据管理');
  });

  it('问题与全部章节无关 → 空数组；空问题 → 空数组', () => {
    expect(selectHelpSections(docs, 'zzzz yyyy')).toEqual([]);
    expect(selectHelpSections(docs, '？!')).toEqual([]);
  });

  it('标题命中优先于同词仅出现在冗长正文中的章节', () => {
    const weightDocs = [
      {
        label: 'D',
        markdown: ['## 金额单位在哪里设置', '介绍。', '## 其他主题', `金额单位，${'补充说明。'.repeat(400)}`].join('\n'),
      },
    ];
    const picked = selectHelpSections(weightDocs, '金额单位在哪里设置？', { topK: 2 });
    expect(picked[0].title).toBe('金额单位在哪里设置');
  });

  it('长章节长度惩罚：同等命中下短章节得分更高', () => {
    const lenDocs = [
      {
        label: 'D',
        markdown: ['## 短章节', '数据源配置', '## 长章节', `数据源配置 ${'无关内容。'.repeat(500)}`].join('\n'),
      },
    ];
    const picked = selectHelpSections(lenDocs, '数据源配置', { topK: 2 });
    expect(picked[0].title).toBe('短章节');
  });

  it('topK 限制返回数量', () => {
    const picked = selectHelpSections(docs, '数据源 报表 导出 画布', { topK: 1 });
    expect(picked).toHaveLength(1);
  });

  it('maxChars 约束：超长章节按剩余预算截断，预算耗尽后不再追加', () => {
    const longDocs = [
      {
        label: 'D',
        markdown: [
          '## 数据源甲',
          `数据源${'甲说明文字。'.repeat(100)}`,
          '## 数据源乙',
          `数据源${'乙说明文字。'.repeat(100)}`,
          '## 数据源丙',
          '数据源丙短说明。',
        ].join('\n'),
      },
    ];
    const picked = selectHelpSections(longDocs, '数据源', { topK: 5, maxChars: 550 });
    expect(picked.map((s) => s.title)).toEqual(['数据源丙', '数据源甲']); // 丙短章节优先；甲截断占满预算；乙因预算耗尽跳过
    const total = picked.reduce((n, s) => n + s.content.length, 0);
    expect(total).toBeLessThanOrEqual(550);
  });
});
