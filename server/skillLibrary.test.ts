import { describe, expect, it, vi, beforeEach } from 'vitest';

// 队列式 mock：按 SQL 调用顺序返回预设 [rows, fields]
const queue: any[] = [];
const querySpy = vi.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('skillLibrary.test: 队列为空，SQL 调用次数超出预期');
  return next;
});
vi.mock('./db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));

import { extractPlaceholders, validateSkillInput, requestShare, approveShare, rejectShare } from './skillLibrary';

function skillRow(overrides: Record<string, any> = {}) {
  return {
    skill_id: 'sk_1',
    name: '拜访统计',
    description: 'd',
    prompt_template: '按{{人员}}统计拜访次数',
    placeholders: '["人员"]',
    scope: 'USER',
    status: 'ACTIVE',
    created_by: 'alice',
    ...overrides,
  };
}

beforeEach(() => {
  queue.length = 0;
  querySpy.mockClear();
});

describe('extractPlaceholders: 占位符提取', () => {
  it('提取、去重并 trim 占位符', () => {
    expect(extractPlaceholders('按{{人员}}统计{{ 指标 }}与{{人员}}的排名')).toEqual(['人员', '指标']);
  });

  it('无占位符返回空数组', () => {
    expect(extractPlaceholders('统计全部客户')).toEqual([]);
    expect(extractPlaceholders('')).toEqual([]);
  });
});

describe('validateSkillInput: 入参校验', () => {
  it('名称或模板为空拒绝', () => {
    expect(validateSkillInput({ name: '', promptTemplate: 'x' })).toContain('名称');
    expect(validateSkillInput({ name: 'a', promptTemplate: '  ' })).toContain('模板');
  });

  it('超长拒绝', () => {
    expect(validateSkillInput({ name: 'a'.repeat(101), promptTemplate: 'x' })).toContain('名称');
    expect(validateSkillInput({ name: 'a', promptTemplate: 'x'.repeat(1001) })).toContain('模板');
    expect(validateSkillInput({ name: 'a', promptTemplate: 'x', description: 'd'.repeat(501) })).toContain('描述');
  });

  it('合法输入返回 null', () => {
    expect(validateSkillInput({ name: '拜访分析', promptTemplate: '按{{人员}}统计', description: '描述' })).toBeNull();
  });
});

describe('requestShare: 分享申请权限', () => {
  it('非本人技能拒绝（403，仅一次查询）', async () => {
    queue.push([[skillRow({ created_by: 'alice' })], []]);
    const r = await requestShare('bob', 'sk_1');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.status).toBe(403);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('已在审核中拒绝重复申请（400）', async () => {
    queue.push([[skillRow({ status: 'PENDING_SHARE' })], []]);
    const r = await requestShare('alice', 'sk_1');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.status).toBe(400);
  });

  it('本人私有技能置为 PENDING_SHARE', async () => {
    queue.push([[skillRow()], []]);
    queue.push([{ affectedRows: 1 }, []]);
    const r = await requestShare('alice', 'sk_1');
    expect(r.ok).toBe(true);
    const [sql] = querySpy.mock.calls[1];
    expect(sql).toContain('PENDING_SHARE');
  });
});

describe('approveShare: 管理员批准分享', () => {
  it('系统库重名时新技能名追加「（分享）」后缀', async () => {
    // 1. 查原技能 2. 重名计数 3. INSERT 系统副本 4. 原技能恢复 ACTIVE 5. 查新技能
    queue.push([[skillRow({ status: 'PENDING_SHARE' })], []]);
    queue.push([[{ cnt: 1 }], []]);
    queue.push([{ affectedRows: 1 }, []]);
    queue.push([{ affectedRows: 1 }, []]);
    queue.push([[skillRow({ skill_id: 'sk_new', scope: 'SYSTEM', status: 'ACTIVE', name: '拜访统计（分享）' })], []]);
    const r = await approveShare('sk_1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.scope).toBe('SYSTEM');
      expect(r.skill.name).toBe('拜访统计（分享）');
      expect(r.skill.createdBy).toBe('alice');
    }
    const insertCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT'));
    expect(insertCall).toBeTruthy();
    expect(insertCall![1][1]).toBe('拜访统计（分享）');
    expect(insertCall![1][5]).toBe('alice');
  });

  it('非审核中技能返回 400', async () => {
    queue.push([[skillRow({ status: 'ACTIVE' })], []]);
    const r = await approveShare('sk_1');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.status).toBe(400);
  });
});

describe('rejectShare: 管理员拒绝分享', () => {
  it('审核中技能退回 ACTIVE', async () => {
    queue.push([[skillRow({ status: 'PENDING_SHARE' })], []]);
    queue.push([{ affectedRows: 1 }, []]);
    const r = await rejectShare('sk_1');
    expect(r.ok).toBe(true);
    const [sql] = querySpy.mock.calls[1];
    expect(sql).toContain("status = 'ACTIVE'");
  });
});
