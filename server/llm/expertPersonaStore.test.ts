/**
 * 专家角色库化（v0.9.40）单测：
 * sanitize 入参校验 / 库化路由（sortOrder 优先级、default 兜底、库异常回退内置、缓存与失效）/
 * CRUD 保护（default 仅可改标签与 rolePrompt、内置禁删）/ 启动播种幂等。
 * 同步内置常量路由的用例见 ./expertPersona.test.ts。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// 队列式 mock：按 SQL 调用顺序返回预设 [rows, fields]（与 ironRules.test.ts 同模式）
const queue: any[] = [];
const querySpy = vi.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('expertPersonaStore.test: 队列为空，SQL 调用次数超出预期');
  return next;
});
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));

import {
  BUILTIN_PERSONAS,
  sanitizePersonaInput,
  resolveExpertPersonaAsync,
  createPersona,
  updatePersona,
  deletePersona,
  ensureExpertPersonasSeeded,
  invalidateExpertPersonaCache,
} from './expertPersona';

/** 构造一条库行（rowToPersona 的输入形态） */
const dbRow = (over: any = {}) => ({
  id: 1,
  persona_key: 'risk',
  label: '不良资产风险管理专家',
  keywords: JSON.stringify(['风险', '逾期']),
  role_prompt: '你是风险管理专家',
  sort_order: 10,
  status: 'ACTIVE',
  is_builtin: 1,
  created_by: 'system',
  ...over,
});

beforeEach(() => {
  queue.length = 0;
  querySpy.mockClear();
  invalidateExpertPersonaCache();
});

describe('sanitizePersonaInput: 入参校验', () => {
  const valid = { label: '税务分析专家', keywords: ['税务', '纳税'], rolePrompt: '你是税务专家', sortOrder: 50 };

  it('合法输入通过；status 缺省归一 ACTIVE', () => {
    const r = sanitizePersonaInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.persona.label).toBe('税务分析专家');
      expect(r.persona.status).toBe('ACTIVE');
      expect(r.persona.sortOrder).toBe(50);
    }
  });

  it('必填缺失与超长拒绝', () => {
    expect(sanitizePersonaInput({ ...valid, label: '' }).ok).toBe(false);
    expect(sanitizePersonaInput({ ...valid, label: 'x'.repeat(51) }).ok).toBe(false);
    expect(sanitizePersonaInput({ ...valid, rolePrompt: '' }).ok).toBe(false);
    expect(sanitizePersonaInput({ ...valid, rolePrompt: 'x'.repeat(501) }).ok).toBe(false);
  });

  it('关键词去重去空白；单词超长与总数超限拒绝', () => {
    const r = sanitizePersonaInput({ ...valid, keywords: [' 税务 ', '税务', '', '纳税'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.persona.keywords).toEqual(['税务', '纳税']);
    expect(sanitizePersonaInput({ ...valid, keywords: ['x'.repeat(31)] }).ok).toBe(false);
    expect(sanitizePersonaInput({ ...valid, keywords: Array.from({ length: 21 }, (_, i) => `k${i}`) }).ok).toBe(false);
  });

  it('sortOrder 非整数归一 100，越界夹紧到 0-9999', () => {
    const a = sanitizePersonaInput({ ...valid, sortOrder: 'abc' });
    expect(a.ok && a.persona.sortOrder).toBe(100);
    const b = sanitizePersonaInput({ ...valid, sortOrder: -5 });
    expect(b.ok && b.persona.sortOrder).toBe(0);
    const c = sanitizePersonaInput({ ...valid, sortOrder: 99999 });
    expect(c.ok && c.persona.sortOrder).toBe(9999);
  });
});

describe('resolveExpertPersonaAsync: 库化路由', () => {
  it('按 sortOrder 升序匹配：两条都命中时小者优先（覆盖内置常量顺序）', async () => {
    // npl（含「不良」）sortOrder 被管理员调到 5，先于 risk（10）命中
    queue.push([[dbRow({ id: 2, persona_key: 'npl', label: '不良从业者', keywords: JSON.stringify(['不良']), role_prompt: '不良RP', sort_order: 5 }), dbRow()], undefined]);
    const p = await resolveExpertPersonaAsync('各分行不良率排名');
    expect(p.key).toBe('npl');
    expect(p.rolePrompt).toBe('不良RP');
  });

  it('无命中时回落到库中 default 角色（管理员改过的兜底文案生效）', async () => {
    queue.push([[dbRow({ persona_key: 'default', label: '企业数据分析师', keywords: '[]', role_prompt: '自定义兜底RP', sort_order: 9999 })], undefined]);
    const p = await resolveExpertPersonaAsync('各部门人数统计');
    expect(p.key).toBe('default');
    expect(p.label).toBe('企业数据分析师');
    expect(p.rolePrompt).toBe('自定义兜底RP');
  });

  it('库查询异常时回退内置常量路由（降级不撒谎）', async () => {
    querySpy.mockRejectedValueOnce(new Error('connection lost'));
    const p = await resolveExpertPersonaAsync('上季度现金流情况');
    expect(p.key).toBe('finance'); // 内置常量路由结果
  });

  it('60s 内重复路由只查一次库；invalidate 后重新查库', async () => {
    queue.push([[dbRow()], undefined]);
    await resolveExpertPersonaAsync('风险敞口');
    await resolveExpertPersonaAsync('逾期情况');
    expect(querySpy).toHaveBeenCalledTimes(1);
    invalidateExpertPersonaCache();
    queue.push([[dbRow()], undefined]);
    await resolveExpertPersonaAsync('风险敞口');
    expect(querySpy).toHaveBeenCalledTimes(2);
  });

  it('非法 keywords JSON 按空关键词处理（该角色不参与匹配，不崩链路）', async () => {
    queue.push([[dbRow({ keywords: '{broken' }), dbRow({ persona_key: 'default', keywords: '[]' })], undefined]);
    const p = await resolveExpertPersonaAsync('风险');
    expect(p.key).toBe('default');
  });
});

describe('updatePersona: default 保护', () => {
  it('default 角色强制关键词为空、状态 ACTIVE、优先级 9999（仅标签与 rolePrompt 可改）', async () => {
    queue.push([[dbRow({ persona_key: 'default' })], undefined]); // SELECT existing
    queue.push([{ affectedRows: 1 }, undefined]); // UPDATE
    const r = await updatePersona(1, {
      label: '默认分析师', keywords: ['不应生效'], rolePrompt: '新兜底RP', sortOrder: 5, status: 'DISABLED',
    });
    expect(r.ok).toBe(true);
    const updateCall = querySpy.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE expert_personas');
    expect(updateCall[1]).toEqual(['默认分析师', '[]', '新兜底RP', 9999, 'ACTIVE', 1]);
  });

  it('普通角色正常透传；不存在返回 notFound', async () => {
    queue.push([[dbRow({ persona_key: 'risk' })], undefined]);
    queue.push([{ affectedRows: 1 }, undefined]);
    const r = await updatePersona(1, { label: '风险专家', keywords: ['风险'], rolePrompt: 'RP', sortOrder: 8, status: 'DISABLED' });
    expect(r.ok).toBe(true);
    expect(querySpy.mock.calls[1][1]).toEqual(['风险专家', '["风险"]', 'RP', 8, 'DISABLED', 1]);

    queue.push([[], undefined]);
    const nf = await updatePersona(999, { label: 'x', keywords: [], rolePrompt: 'y', sortOrder: 100, status: 'ACTIVE' });
    expect(nf.ok).toBe(false);
    if (nf.ok === false) expect(nf.notFound).toBe(true);
  });
});

describe('deletePersona: 内置禁删', () => {
  it('内置角色拒绝删除', async () => {
    queue.push([[dbRow({ is_builtin: 1 })], undefined]);
    const r = await deletePersona(1);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toContain('内置角色不可删除');
    expect(querySpy).toHaveBeenCalledTimes(1); // 未执行 DELETE
  });

  it('自定义角色正常删除；不存在返回 notFound', async () => {
    queue.push([[dbRow({ is_builtin: 0 })], undefined]);
    queue.push([{ affectedRows: 1 }, undefined]);
    expect((await deletePersona(7)).ok).toBe(true);

    queue.push([[], undefined]);
    const nf = await deletePersona(999);
    expect(nf.ok).toBe(false);
    if (nf.ok === false) expect(nf.notFound).toBe(true);
  });
});

describe('ensureExpertPersonasSeeded: 启动播种幂等', () => {
  it('空表播种 5 个内置角色（default 含在内）', async () => {
    queue.push([[{ c: 0 }], undefined]);
    for (let i = 0; i < BUILTIN_PERSONAS.length; i++) queue.push([{ affectedRows: 1 }, undefined]);
    await ensureExpertPersonasSeeded();
    expect(querySpy).toHaveBeenCalledTimes(1 + BUILTIN_PERSONAS.length);
    const inserts = querySpy.mock.calls.slice(1);
    for (const c of inserts) expect(c[0]).toContain('INSERT IGNORE INTO expert_personas');
    expect(inserts.map((c) => c[1][0])).toEqual(['risk', 'customer', 'finance', 'npl', 'default']);
  });

  it('表非空时跳过（不覆盖管理员修改）', async () => {
    queue.push([[{ c: 5 }], undefined]);
    await ensureExpertPersonasSeeded();
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});
