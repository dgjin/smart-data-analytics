/**
 * zod 校验基础设施（validate.ts）与 accessRequestsSchema 单测（v0.9.114 P0-2）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  validateBody,
  validateQuery,
  firstIssueMessage,
  nonEmptyString,
  idSchema,
  limitSchema,
} from './validate';
import {
  createAccessRequestSchema,
  decideNoteSchema,
} from '../routes/schemas/accessRequestsSchema';

describe('validateBody / validateQuery', () => {
  const schema = z.object({ name: nonEmptyString(10), age: z.coerce.number().int().min(0) });

  it('合法输入返回 ok:true 与解析后数据', () => {
    const r = validateBody(schema, { name: ' 张三 ', age: '18' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.name).toBe('张三');
      expect(r.data.age).toBe(18);
    }
  });

  it('非法输入返回 ok:false 与首条可读错误（带路径前缀）', () => {
    const r = validateBody(schema, { name: '', age: -1 });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toContain('name');
  });

  it('body 为 undefined 时按空对象处理', () => {
    const r = validateBody(z.object({ a: z.string().optional() }), undefined);
    expect(r.ok).toBe(true);
  });

  it('validateQuery 用 z.coerce 转换字符串 query', () => {
    const r = validateQuery(z.object({ limit: limitSchema }), { limit: '20' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.limit).toBe(20);
  });

  it('limitSchema 超出 200 拒绝', () => {
    const r = validateQuery(z.object({ limit: limitSchema }), { limit: '500' });
    expect(r.ok).toBe(false);
  });
});

describe('firstIssueMessage', () => {
  it('嵌套路径拼接为点分前缀', () => {
    const r = validateBody(z.object({ user: z.object({ id: idSchema }) }), { user: { id: 'abc' } });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error.startsWith('user.id')).toBe(true);
  });

  it('空 issues 兜底文案', () => {
    const err = new z.ZodError([]);
    expect(firstIssueMessage(err)).toBe('请求参数不合法');
  });
});

describe('createAccessRequestSchema', () => {
  it('合法申请通过并去空白', () => {
    const r = validateBody(createAccessRequestSchema, { dataSourceId: ' ds1 ', reason: ' 需要分析 ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dataSourceId).toBe('ds1');
      expect(r.data.reason).toBe('需要分析');
    }
  });

  it('缺 dataSourceId 拒绝', () => {
    const r = validateBody(createAccessRequestSchema, { reason: 'x' });
    expect(r.ok).toBe(false);
  });

  it('reason 全空白拒绝（截断后判空）', () => {
    const r = validateBody(createAccessRequestSchema, { dataSourceId: 'ds1', reason: '   ' });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.error).toContain('请填写申请理由');
  });

  it('reason 超长截断至 500 而非拒绝（对齐原 slice 语义）', () => {
    const long = 'a'.repeat(600);
    const r = validateBody(createAccessRequestSchema, { dataSourceId: 'ds1', reason: long });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.reason).toHaveLength(500);
  });
});

describe('decideNoteSchema', () => {
  it('缺省 note 默认为空串', () => {
    const r = validateBody(decideNoteSchema, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.note).toBe('');
  });

  it('note 超长截断至 300', () => {
    const r = validateBody(decideNoteSchema, { note: 'b'.repeat(400) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.note).toHaveLength(300);
  });
});
