/**
 * 回归测试：报表 kpiList 的 change 字段为 null/number/缺省时，
 * 异常扫描与服务端矫正均不得抛错（"Cannot read properties of null (reading 'replace')" 回归）。
 */
import { describe, expect, it } from 'vitest';
import { scanReportForAnomalies } from './anomalyDetector';
import { normalizeReport } from './queryResultNormalizer';
import type { SavedReport } from '../types/analytics';

function makeReport(kpiList: any[]): SavedReport {
  return {
    id: 'r1',
    title: '测试报表',
    summary: '摘要',
    createdAt: '2026-08-11',
    dataSourceId: 'ds1',
    templateType: 'executive',
    insights: [],
    kpiList: kpiList as any,
    charts: [],
  };
}

describe('scanReportForAnomalies: change 字段容错', () => {
  it('change 为 null 时不抛错', () => {
    const report = makeReport([{ label: '营收', value: '100万', change: null, status: 'good' }]);
    expect(() => scanReportForAnomalies(report)).not.toThrow();
  });

  it('change 为 number 时不抛错', () => {
    const report = makeReport([{ label: '营收', value: '100万', change: 12.5, status: 'good' }]);
    expect(() => scanReportForAnomalies(report)).not.toThrow();
  });

  it('change 缺省时不抛错', () => {
    const report = makeReport([{ label: '营收', value: '100万', status: 'good' }]);
    expect(() => scanReportForAnomalies(report)).not.toThrow();
  });

  it('change 为百分比字符串时正常识别异常', () => {
    const report = makeReport([{ label: '营收', value: '100万', change: '+35%', status: 'good' }]);
    const out = scanReportForAnomalies(report);
    expect(out.kpiList[0].isAnomaly).toBe(true);
  });
});

describe('normalizeReport: kpiList 字段矫正', () => {
  const base = { title: 'T', summary: 'S', insights: [], charts: [] };

  it('change 为 null/number 时统一矫正为字符串', () => {
    const out = normalizeReport({
      ...base,
      kpiList: [
        { label: 'A', value: '1', change: null, status: 'good' },
        { label: 'B', value: 200, change: 12.5, status: 'bad' },
      ],
    });
    expect(out).not.toBeNull();
    const list = out!.kpiList as any[];
    expect(list[0].change).toBe('');
    expect(list[1].change).toBe('12.5');
    expect(list[1].value).toBe('200');
  });

  it('label 缺失或非字符串的 KPI 项被丢弃', () => {
    const out = normalizeReport({
      ...base,
      kpiList: [{ value: '1' }, null, { label: '  ', value: '2' }, { label: 'OK', value: '3', change: '+5%', status: 'weird' }],
    });
    const list = out!.kpiList as any[];
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe('OK');
    expect(list[0].status).toBe('neutral');
  });

  it('kpiList 非数组时矫正为空数组', () => {
    const out = normalizeReport({ ...base, kpiList: null });
    expect(out!.kpiList).toEqual([]);
  });
});
