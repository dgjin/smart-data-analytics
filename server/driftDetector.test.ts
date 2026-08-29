/**
 * P3-3 知识库漂移检测单元测试：diffValues 比对 / discoverEnumColumns 自动发现 / IDENT_RE 标识符校验。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ getPool: vi.fn() }));
vi.mock('./sqlExecutor', () => ({ executeSafeSql: vi.fn() }));

import { diffValues, discoverEnumColumns, IDENT_RE, MAX_ENUM_CARDINALITY } from './driftDetector';

describe('diffValues: 取值快照比对', () => {
  it('基线为 null（未建基线）→ 不产生事件', () => {
    expect(diffValues(null, ['A', 'B'])).toBeNull();
    expect(diffValues(null, [])).toBeNull();
  });

  it('基线与现值完全一致 → 不产生事件', () => {
    expect(diffValues(['A', 'B'], ['A', 'B'])).toBeNull();
    expect(diffValues([], [])).toBeNull();
  });

  it('新增取值 → added 记录新增项', () => {
    expect(diffValues(['A'], ['A', 'B', 'C'])).toEqual({ added: ['B', 'C'], removed: [] });
  });

  it('消失取值 → removed 记录消失项', () => {
    expect(diffValues(['A', 'B'], ['A'])).toEqual({ added: [], removed: ['B'] });
  });

  it('同时新增与消失 → added/removed 双侧记录', () => {
    expect(diffValues(['A', 'B'], ['B', 'C'])).toEqual({ added: ['C'], removed: ['A'] });
  });

  it('顺序不同但集合相同 → 不产生事件', () => {
    expect(diffValues(['B', 'A'], ['A', 'B'])).toBeNull();
  });
});

describe('discoverEnumColumns: 自动发现候选枚举列', () => {
  const schema = [
    {
      name: 'fct_demo',
      columns: [
        { name: 'YWFL', type: 'string', description: '业务分类' },
        { name: 'JGMC', type: 'string', description: '机构名称' }, // 名称类 → 排除
        { name: 'XMBH', type: 'string', description: '项目编号' }, // 编号类（名称+后缀 BH）→ 排除
        { name: 'BBRQ', type: 'string', description: '报表日期' }, // 日期类 → 排除
        { name: 'LJTFJE', type: 'number', description: '累计金额' }, // 非字符串 → 排除
        { name: 'SFYQ', type: 'string', description: '是否逾期' },
      ],
    },
    {
      name: 'bad table;', // 非法表名 → 整表跳过
      columns: [{ name: 'C1', type: 'string', description: '分类' }],
    },
  ];

  it('仅保留字符串类型且非编号/名称/日期类的列', () => {
    const out = discoverEnumColumns(schema);
    expect(out).toContainEqual({ table: 'fct_demo', column: 'YWFL' });
    expect(out).toContainEqual({ table: 'fct_demo', column: 'SFYQ' });
    expect(out).toHaveLength(2);
  });

  it('非法表名整表跳过', () => {
    const out = discoverEnumColumns(schema);
    expect(out.find((c) => c.table === 'bad table;')).toBeUndefined();
  });

  it('空输入 → 空结果', () => {
    expect(discoverEnumColumns([])).toEqual([]);
    expect(discoverEnumColumns(undefined as any)).toEqual([]);
  });
});

describe('IDENT_RE: 标识符安全校验', () => {
  it('合法标识符通过', () => {
    expect(IDENT_RE.test('fct_jc_main_biz_stat')).toBe(true);
    expect(IDENT_RE.test('YWFL')).toBe(true);
    expect(IDENT_RE.test('_x1')).toBe(true);
  });

  it('注入特征/超长/数字开头被拒绝', () => {
    expect(IDENT_RE.test('t;DROP')).toBe(false);
    expect(IDENT_RE.test('a b')).toBe(false);
    expect(IDENT_RE.test('1abc')).toBe(false);
    expect(IDENT_RE.test('')).toBe(false);
    expect(IDENT_RE.test('x'.repeat(65))).toBe(false);
  });

  it('低基数判定上限为 50', () => {
    expect(MAX_ENUM_CARDINALITY).toBe(50);
  });
});
