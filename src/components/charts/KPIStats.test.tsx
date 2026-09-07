/**
 * 图表 · KPI 指标卡组件测试：空态不渲染、趋势符号与数值格式化、subtext 展示。
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KPIStats } from './KPIStats';

afterEach(cleanup);

describe('KPIStats', () => {
  it('metrics 为空数组/缺省时不渲染任何内容', () => {
    const { container: c1 } = render(<KPIStats metrics={[]} />);
    expect(c1.firstChild).toBeNull();
    // 运行时防御验证（LLM 数据可能缺字段）；undefined as never 双档 tsc 兼容（主档无 strictNullChecks）
    const { container: c2 } = render(<KPIStats metrics={undefined as never} />);
    expect(c2.firstChild).toBeNull();
  });

  it('渲染 label 与字符串 value 原样展示', () => {
    render(<KPIStats metrics={[{ label: '贷款余额', value: '12.5 亿' }]} />);
    expect(screen.getByText('贷款余额')).toBeTruthy();
    expect(screen.getByText('12.5 亿')).toBeTruthy();
  });

  it('数值型 value 千分位格式化（整数不补零，非整数两位小数）', () => {
    render(
      <KPIStats
        metrics={[
          { label: '总额', value: 1234567 },
          { label: '比率', value: 3.5 },
        ]}
      />
    );
    expect(screen.getByText('1,234,567')).toBeTruthy();
    expect(screen.getByText('3.50')).toBeTruthy();
  });

  it('正增长显示 +% 前缀，负增长直接显示 -%', () => {
    render(
      <KPIStats
        metrics={[
          { label: 'A', value: 1, change: 5.2, trend: 'up' },
          { label: 'B', value: 2, change: -3.1, trend: 'down' },
        ]}
      />
    );
    expect(screen.getByText('+5.2%')).toBeTruthy();
    expect(screen.getByText('-3.1%')).toBeTruthy();
  });

  it('change 为 0 时显示 0%（非正非负中性样式）', () => {
    render(<KPIStats metrics={[{ label: 'C', value: 1, change: 0, trend: 'neutral' }]} />);
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('subtext 存在时渲染，缺省时不渲染', () => {
    render(
      <KPIStats
        metrics={[
          { label: '有脚注', value: 1, subtext: '均值 8.2' },
          { label: '无脚注', value: 2 },
        ]}
      />
    );
    expect(screen.getByText('均值 8.2')).toBeTruthy();
  });
});
