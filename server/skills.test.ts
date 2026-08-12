import { describe, expect, it } from 'vitest';
import { getSkills, getSkill, fillSkillTemplate, BUILTIN_SKILLS } from './skills';

describe('getSkills / getSkill: 内置技能', () => {
  it('返回非空技能列表且字段完整', () => {
    const skills = getSkills();
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      expect(s.id).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.promptTemplate).toBeTruthy();
      expect(Array.isArray(s.placeholders)).toBe(true);
    }
  });

  it('getSkill 命中返回技能，未命中返回 undefined', () => {
    const first = BUILTIN_SKILLS[0];
    expect(getSkill(first.id)?.id).toBe(first.id);
    expect(getSkill('not-exist')).toBeUndefined();
  });

  it('占位符与模板中的 {{}} 一致', () => {
    for (const s of BUILTIN_SKILLS) {
      const inTemplate = [...s.promptTemplate.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((m) => m[1].trim());
      for (const p of s.placeholders) expect(inTemplate).toContain(p);
    }
  });
});

describe('fillSkillTemplate: 占位符填充', () => {
  it('替换已填写的占位符', () => {
    const out = fillSkillTemplate('请按{{维度}}统计{{指标}}', { 维度: '客户类型', 指标: '余额' });
    expect(out).toBe('请按客户类型统计余额');
  });

  it('未填写的占位符原样保留', () => {
    const out = fillSkillTemplate('请按{{维度}}统计{{指标}}', { 维度: '客户类型' });
    expect(out).toBe('请按客户类型统计{{指标}}');
  });

  it('空白值视为未填写', () => {
    const out = fillSkillTemplate('取前 {{N}} 名', { N: '   ' });
    expect(out).toBe('取前 {{N}} 名');
  });

  it('无占位符模板原样返回', () => {
    expect(fillSkillTemplate('统计总量', {})).toBe('统计总量');
  });
});
