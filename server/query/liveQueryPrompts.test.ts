/**
 * PG/GP 方言提示词契约测试：防止「字符型日期列需显式转型」这条规则被后续改动误删。
 * 背景：宽表 data_dt 为 varchar(10)，直接 EXTRACT(MONTH FROM data_dt) 在 PG/GP 上抛
 * SQLSTATE 42883「function pg_catalog.date_part(unknown, character varying) does not exist」。
 */
import { describe, expect, it } from 'vitest';
import { dialectPromptOf } from './liveQueryPrompts';

describe('dialectPromptOf：方言标签', () => {
  it('greenplum / postgresql 标注 PG 系方言，mysql 无附加规则', () => {
    expect(dialectPromptOf('greenplum').label).toContain('Greenplum');
    expect(dialectPromptOf('postgresql').label).toBe('PostgreSQL');
    expect(dialectPromptOf('mysql').label).toBe('MySQL');
    expect(dialectPromptOf(undefined).label).toBe('MySQL');
  });

  it('greenplum 与 postgresql 共用同一套 PG 规则', () => {
    expect(dialectPromptOf('greenplum').rules).toBe(dialectPromptOf('postgresql').rules);
  });
});

describe('PG 规则：字符型日期列必须显式转型（42883 防线）', () => {
  const rules = dialectPromptOf('greenplum').rules;

  it('点明报错成因与 SQLSTATE，便于模型定向修正', () => {
    expect(rules).toContain('42883');
    expect(rules).toContain('date_part');
    expect(rules).toContain('character varying');
  });

  it('给出 ::date 显式转换的各类写法', () => {
    expect(rules).toContain('EXTRACT(YEAR FROM col::date)');
    expect(rules).toContain("date_trunc('month', col::date)");
    expect(rules).toContain("DATE '2026-01-01'");
  });

  it('覆盖非标准格式与非 yyyy-mm-dd 场景的转换函数', () => {
    expect(rules).toContain('to_date');
    expect(rules).toContain('to_char');
  });

  it('提示先核对 Schema 中的列类型，且已是 date/timestamp 的列不重复转换', () => {
    expect(rules).toContain('columns 数组第 2 项');
    expect(rules).toContain('禁止重复转换');
  });

  it('保留既有方言约束（分页 / 引号 / COALESCE / STRING_AGG）', () => {
    expect(rules).toContain('LIMIT n OFFSET m');
    expect(rules).toContain('双引号');
    expect(rules).toContain('COALESCE');
    expect(rules).toContain('STRING_AGG');
    expect(rules).toContain('禁用 YEAR()/MONTH()/DATE_FORMAT()');
  });

  it('MySQL 不注入 PG 规则（避免方言串味）', () => {
    expect(dialectPromptOf('mysql').rules).toBe('');
  });
});
