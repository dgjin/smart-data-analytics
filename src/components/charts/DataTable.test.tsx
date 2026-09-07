/**
 * 图表 · 明细数据表组件测试：空态、中文表头映射、搜索过滤、排序切换、分页与数值格式化。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataTable } from './DataTable';

vi.mock('../../hooks/useAnalyticsStore', () => ({
  useAnalyticsStore: (selector: (s: { activeDataSourceId: string | null }) => unknown) =>
    selector({ activeDataSourceId: 'ds_1' }),
}));
vi.mock('../../utils/exportCsv', () => ({
  downloadServerCsv: vi.fn(async () => ({ message: '导出成功' })),
}));

const ROWS = [
  { branch: '城东支行', amount: 300, rate: 2.5 },
  { branch: '城西支行', amount: 100, rate: 1.8 },
  { branch: '城南支行', amount: 200, rate: 3.2 },
];
const COLUMN_NAMES = { branch: '网点', amount: '金额', rate: '比率' };

/** 取 tbody 当前页所有行的首列文本 */
function firstColumnTexts(): string[] {
  const tbody = document.querySelector('tbody');
  if (!tbody) return [];
  return Array.from(tbody.querySelectorAll('tr')).map((tr) => tr.querySelector('td')?.textContent || '');
}

afterEach(cleanup);

describe('DataTable', () => {
  it('空数据显示空态文案', () => {
    render(<DataTable data={[]} />);
    expect(screen.getByText('无结果明细数据')).toBeTruthy();
  });

  it('渲染中文表头映射与数据行，计数徽章显示总条数', () => {
    render(<DataTable data={ROWS} columnNames={COLUMN_NAMES} />);
    expect(screen.getByText('网点')).toBeTruthy();
    expect(screen.getByText('金额')).toBeTruthy();
    expect(screen.getByText('共 3 条')).toBeTruthy();
    expect(screen.getByText('城东支行')).toBeTruthy();
  });

  it('搜索过滤命中任意列，并重置到第 1 页', () => {
    render(<DataTable data={ROWS} columnNames={COLUMN_NAMES} />);
    fireEvent.change(screen.getByPlaceholderText('搜索表格内容...'), { target: { value: '城南' } });
    expect(screen.getByText('共 1 条')).toBeTruthy();
    expect(screen.getByText('城南支行')).toBeTruthy();
    expect(screen.queryByText('城东支行')).toBeNull();
  });

  it('点击列头切换 升序→降序→取消排序', () => {
    render(<DataTable data={ROWS} columnNames={COLUMN_NAMES} />);
    const header = screen.getByText('金额');

    fireEvent.click(header); // 升序
    expect(firstColumnTexts()).toEqual(['城西支行', '城南支行', '城东支行']);

    fireEvent.click(header); // 降序
    expect(firstColumnTexts()).toEqual(['城东支行', '城南支行', '城西支行']);

    fireEvent.click(header); // 取消排序，恢复原始顺序
    expect(firstColumnTexts()).toEqual(['城东支行', '城西支行', '城南支行']);
  });

  it('pageSize 分页与翻页', () => {
    render(<DataTable data={ROWS} columnNames={COLUMN_NAMES} pageSize={2} />);
    expect(screen.getByText('第 1 - 2 条，共 3 条')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.queryByText('城南支行')).toBeNull();

    const pagination = screen.getByText('1 / 2').parentElement!;
    const nextBtn = within(pagination as HTMLElement).getAllByRole('button')[1];
    fireEvent.click(nextBtn);
    expect(screen.getByText('第 3 - 3 条，共 3 条')).toBeTruthy();
    expect(screen.getByText('城南支行')).toBeTruthy();
    expect(screen.queryByText('城东支行')).toBeNull();
  });

  it('数值单元格千分位格式化，null 显示为 -', () => {
    render(
      <DataTable
        data={[{ name: 'A', total: 1234567, memo: null }]}
        columns={['name', 'total', 'memo']}
      />
    );
    expect(screen.getByText('1,234,567')).toBeTruthy();
    expect(screen.getByText('-')).toBeTruthy();
  });

  it('导出按钮触发服务端 CSV 通道并展示结果提示', async () => {
    const { downloadServerCsv } = await import('../../utils/exportCsv');
    render(<DataTable data={ROWS} columnNames={COLUMN_NAMES} title="测试表" />);
    fireEvent.click(screen.getByText('导出 CSV'));
    expect(await screen.findByText('导出成功')).toBeTruthy();
    expect(vi.mocked(downloadServerCsv)).toHaveBeenCalledWith(
      expect.objectContaining({ title: '测试表', dataSourceId: 'ds_1', columns: ['branch', 'amount', 'rate'] })
    );
  });
});
