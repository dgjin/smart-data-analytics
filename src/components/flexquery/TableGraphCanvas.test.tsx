/**
 * 表关系画布组件测试（v0.9.79）：图形化卡片渲染（描述优先名/类型徽标/主键标记）、
 * 字段点击添加（主表无前缀 / 关联表带前缀）、搜索过滤、表库点击与拖拽建立关联、
 * 连接符类型切换、关联字段内联编辑与移除（受控状态生效）。
 * @vitest-environment jsdom
 */
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEX_TABLE_MIME, TableGraphCanvas } from './TableGraphCanvas';
import { TableSchema } from '../../types/analytics';
import { FlexJoin } from '../../utils/flexQueryBuilder';

const MAIN: TableSchema = {
  id: 't1',
  name: 'orders',
  displayName: '订单表',
  description: '',
  rowCount: 1000,
  columns: [
    { name: 'order_id', type: 'number', isPrimaryKey: true, description: '订单号' },
    { name: 'customer_id', type: 'number' },
    { name: 'biz_date', type: 'date', description: '业务日期' },
  ],
};

const DIM: TableSchema = {
  id: 't2',
  name: 'dim_customer',
  displayName: '客户维表',
  description: '',
  rowCount: 50,
  columns: [
    { name: 'customer_id', type: 'number', isPrimaryKey: true },
    { name: 'customer_name', type: 'string', description: '客户名称' },
  ],
};

const JOIN: FlexJoin = { table: 'dim_customer', type: 'INNER', on: { left: 'customer_id', right: 'customer_id' } };

/** 受控包装：joins 状态真实联动，验证画布交互后的 UI 变化 */
function setup(opts?: { joins?: FlexJoin[]; fieldSearch?: string }) {
  const addField = vi.fn();
  const addJoinByTable = vi.fn();
  const Harness: React.FC = () => {
    const [joins, setJoins] = useState<FlexJoin[]>(opts?.joins || []);
    return (
      <TableGraphCanvas
        tables={[MAIN, DIM]}
        tableSchema={MAIN}
        selectedTable="orders"
        joins={joins}
        setJoins={setJoins}
        usedColumns={new Set(['order_id'])}
        fieldSearch={opts?.fieldSearch || ''}
        addField={addField}
        addJoinByTable={addJoinByTable}
      />
    );
  };
  render(<Harness />);
  return { addField, addJoinByTable };
}

afterEach(cleanup);

describe('TableGraphCanvas: 表关系画布（v0.9.79）', () => {
  it('主表卡片图形化渲染：表名/主键与类型徽标/描述优先名/已用标记', () => {
    setup();
    expect(screen.getByText('订单表')).toBeTruthy();
    expect(screen.getByText('订单号')).toBeTruthy();
    expect(screen.getByText('customer_id')).toBeTruthy();
    expect(screen.getByLabelText('主键')).toBeTruthy();
    expect(screen.getByLabelText('日期')).toBeTruthy();
    expect(screen.getAllByLabelText('数值').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('已使用')).toBeTruthy();
    // 表库仅列出未加入的表
    expect(screen.getByTitle('拖入画布或点击添加关联：客户维表')).toBeTruthy();
  });

  it('点击字段行按 fullName 添加（主表无前缀）', () => {
    const { addField } = setup();
    fireEvent.click(screen.getByText('订单号'));
    expect(addField).toHaveBeenCalledWith('order_id');
  });

  it('关联表字段带表前缀 fullName，连接符展示 ON 条件', () => {
    const { addField } = setup({ joins: [JOIN] });
    expect(screen.getByText('客户维表')).toBeTruthy();
    fireEvent.click(screen.getByText('客户名称'));
    expect(addField).toHaveBeenCalledWith('dim_customer.customer_name');
    expect(screen.getByText(/ON customer_id = customer_id/)).toBeTruthy();
    // 已加入画布的表不再出现在表库
    expect(screen.queryByTitle('拖入画布或点击添加关联：客户维表')).toBeNull();
  });

  it('字段搜索过滤（拼音首字母）并显示无匹配占位', () => {
    setup({ fieldSearch: 'ywrq' });
    expect(screen.getByText('业务日期')).toBeTruthy();
    expect(screen.queryByText('订单号')).toBeNull();
  });

  it('表库点击建立关联（回调携带表名）', () => {
    const { addJoinByTable } = setup();
    fireEvent.click(screen.getByTitle('拖入画布或点击添加关联：客户维表'));
    expect(addJoinByTable).toHaveBeenCalledWith('dim_customer');
  });

  it('拖表入画布触发关联回调（自定义 MIME + 拖拽悬停放行）', () => {
    const { addJoinByTable } = setup();
    const chip = screen.getByTitle('拖入画布或点击添加关联：客户维表');
    const store: Record<string, string> = {};
    const dt = {
      get types() {
        return Object.keys(store);
      },
      setData: (type: string, val: string) => {
        store[type] = val;
      },
      getData: (type: string) => store[type] || '',
      effectAllowed: '',
    };
    fireEvent.dragStart(chip, { dataTransfer: dt });
    expect(store[FLEX_TABLE_MIME]).toBe('dim_customer');
    // 拖拽中空态提示切换为落点提示
    expect(screen.getByText('松开即添加为关联表')).toBeTruthy();
    const canvas = screen.getByTestId('flexquery-graph-canvas');
    fireEvent.dragOver(canvas, { dataTransfer: dt });
    expect(screen.getByText('松开即添加为关联表').className).toContain('border-indigo-400');
    fireEvent.drop(canvas, { dataTransfer: dt });
    expect(addJoinByTable).toHaveBeenCalledWith('dim_customer');
    // 落库即清空拖拽态：chip 卸载后 dragend 不触发也不残留（文案与高亮回落常规空态）
    expect(screen.getByText('把表库中的表拖到此处建立关联').className).not.toContain('border-indigo-400');
  });

  it('字段拖拽（text/plain）经过画布不触发关联落点与高亮', () => {
    const { addJoinByTable } = setup();
    const canvas = screen.getByTestId('flexquery-graph-canvas');
    const fieldDt = {
      types: ['text/plain'],
      getData: (t: string) => (t === 'text/plain' ? 'customer_id' : ''),
    };
    fireEvent.dragOver(canvas, { dataTransfer: fieldDt });
    expect(screen.getByText('把表库中的表拖到此处建立关联').className).not.toContain('border-indigo-400');
    fireEvent.drop(canvas, { dataTransfer: fieldDt });
    expect(addJoinByTable).not.toHaveBeenCalled();
  });

  it('连接符切换 JOIN 类型生效（受控状态）', () => {
    setup({ joins: [JOIN] });
    const typeSelect = screen.getByTitle('JOIN 类型') as HTMLSelectElement;
    expect(typeSelect.value).toBe('INNER');
    fireEvent.change(typeSelect, { target: { value: 'LEFT' } });
    expect((screen.getByTitle('JOIN 类型') as HTMLSelectElement).value).toBe('LEFT');
  });

  it('连接条件点击展开内联编辑并更新关联字段', () => {
    setup({ joins: [JOIN] });
    fireEvent.click(screen.getByTitle('点击编辑关联字段'));
    fireEvent.change(screen.getByTitle('主表侧关联字段'), { target: { value: 'order_id' } });
    fireEvent.click(screen.getByText('完成'));
    expect(screen.getByText(/ON order_id = customer_id/)).toBeTruthy();
  });

  it('移除连接符后关联表卡片消失并回落空态占位', () => {
    setup({ joins: [JOIN] });
    fireEvent.click(screen.getByText('移除'));
    // 连接符与关联表卡片消失（ON 条件按钮 / JOIN 类型下拉均不在）
    expect(screen.queryByTitle('点击编辑关联字段')).toBeNull();
    expect(screen.queryByTitle('JOIN 类型')).toBeNull();
    expect(screen.getByText('把表库中的表拖到此处建立关联')).toBeTruthy();
    // 移除后该表回到表库可再次添加（画布卡片消失，仅剩表库 chip 一处名称）
    expect(screen.getByTitle('拖入画布或点击添加关联：客户维表')).toBeTruthy();
    expect(screen.getAllByText('客户维表')).toHaveLength(1);
  });
});
