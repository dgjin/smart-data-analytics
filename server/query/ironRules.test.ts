/**
 * 铁律规则库（v0.9.35）单测：
 * sanitize 入参校验 / 全量恒注入 prompt 构建 / CRUD（同标题唯一 + 每源上限）/ 导入导出（skip/overwrite/dryRun）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// 队列式 mock：按 SQL 调用顺序返回预设 [rows, fields]（与 metrics.test.ts 同模式）
const queue: any[] = [];
const querySpy = vi.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('ironRules.test: 队列为空，SQL 调用次数超出预期');
  return next;
});
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));

import {
  sanitizeIronRuleInput,
  buildIronRulesPrompt,
  listIronRules,
  loadActiveIronRules,
  createIronRule,
  updateIronRule,
  deleteIronRule,
  buildIronRulesExport,
  importIronRules,
  IronRule,
} from './ironRules';

const validInput = { dataSourceId: 'ds1', title: '禁止跨法人统计', content: '任何统计必须限定单一法人机构' };

beforeEach(() => {
  queue.length = 0;
  querySpy.mockClear();
});

describe('sanitizeIronRuleInput: 入参校验', () => {
  it('合法输入通过；status 缺省/非法归一 ACTIVE，DISABLED 透传', () => {
    const r = sanitizeIronRuleInput(validInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rule.status).toBe('ACTIVE');
    const d = sanitizeIronRuleInput({ ...validInput, status: 'DISABLED' });
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.rule.status).toBe('DISABLED');
    const x = sanitizeIronRuleInput({ ...validInput, status: 'PENDING' });
    expect(x.ok).toBe(true);
    if (x.ok) expect(x.rule.status).toBe('ACTIVE'); // 铁律无治理状态机，外部直填被忽略
  });

  it('必填缺失与超长拒绝；首尾空白被 trim', () => {
    expect(sanitizeIronRuleInput({ ...validInput, dataSourceId: '' }).ok).toBe(false);
    expect(sanitizeIronRuleInput({ ...validInput, title: '' }).ok).toBe(false);
    expect(sanitizeIronRuleInput({ ...validInput, title: 'x'.repeat(101) }).ok).toBe(false);
    expect(sanitizeIronRuleInput({ ...validInput, content: '' }).ok).toBe(false);
    expect(sanitizeIronRuleInput({ ...validInput, content: 'x'.repeat(2001) }).ok).toBe(false);
    const t = sanitizeIronRuleInput({ ...validInput, title: '  标题  ', content: '  正文  ' });
    expect(t.ok).toBe(true);
    if (t.ok) {
      expect(t.rule.title).toBe('标题');
      expect(t.rule.content).toBe('正文');
    }
  });
});

describe('buildIronRulesPrompt: 全量恒注入 prompt 段', () => {
  it('空规则返回空串；非空含最高优先级强指令与逐条标题正文', () => {
    expect(buildIronRulesPrompt([])).toBe('');
    const rules: IronRule[] = [
      { dataSourceId: 'ds1', title: '禁止跨法人统计', content: '任何统计必须限定单一法人机构', status: 'ACTIVE' },
      { dataSourceId: 'ds1', title: '只用最新一期', content: 'BBRQ 必须取 MAX(BBRQ)', status: 'ACTIVE' },
    ];
    const prompt = buildIronRulesPrompt(rules);
    expect(prompt).toContain('【铁律规则】');
    expect(prompt).toContain('最高优先级');
    expect(prompt).toContain('- 【禁止跨法人统计】任何统计必须限定单一法人机构');
    expect(prompt).toContain('- 【只用最新一期】BBRQ 必须取 MAX(BBRQ)');
  });
});

describe('CRUD', () => {
  it('listIronRules 按数据源过滤且按创建顺序（与注入顺序一致）', async () => {
    queue.push([[{ id: 1, data_source_id: 'ds1', title: 't1', content: 'c1', status: 'DISABLED', created_by: 'admin' }]]);
    const list = await listIronRules('ds1');
    expect(String(querySpy.mock.calls[0][0])).toContain('ORDER BY id ASC');
    expect(querySpy.mock.calls[0][1][0]).toBe('ds1');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 1, title: 't1', content: 'c1', status: 'DISABLED', createdBy: 'admin' });
  });

  it('loadActiveIronRules 仅取 ACTIVE（停用规则不进问数注入）', async () => {
    queue.push([[]]);
    await loadActiveIronRules('ds1');
    expect(String(querySpy.mock.calls[0][0])).toContain("status = 'ACTIVE'");
  });

  it('createIronRule：同标题冲突拒绝；正常创建参数序正确', async () => {
    // 冲突
    queue.push([[{ id: 1 }]]);
    const dup = await createIronRule({ ...validInput, status: 'ACTIVE' }, 'admin');
    expect(dup.ok).toBe(false);

    // 正常：dup 空 → count 0 → INSERT（同一用例内累计调用序：冲突 dup(0) → dup(1) → count(2) → INSERT(3)）
    queue.push([[]], [[{ c: 0 }]], [{ insertId: 9 }]);
    const r = await createIronRule({ ...validInput, status: 'ACTIVE' }, 'admin');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe(9);
    const insertCall = querySpy.mock.calls[3];
    expect(String(insertCall[0])).toContain('INSERT INTO iron_rules');
    expect(insertCall[1]).toEqual(['ds1', '禁止跨法人统计', '任何统计必须限定单一法人机构', 'ACTIVE', 'admin']);
  });

  it('createIronRule：达到每源上限（100 条）拒绝', async () => {
    queue.push([[]], [[{ c: 100 }]]);
    const r = await createIronRule({ ...validInput, status: 'ACTIVE' }, 'admin');
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toContain('100');
  });

  it('updateIronRule：不存在 404 语义；同标题冲突（排除自身）拒绝；正常更新', async () => {
    // 不存在
    queue.push([[]]);
    const nf = await updateIronRule(7, { title: 't', content: 'c', status: 'ACTIVE' });
    expect(nf.ok).toBe(false);
    if (nf.ok === false) expect(nf.notFound).toBe(true);

    // 同标题冲突（另一条记录占用）
    queue.push([[{ data_source_id: 'ds1' }]], [[{ id: 8 }]]);
    const dup = await updateIronRule(7, { title: 't', content: 'c', status: 'ACTIVE' });
    expect(dup.ok).toBe(false);

    // 正常：现有 ds1 → dup 空 → UPDATE（同一用例内累计调用序：existing(3) → dup(4) → UPDATE(5)）
    queue.push([[{ data_source_id: 'ds1' }]], [[]], [{}]);
    const ok = await updateIronRule(7, { title: '新标题', content: '新正文', status: 'DISABLED' });
    expect(ok.ok).toBe(true);
    const updateCall = querySpy.mock.calls[5];
    expect(String(updateCall[0])).toContain('UPDATE iron_rules');
    expect(updateCall[1]).toEqual(['新标题', '新正文', 'DISABLED', 7]);
  });

  it('deleteIronRule：按 affectedRows 返回是否删除成功', async () => {
    queue.push([{ affectedRows: 1 }]);
    expect(await deleteIronRule(7)).toBe(true);
    queue.push([{ affectedRows: 0 }]);
    expect(await deleteIronRule(99)).toBe(false);
  });
});

describe('buildIronRulesExport: 导出文件组装', () => {
  it('剥离库内 id/创建痕迹，type=iron-rules', () => {
    const rule: IronRule = { id: 3, dataSourceId: 'ds1', title: 't', content: 'c', status: 'DISABLED', createdBy: 'admin' };
    const file = buildIronRulesExport('ds1', '业务库', [rule], 'admin');
    expect(file.version).toBe('1.0');
    expect(file.type).toBe('iron-rules');
    expect(file.ruleCount).toBe(1);
    expect(file.exportedBy).toBe('admin');
    expect(file.dataSourceName).toBe('业务库');
    expect(file.rules[0]).toEqual({ title: 't', content: 'c', status: 'DISABLED' });
    expect((file.rules[0] as any).id).toBeUndefined();
    expect((file.rules[0] as any).createdBy).toBeUndefined();
  });
});

describe('importIronRules: 备份导入', () => {
  const newItem = { title: '新铁律', content: '新内容', status: 'ACTIVE' };

  it('skip 策略：同标题跳过、新规则创建', async () => {
    queue.push(
      [[{ id: 1, title: '禁止跨法人统计' }]], // 现有标题
      [[]],                                    // createIronRule dup 检查
      [[{ c: 0 }]],                            // 条数上限检查
      [{ insertId: 42 }],                      // INSERT
    );
    const r = await importIronRules('ds1', [{ ...validInput, dataSourceId: undefined }, newItem], 'skip', false, 'admin');
    expect(r.success).toBe(true);
    expect(r.skippedCount).toBe(1);
    expect(r.importedCount).toBe(1);
    expect(r.summary).toEqual({ totalItems: 2, newItems: 1, conflictItems: 1, invalidItems: 0 });
    expect(querySpy).toHaveBeenCalledTimes(4);
  });

  it('overwrite 策略：同标题覆盖更新', async () => {
    queue.push(
      [[{ id: 7, title: '禁止跨法人统计' }]], // 现有标题
      [[{ data_source_id: 'ds1' }]],           // updateIronRule 读取现有
      [[]],                                    // dup 检查（排除自身）
      [{}],                                    // UPDATE
    );
    const r = await importIronRules('ds1', [{ title: '禁止跨法人统计', content: '更新后的正文', status: 'ACTIVE' }], 'overwrite', false, 'admin');
    expect(r.updatedCount).toBe(1);
    expect(r.importedCount).toBe(0);
    expect(String(querySpy.mock.calls[3][0])).toContain('UPDATE iron_rules');
    expect(querySpy.mock.calls[3][1][1]).toBe('更新后的正文');
  });

  it('dryRun 仅统计不写库（只有初始 SELECT）', async () => {
    queue.push([[]]);
    const r = await importIronRules('ds1', [newItem], 'skip', true, 'admin');
    expect(r.dryRun).toBe(true);
    expect(r.importedCount).toBe(1);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('非法条目被拒绝并计入错误（不触发写库）', async () => {
    queue.push([[]]);
    const r = await importIronRules('ds1', [{ title: '', content: 'c' }], 'skip', false, 'admin');
    expect(r.success).toBe(false);
    expect(r.errorCount).toBe(1);
    expect(r.summary.invalidItems).toBe(1);
    expect(r.errors[0].title).toBe('(无标题)');
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('文件内部同标题：首条入库后，后续同标题条目按冲突策略处理', async () => {
    queue.push(
      [[]],               // 库内无现有规则
      [[]],               // createIronRule dup 检查
      [[{ c: 0 }]],       // 条数检查
      [{ insertId: 5 }],  // INSERT
    );
    const r = await importIronRules('ds1', [newItem, { ...newItem }], 'skip', false, 'admin');
    expect(r.importedCount).toBe(1);
    expect(r.skippedCount).toBe(1);
    expect(r.summary.conflictItems).toBe(1);
    expect(querySpy).toHaveBeenCalledTimes(4);
  });

  it('DISABLED 状态透传导入（停用的规则备份恢复后仍停用）', async () => {
    queue.push(
      [[]],
      [[]],
      [[{ c: 0 }]],
      [{ insertId: 9 }],
    );
    const r = await importIronRules('ds1', [{ ...newItem, status: 'DISABLED' }], 'skip', false, 'admin');
    expect(r.importedCount).toBe(1);
    // INSERT 参数序：data_source_id, title, content, status, created_by
    expect(querySpy.mock.calls[3][1][3]).toBe('DISABLED');
  });
});
