import { describe, expect, it } from 'vitest';
import { toTemplateRecord, validateTemplateContent, ReportTemplateRow } from './reportTemplates';

const baseRow: ReportTemplateRow = {
  id: 1,
  name: '综合经营分析',
  description: '面向管理层的综合经营简报',
  template_content: JSON.stringify({ sections: [{ title: '核心指标', prompt: '统计投放与回现', chartType: 'bar' }] }),
  is_preset: 1,
  created_by: 'system',
  created_at: new Date('2026-08-20T00:00:00.000Z'),
  updated_at: new Date('2026-08-20T00:00:00.000Z'),
};

describe('toTemplateRecord: 模板行记录 → 前端格式转换', () => {
  it('is_preset=1 映射为 isPreset=true，字段名转驼峰', () => {
    const out = toTemplateRecord(baseRow);
    expect(out.id).toBe(1);
    expect(out.name).toBe('综合经营分析');
    expect(out.templateContent).toBe(baseRow.template_content);
    expect(out.isPreset).toBe(true);
    expect(out.createdBy).toBe('system');
    expect(out.createdAt).toBe('2026-08-20T00:00:00.000Z');
    expect(out.updatedAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('is_preset=0 映射为 isPreset=false（自定义模板）', () => {
    const out = toTemplateRecord({ ...baseRow, is_preset: 0 });
    expect(out.isPreset).toBe(false);
  });
});

describe('validateTemplateContent: 模板内容结构校验', () => {
  it('合法模板通过校验', () => {
    const content = JSON.stringify({ sections: [{ title: '概览', prompt: '统计核心指标', chartType: 'bar' }] });
    expect(validateTemplateContent(content)).toEqual({ ok: true });
  });

  it('多章节合法模板通过校验', () => {
    const content = JSON.stringify({
      sections: [
        { title: '投放分析', prompt: '统计投放金额', chartType: 'line' },
        { title: '回现分析', prompt: '统计回现金额', chartType: 'pie' },
      ],
    });
    expect(validateTemplateContent(content)).toEqual({ ok: true });
  });

  it('非法 JSON 拒绝', () => {
    const r = validateTemplateContent('not-json{{{');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toContain('JSON');
  });

  it('缺少 sections 数组拒绝', () => {
    const r = validateTemplateContent(JSON.stringify({ name: 'x' }));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toContain('sections');
  });

  it('sections 为空数组拒绝', () => {
    const r = validateTemplateContent(JSON.stringify({ sections: [] }));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toContain('至少');
  });

  it('章节缺少 title 拒绝', () => {
    const r = validateTemplateContent(JSON.stringify({ sections: [{ prompt: 'p' }] }));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toContain('title');
  });

  it('章节 title 为空白字符串拒绝', () => {
    const r = validateTemplateContent(JSON.stringify({ sections: [{ title: '   ', prompt: 'p' }] }));
    expect(r.ok).toBe(false);
  });

  it('章节缺少 prompt 拒绝', () => {
    const r = validateTemplateContent(JSON.stringify({ sections: [{ title: 't' }] }));
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toContain('prompt');
  });
});
