/**
 * 系统管理 · 业务本体面板测试（v0.9.111 易用性）：
 * 实体检索与未绑定筛选、绑定脏标记与整组保存、批量粘贴解析预览、
 * 层级可视化编辑、概览计数卡切 Tab、行内停用、版本快照可读摘要。
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OntologyPanel } from './OntologyPanel';
import { apiFetch } from '../../api/client';

vi.mock('../../api/client', () => ({ apiFetch: vi.fn() }));

vi.mock('../../hooks/useAnalyticsStore', () => ({
  useAnalyticsStore: (selector: (s: unknown) => unknown) =>
    selector({
      dataSources: [
        {
          id: 'ds1',
          name: '测试数据源',
          tables: [{ name: 'JGXX', columns: [{ name: 'JGMC' }, { name: 'BB' }] }],
        },
      ],
    }),
}));

const mockedApiFetch = vi.mocked(apiFetch);

const entityRows = [
  {
    id: 1,
    dataSourceId: 'ds1',
    name: '机构',
    entityType: 'SUBJECT',
    aliases: ['JGMC'],
    description: '机构主数据',
    status: 'ACTIVE',
    version: 2,
    bindings: [{ id: 10, entityId: 1, dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'JGMC', role: 'IDENTITY' }],
  },
  {
    id: 2,
    dataSourceId: 'ds1',
    name: '客户',
    entityType: 'OBJECT',
    aliases: [],
    description: '',
    status: 'DISABLED',
    version: 1,
    bindings: [],
  },
];

const valueNoteRows = [
  { id: 5, dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'BB', valueCode: '1', meaning: '本期', status: 'ACTIVE' },
];

const hierarchyRows = [
  { id: 7, dataSourceId: 'ds1', name: '机构层级', levels: ['集团', '分公司', '项目'], status: 'ACTIVE', version: 1 },
];

const versionRows = [
  {
    version: 2,
    action: 'UPDATE',
    actor: 'admin',
    createdAt: '2026-10-20 10:00:00',
    snapshot: { name: '机构', entityType: 'SUBJECT', aliases: ['JGMC'], description: '机构主数据', status: 'ACTIVE' },
  },
  {
    version: 1,
    action: 'CREATE',
    actor: 'admin',
    createdAt: '2026-10-19 10:00:00',
    snapshot: { name: '机构', entityType: 'SUBJECT', aliases: ['JGMC'], status: 'ACTIVE' },
  },
];

/** 按 URL + method 分流：版本 / 概览 / 值域 / 关系 / 层级 / 实体（GET 列表、PUT 绑定与停用） */
function mockRoutes() {
  mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method || 'GET';
    const reply = (data: unknown) => ({ ok: true, json: async () => data }) as unknown as Response;

    if (u.includes('/versions')) return reply({ versions: versionRows });
    if (u.includes('/api/ontology/summary')) {
      return reply({ summary: { entities: 2, bindings: 1, valueNotes: 1, relations: 0, hierarchies: 1 } });
    }
    if (u.includes('/api/ontology/value-notes')) return reply({ valueNotes: valueNoteRows });
    if (u.includes('/api/ontology/relations')) return reply({ relations: [] });
    if (u.includes('/api/ontology/hierarchies')) return reply({ hierarchies: hierarchyRows });
    if (u.includes('/api/ontology/entities')) {
      if (method === 'PUT') return reply({ ok: true, count: 1 });
      return reply({ entities: entityRows });
    }
    return reply({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRoutes();
});

afterEach(cleanup);

describe('OntologyPanel 易用性', () => {
  it('实体列表支持关键字检索与「仅看未绑定」', async () => {
    render(<OntologyPanel />);
    expect(await screen.findByText('机构')).toBeTruthy();
    expect(screen.getByText('客户')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索业务实体'), { target: { value: '客户' } });
    expect(screen.queryByText('机构')).toBeNull();
    expect(screen.getByText('客户')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索业务实体'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('仅看未绑定'));
    expect(screen.queryByText('机构')).toBeNull();
    expect(screen.getByText('客户')).toBeTruthy();
  });

  it('绑定编辑显示脏标记，保存走整组替换接口', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');

    fireEvent.click(screen.getAllByText('维护绑定')[0]);
    expect(screen.getByText('与库内一致')).toBeTruthy();

    fireEvent.click(screen.getByText('添加绑定'));
    expect(screen.getByText('有未保存改动')).toBeTruthy();

    fireEvent.click(screen.getByText('保存绑定'));
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/ontology/entities/1/bindings',
        expect.objectContaining({ method: 'PUT' })
      )
    );
  });

  it('值域批量粘贴实时解析：多分隔符、无法解析行与写入条数', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');
    fireEvent.click(screen.getByText('值域释义'));

    const textarea = await screen.findByLabelText('批量粘贴值域释义');
    fireEvent.change(textarea, { target: { value: '1=本期\n2＝上期\n9\t其他\n非法行' } });
    expect(screen.getByText(/将写入 3 条/)).toBeTruthy();
    expect(screen.getByText(/1 行无法解析/)).toBeTruthy();
  });

  it('业务层级可视化编辑：填入示例后给出下钻预览且可提交', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');
    fireEvent.click(screen.getByText('业务层级'));
    expect(await screen.findByText('机构层级')).toBeTruthy();

    fireEvent.click(screen.getByText('新建层级'));
    fireEvent.click(screen.getByText('填入示例'));
    expect(screen.getByText('预览：集团 > 分公司 > 项目')).toBeTruthy();
    expect((screen.getByText('确认创建') as HTMLButtonElement).disabled).toBe(false);
  });

  it('点击概览计数卡直接切换到对应 Tab', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');

    fireEvent.click(screen.getByLabelText('查看业务层级'));
    expect(await screen.findByText('机构层级')).toBeTruthy();
  });

  it('行内停用实体 → PUT 携带 DISABLED 状态', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');

    fireEvent.click(screen.getByLabelText('停用实体 机构'));
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/ontology/entities/1',
        expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"status":"DISABLED"') })
      )
    );
  });

  it('版本历史以可读摘要展示快照，并标记最新版本', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');

    fireEvent.click(screen.getAllByText('版本')[0]);
    expect(await screen.findByText('版本历史 · 机构')).toBeTruthy();
    // v2 与 v1 摘要都以「机构 · SUBJECT · 别名 JGMC」开头，故用 findAllByText
    expect((await screen.findAllByText(/机构 · SUBJECT · 别名 JGMC/)).length).toBe(2);
    expect(screen.getByText('最新')).toBeTruthy();
    expect(screen.getByText('当前版本')).toBeTruthy();
  });
});
