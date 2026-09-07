import { describe, it, expect } from 'vitest';
import { serializeSchemaForPrompt } from './schemaGuidance';

describe('serializeSchemaForPrompt（P1 prompt 瘦身）', () => {
  const schema = [
    {
      id: 't1',
      name: 'visit_records',
      displayName: '拜访记录',
      description: '客户拜访明细',
      rowCount: 12345,
      businessNote: '金额单位为万元',
      columns: [
        { name: 'visitor_name', type: 'string', description: '拜访人', isDimension: true, isMetric: false },
        { name: 'amount', type: 'number', description: '拜访金额 (万元)', isDimension: false, isMetric: true },
        { name: 'seq', type: 'number', isPrimaryKey: true },
      ],
    },
  ];

  it('列为紧凑数组 [列名,类型,中文说明?]，中文说明为空时省略第三项', () => {
    const out = JSON.parse(serializeSchemaForPrompt(schema));
    expect(out[0].columns).toEqual([
      ['visitor_name', 'string', '拜访人'],
      ['amount', 'number', '拜访金额 (万元)'],
      ['seq', 'number'],
    ]);
  });

  it('剔除 prompt 冗余字段（id/rowCount/businessNote/isMetric/isDimension/isPrimaryKey）', () => {
    const raw = serializeSchemaForPrompt(schema);
    const out = JSON.parse(raw);
    expect(out[0]).not.toHaveProperty('id');
    expect(out[0]).not.toHaveProperty('rowCount');
    expect(out[0]).not.toHaveProperty('businessNote');
    expect(raw).not.toContain('isMetric');
    expect(raw).not.toContain('isDimension');
    expect(raw).not.toContain('isPrimaryKey');
    // 保留语义字段
    expect(out[0].name).toBe('visit_records');
    expect(out[0].displayName).toBe('拜访记录');
    expect(out[0].description).toBe('客户拜访明细');
  });

  it('displayName 与 name 相同或缺失时省略', () => {
    const out = JSON.parse(serializeSchemaForPrompt([
      { name: 'a', displayName: 'a', columns: [] },
      { name: 'b', columns: [] },
    ]));
    expect(out[0]).not.toHaveProperty('displayName');
    expect(out[1]).not.toHaveProperty('displayName');
  });

  it('体积显著小于原 JSON 序列化（宽表场景 ≥50%）', () => {
    const wide = [{
      id: 't', name: 'wide_table', rowCount: 999, businessNote: 'note',
      columns: Array.from({ length: 100 }, (_, i) => ({
        name: `col_${i}`, type: 'string', description: `第${i}号业务字段说明`,
        isDimension: true, isMetric: false,
      })),
    }];
    const before = JSON.stringify(wide).length;
    const after = serializeSchemaForPrompt(wide).length;
    expect(after).toBeLessThan(before * 0.5);
  });

  it('空/非法输入返回 []', () => {
    expect(serializeSchemaForPrompt(null)).toBe('[]');
    expect(serializeSchemaForPrompt(undefined)).toBe('[]');
    expect(serializeSchemaForPrompt([])).toBe('[]');
  });
});
