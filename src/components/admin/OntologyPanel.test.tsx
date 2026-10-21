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

/** 智能预填草案（dryRun / apply 共用） */
const autoBuildDraft = {
  entities: [
    {
      name: '财务',
      entityType: 'SUBJECT',
      aliases: [],
      description: '财务主题宽表',
      bindings: [{ tableName: 'fct_fin', columnName: '', role: 'IDENTITY' }],
      reasons: ['表主题'],
    },
  ],
  valueNotes: [{ tableName: 'fct_fin', columnName: 'BB', valueCode: '1', meaning: '核算版', reason: '枚举描述' }],
  relations: [
    {
      fromTable: 'fct_fin',
      fromColumns: ['JGBH'],
      toTable: 'fct_biz',
      toColumns: ['JGBH'],
      joinType: 'LEFT',
      cardinality: 'N:1',
      purpose: '按机构归集',
      reason: '跨表同名键',
    },
  ],
  hierarchies: [{ name: '财务分类层级', levels: ['YJFL', 'EJFL'], reason: '分级列族' }],
  skipped: ['编号列 XYZ 未找到配对名称列'],
  stats: { tables: 2, columns: 12, entities: 1, bindings: 1, valueNotes: 1, relations: 1, hierarchies: 1 },
};

/** 按 URL + method 分流：版本 / 概览 / 值域 / 关系 / 层级 / 实体（GET 列表、PUT 绑定与停用）/ 智能预填 */
function mockRoutes() {
  mockedApiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method || 'GET';
    const reply = (data: unknown) => ({ ok: true, json: async () => data }) as unknown as Response;

    if (u.includes('/versions')) return reply({ versions: versionRows });
    if (u.includes('/api/ontology/auto-build')) {
      if (String(init?.body || '').includes('"apply":true')) {
        return reply({
          ok: true,
          mode: 'apply',
          draft: autoBuildDraft,
          applied: {
            entitiesCreated: 1,
            entitiesUpdated: 0,
            bindingsWritten: 1,
            valueNotesWritten: 1,
            relationsCreated: 1,
            hierarchiesCreated: 1,
            skippedExisting: 0,
            errors: [],
          },
        });
      }
      return reply({ ok: true, mode: 'preview', draft: autoBuildDraft });
    }
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

  it('智能预填：打开弹窗先预览草案，不携带 apply 直接写库', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');

    fireEvent.click(screen.getByText('智能预填'));
    expect(await screen.findByText('业务实体与绑定')).toBeTruthy();
    expect(screen.getByText(/fct_fin\.\(表级\)/)).toBeTruthy();
    expect(screen.getByText(/1 → 核算版/)).toBeTruthy();
    expect(screen.getByText(/共 4 项候选/)).toBeTruthy();
    expect(screen.getByText(/编号列 XYZ 未找到配对名称列/)).toBeTruthy();

    const call = mockedApiFetch.mock.calls.find(([url]) => String(url).includes('/api/ontology/auto-build'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ dataSourceId: 'ds1' });
  });

  it('智能预填：应用后展示写入统计，完成后刷新概览', async () => {
    render(<OntologyPanel />);
    await screen.findByText('机构');

    fireEvent.click(screen.getByText('智能预填'));
    fireEvent.click(await screen.findByText('应用 4 项'));

    expect(await screen.findByText(/已应用到数据源/)).toBeTruthy();
    expect(screen.getByText('新增实体')).toBeTruthy();
    await waitFor(() =>
      expect(mockedApiFetch).toHaveBeenCalledWith(
        '/api/ontology/auto-build',
        expect.objectContaining({ method: 'POST', body: expect.stringContaining('"apply":true') })
      )
    );

    const summaryCalls = () =>
      mockedApiFetch.mock.calls.filter(([url]) => String(url).includes('/api/ontology/summary')).length;
    const before = summaryCalls();
    fireEvent.click(screen.getByText('完成并刷新'));
    await waitFor(() => expect(summaryCalls()).toBeGreaterThan(before));
    expect(screen.queryByText('业务实体与绑定')).toBeNull();
  });
});
