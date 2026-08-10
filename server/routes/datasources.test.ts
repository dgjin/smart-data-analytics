import { describe, expect, it } from 'vitest';
import { deriveColumnRole, mapMysqlType } from './datasources';

describe('mapMysqlType', () => {
  it('整型与浮点映射为 number', () => {
    for (const t of ['tinyint', 'int', 'bigint', 'decimal', 'double']) {
      expect(mapMysqlType(t)).toBe('number');
    }
  });

  it('日期时间映射为 date', () => {
    for (const t of ['date', 'datetime', 'timestamp', 'time']) {
      expect(mapMysqlType(t)).toBe('date');
    }
  });

  it('枚举/集合映射为 category，布尔映射为 boolean', () => {
    expect(mapMysqlType('enum')).toBe('category');
    expect(mapMysqlType('set')).toBe('category');
    expect(mapMysqlType('bool')).toBe('boolean');
  });

  it('其余类型回落为 string', () => {
    expect(mapMysqlType('varchar')).toBe('string');
    expect(mapMysqlType('text')).toBe('string');
    expect(mapMysqlType('json')).toBe('string');
  });
});

describe('deriveColumnRole', () => {
  it('主键不参与指标与维度', () => {
    expect(deriveColumnRole('id', 'number', true, 'bigint', null)).toEqual({ isMetric: false, isDimension: false });
  });

  it('id 形态列（id / *_id / *Id）不参与指标与维度', () => {
    expect(deriveColumnRole('id', 'number', false, 'bigint', null)).toEqual({ isMetric: false, isDimension: false });
    expect(deriveColumnRole('user_id', 'string', false, 'varchar', 64)).toEqual({ isMetric: false, isDimension: false });
    expect(deriveColumnRole('parentId', 'string', false, 'varchar', 64)).toEqual({ isMetric: false, isDimension: false });
  });

  it('普通数值列推导为指标', () => {
    expect(deriveColumnRole('revenue', 'number', false, 'decimal', null)).toEqual({ isMetric: true, isDimension: false });
    expect(deriveColumnRole('amount', 'number', false, 'double', null)).toEqual({ isMetric: true, isDimension: false });
  });

  it('日期/枚举/布尔列推导为维度', () => {
    expect(deriveColumnRole('created_at', 'date', false, 'datetime', null)).toEqual({ isMetric: false, isDimension: true });
    expect(deriveColumnRole('status', 'category', false, 'enum', null)).toEqual({ isMetric: false, isDimension: true });
    expect(deriveColumnRole('is_active', 'boolean', false, 'tinyint', null)).toEqual({ isMetric: false, isDimension: true });
  });

  it('短字符串列推导为维度', () => {
    expect(deriveColumnRole('name', 'string', false, 'varchar', 64)).toEqual({ isMetric: false, isDimension: true });
    expect(deriveColumnRole('region', 'string', false, 'varchar', 32)).toEqual({ isMetric: false, isDimension: true });
  });

  it('长文本与 JSON/BLOB 不参与指标与维度', () => {
    for (const raw of ['text', 'tinytext', 'mediumtext', 'longtext', 'json', 'blob']) {
      expect(deriveColumnRole('detail', 'string', false, raw, null)).toEqual({ isMetric: false, isDimension: false });
    }
    expect(deriveColumnRole('remark', 'string', false, 'varchar', 255)).toEqual({ isMetric: false, isDimension: false });
  });

  it('普通业务字符串列名不受 id 规则误伤', () => {
    expect(deriveColumnRole('identity_type', 'string', false, 'varchar', 32)).toEqual({ isMetric: false, isDimension: true });
    expect(deriveColumnRole('valid', 'string', false, 'varchar', 8)).toEqual({ isMetric: false, isDimension: true });
  });
});
