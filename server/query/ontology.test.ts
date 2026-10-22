/**
 * v0.9.110 业务本体 M1+M2 单测：
 * 入参校验、实体命中、圈表加权、BFS 路径、提示词四段、快照加载、CRUD 与版本。
 * DB 用队列式 mock（与 metrics.test.ts 同模式），不依赖真实 MySQL。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const queue: any[] = [];
const querySpy = vi.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('ontology.test: 队列为空，SQL 调用次数超出预期');
  return next;
});
vi.mock('../infra/db', () => {
  // v0.9.114 P1-1：写库改走 withTransaction；此处提供等价实现，事务控制语句不消耗 SQL 队列
  const connOf = () => ({
    query: (...args: any[]) => querySpy(...args),
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
  });
  return {
    getPool: () => ({ query: (...args: any[]) => querySpy(...args), getConnection: async () => connOf() }),
    withTransaction: async <T>(fn: (c: ReturnType<typeof connOf>) => Promise<T>): Promise<T> => {
      const c = connOf();
      try {
        return await fn(c);
      } catch (err) {
        if (err && (err as { __txAbort?: boolean }).__txAbort) return (err as { value: T }).value;
        throw err;
      } finally {
        c.release();
      }
    },
    abortTransaction: (value: unknown): never => {
      const err = new Error('__tx_abort__') as Error & { __txAbort: boolean; value: unknown };
      err.__txAbort = true;
      err.value = value;
      throw err;
    },
  };
});
vi.mock('../llm/llmClient', () => ({
  callEmbedding: vi.fn(async () => [1, 0]),
  callEmbeddingBatch: vi.fn(async () => [[1, 0], [0, 1]]),
}));

import {
  sanitizeEntityInput,
  sanitizeBindingsInput,
  sanitizeValueNoteInput,
  sanitizeRelationInput,
  sanitizeHierarchyInput,
  matchEntities,
  rerankEntitiesAsync,
  tableBoostsFromBindings,
  findRelationPaths,
  buildOntologyPrompt,
  loadActiveOntology,
  createEntity,
  updateEntity,
  deleteEntity,
  replaceBindings,
  restoreEntityVersion,
  upsertValueNote,
  createRelation,
  createHierarchy,
  listOntologyVersions,
  OntologyEntity,
  OntologyRelation,
  OntologyBinding,
} from './ontology';

const entityRow = (o: Record<string, any> = {}) => ({
  id: 1,
  data_source_id: 'ds1',
  name: '机构',
  entity_type: 'SUBJECT',
  aliases_json: '["JGMC","机构名称"]',
  description: '机构主数据',
  status: 'ACTIVE',
  version: 1,
  created_by: 'admin',
  ...o,
});

const relationRow = (o: Record<string, any> = {}) => ({
  id: 3,
  data_source_id: 'ds1',
  from_table: 'JGXX',
  from_columns: 'JGMC',
  to_table: 'XMXX',
  to_columns: 'JGMC',
  join_type: 'LEFT',
  cardinality: '1:N',
  purpose: '机构-项目',
  status: 'ACTIVE',
  version: 1,
  created_by: 'admin',
  ...o,
});

const entity = (o: Partial<OntologyEntity> = {}): OntologyEntity => ({
  id: 1,
  dataSourceId: 'ds1',
  name: '机构',
  entityType: 'SUBJECT',
  aliases: ['JGMC'],
  description: '',
  status: 'ACTIVE',
  ...o,
});

const binding = (o: Partial<OntologyBinding> = {}): OntologyBinding => ({
  entityId: 1,
  dataSourceId: 'ds1',
  tableName: 'JGXX',
  columnName: 'JGMC',
  role: 'IDENTITY',
  ...o,
});

const relation = (o: Partial<OntologyRelation> = {}): OntologyRelation => ({
  dataSourceId: 'ds1',
  fromTable: 'A',
  fromColumns: ['ID'],
  toTable: 'B',
  toColumns: ['A_ID'],
  joinType: 'LEFT',
  cardinality: '1:N',
  purpose: '',
  status: 'ACTIVE',
  ...o,
});

beforeEach(() => {
  queue.length = 0;
  querySpy.mockClear();
});

describe('本体入参校验', () => {
  it('实体：别名去重/剔除同名，外部填 PENDING 归一为 ACTIVE', () => {
    const r = sanitizeEntityInput({
      dataSourceId: 'ds1',
      name: '机构',
      aliases: ['JGMC', 'JGMC', '机构', '机构名称'],
      status: 'PENDING',
      entityType: 'OBJECT',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entity.aliases).toEqual(['JGMC', '机构名称']);
      expect(r.entity.status).toBe('ACTIVE');
      expect(r.entity.entityType).toBe('OBJECT');
    }
    expect(sanitizeEntityInput({ name: '机构' }).ok).toBe(false);
    expect(sanitizeEntityInput({ dataSourceId: 'ds1' }).ok).toBe(false);
  });

  it('绑定：表/列标识符白名单，同表列去重', () => {
    const r = sanitizeBindingsInput(1, 'ds1', [
      { tableName: 'JGXX', columnName: 'JGMC', role: 'IDENTITY' },
      { tableName: 'JGXX', columnName: 'JGMC', role: 'ATTRIBUTE' },
      { tableName: 'XMXX', columnName: '', role: 'RELATION_KEY' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bindings).toHaveLength(2);
      expect(r.bindings[1].columnName).toBe('');
    }
    expect(sanitizeBindingsInput(1, 'ds1', [{ tableName: 'JG-XX' }]).ok).toBe(false);
    expect(sanitizeBindingsInput(1, 'ds1', 'x' as any).ok).toBe(false);
  });

  it('值域释义：表列必填且合法，值/含义必填', () => {
    const r = sanitizeValueNoteInput({ dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'BB', valueCode: '1', meaning: '本期' });
    expect(r.ok).toBe(true);
    expect(sanitizeValueNoteInput({ dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'BB', valueCode: '1', meaning: '' }).ok).toBe(false);
    expect(sanitizeValueNoteInput({ dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'B B', valueCode: '1', meaning: 'x' }).ok).toBe(false);
  });

  it('关系：逗号串/数组均可，两侧列数一致，join/cardinality 缺省 LEFT/N:1', () => {
    const r = sanitizeRelationInput({ dataSourceId: 'ds1', fromTable: 'JGXX', fromColumns: 'JGMC', toTable: 'XMXX', toColumns: ['JGMC'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.relation.fromColumns).toEqual(['JGMC']);
      expect(r.relation.joinType).toBe('LEFT');
      expect(r.relation.cardinality).toBe('N:1');
    }
    expect(
      sanitizeRelationInput({ dataSourceId: 'ds1', fromTable: 'A', fromColumns: 'X,Y', toTable: 'B', toColumns: ['X'] }).ok
    ).toBe(false);
    expect(
      sanitizeRelationInput({ dataSourceId: 'ds1', fromTable: 'A', fromColumns: 'X', toTable: 'B', toColumns: ['X'], cardinality: 'N:N' }).ok
    ).toBe(true);
  });

  it('层级：至少 2 级，支持 JSON 数组字符串，列名合法', () => {
    const r = sanitizeHierarchyInput({ dataSourceId: 'ds1', name: '机构层级', levels: ['JT', 'FGS', 'XM'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hierarchy.levels).toEqual(['JT', 'FGS', 'XM']);
    expect(sanitizeHierarchyInput({ dataSourceId: 'ds1', name: 'x', levelsJson: '["A","B"]' }).ok).toBe(true);
    expect(sanitizeHierarchyInput({ dataSourceId: 'ds1', name: 'x', levels: ['A'] }).ok).toBe(false);
    expect(sanitizeHierarchyInput({ dataSourceId: 'ds1', name: 'x', levels: ['A', 'B-C'] }).ok).toBe(false);
  });
});

describe('实体命中与圈表加权', () => {
  it('名称/别名命中 weight 10，描述 bigram 仅作弱信号', () => {
    const hits = matchEntities('统计机构数量', [entity()]);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeGreaterThanOrEqual(10);

    const aliasHits = matchEntities('按 JGMC 分组', [entity()]);
    expect(aliasHits).toHaveLength(1);

    // 名称不命中，仅描述重合：得分 >0 但 <10
    const descOnly = matchEntities('机构数量', [entity({ name: '客户', aliases: [], description: '机构主数据' })]);
    expect(descOnly).toHaveLength(1);
    expect(descOnly[0].score).toBeGreaterThan(0);
    expect(descOnly[0].score).toBeLessThan(10);

    expect(matchEntities('天气怎么样', [entity()])).toEqual([]);
    expect(matchEntities('', [entity()])).toEqual([]);
  });

  it('embedding 精排失败自动降级（mock 返回向量时按余弦重排）', async () => {
    const hits = [
      { entity: entity({ id: 1 }), score: 10 },
      { entity: entity({ id: 2, name: '项目' }), score: 10 },
    ];
    const reranked = await rerankEntitiesAsync('机构', hits);
    expect(reranked).toHaveLength(2);
    expect(reranked[0].entity.name).toBe('机构');
  });

  it('绑定加权：IDENTITY +8 / RELATION_KEY +4 / ATTRIBUTE +3，单表封顶 +15，仅命中实体参与', () => {
    const hits = [{ entity: entity({ id: 1 }), score: 10 }];
    const boosts = tableBoostsFromBindings(hits, [
      binding({ entityId: 1, tableName: 'JGXX', role: 'IDENTITY' }),
      binding({ entityId: 1, tableName: 'JGXX', columnName: 'BB', role: 'RELATION_KEY' }),
      binding({ entityId: 1, tableName: 'JGXX', columnName: 'MC', role: 'ATTRIBUTE' }),
      binding({ entityId: 2, tableName: 'OTHER', role: 'IDENTITY' }),
    ]);
    expect(boosts.get('JGXX')).toBe(15); // 8+4+3 封顶
    expect(boosts.has('OTHER')).toBe(false);
    expect(tableBoostsFromBindings([], [binding()]).size).toBe(0);
  });
});

describe('关联路径 BFS', () => {
  it('直达路径与反向检索', () => {
    const rels = [relation()];
    const forward = findRelationPaths('A', 'B', rels);
    expect(forward).toHaveLength(1);
    expect(forward[0].hops).toBe(1);
    expect(forward[0].edges[0].reversed).toBe(false);

    const backward = findRelationPaths('B', 'A', rels);
    expect(backward).toHaveLength(1);
    expect(backward[0].edges[0].reversed).toBe(true);
    expect(backward[0].edges[0].fromTable).toBe('B');
  });

  it('两跳路径、maxDepth 限制、无路径与自环', () => {
    const rels = [relation(), relation({ fromTable: 'B', fromColumns: ['ID'], toTable: 'C', toColumns: ['B_ID'] })];
    const path = findRelationPaths('A', 'C', rels);
    expect(path[0].hops).toBe(2);
    expect(path[0].tables).toEqual(['a', 'b', 'c']);
    expect(findRelationPaths('A', 'C', rels, 1)).toEqual([]);
    expect(findRelationPaths('A', 'Z', rels)).toEqual([]);
    expect(findRelationPaths('A', 'A', rels)).toEqual([]);
  });

  it('停用关系不参与路径', () => {
    expect(findRelationPaths('A', 'B', [relation({ status: 'DISABLED' })])).toEqual([]);
  });
});

describe('本体提示词', () => {
  const base = {
    entityHits: [{ entity: entity(), score: 10 }],
    bindings: [binding(), binding({ tableName: 'XMXX', role: 'RELATION_KEY' })],
    valueNotes: [
      { id: 1, dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'BB', valueCode: '1', meaning: '本期', status: 'ACTIVE' as const },
      { id: 2, dataSourceId: 'ds1', tableName: 'OTHER', columnName: 'X', valueCode: '9', meaning: '无关', status: 'ACTIVE' as const },
    ],
    relations: [relation({ fromTable: 'JGXX', fromColumns: ['JGMC'], toTable: 'XMXX', toColumns: ['JGMC'], purpose: '机构-项目' })],
    hierarchies: [{ id: 1, dataSourceId: 'ds1', name: '机构层级', levels: ['JT', 'FGS', 'XM'], status: 'ACTIVE' as const }],
    promptTables: ['JGXX', 'XMXX'],
  };

  it('四段齐全：实体/值域/路径/层级 + 优先级声明；值域按命中表过滤', () => {
    const text = buildOntologyPrompt(base);
    expect(text).toContain('【业务实体】');
    expect(text).toContain('机构（SUBJECT');
    expect(text).toContain('JGXX.JGMC[IDENTITY]');
    expect(text).toContain('【值域释义】');
    expect(text).toContain('JGXX.BB = 1 → 本期');
    expect(text).not.toContain('OTHER.X');
    expect(text).toContain('【关联路径】');
    expect(text).toContain('JGXX(JGMC) -[LEFT, 1:N]-> XMXX(JGMC)（机构-项目）');
    expect(text).toContain('【业务层级】');
    expect(text).toContain('机构层级：JT > FGS > XM');
    expect(text).toContain('铁律 > 语义指标 > 业务本体');
  });

  it('多表无登记路径时给候选提示；无命中且无表时零注入', () => {
    const hint = buildOntologyPrompt({ ...base, entityHits: [], relations: [] });
    expect(hint).toContain('未登记关联路径');
    expect(buildOntologyPrompt({ ...base, entityHits: [], relations: [], hierarchies: [], promptTables: [] })).toBe('');
  });

  it('预算裁剪：小预算下后段被截断，仍保留优先级声明', () => {
    const text = buildOntologyPrompt({ ...base, budgetTokens: 150 });
    expect(text).toContain('【业务实体】');
    expect(text).toContain('本体使用约束');
    expect(text).not.toContain('【业务层级】');
  });
});

describe('本体快照加载', () => {
  it('5 类资产并行加载并按行映射', async () => {
    queue.push(
      [[entityRow()], []],
      [[{ id: 10, entity_id: 1, data_source_id: 'ds1', table_name: 'JGXX', column_name: 'JGMC', role: 'IDENTITY' }], []],
      [[{ id: 20, data_source_id: 'ds1', table_name: 'JGXX', column_name: 'BB', value_code: '1', meaning: '本期', status: 'ACTIVE' }], []],
      [[relationRow()], []],
      [[{ id: 30, data_source_id: 'ds1', name: '机构层级', levels_json: '["JT","FGS"]', status: 'ACTIVE' }], []]
    );
    const snap = await loadActiveOntology('ds1');
    expect(snap.entities).toHaveLength(1);
    expect(snap.entities[0].aliases).toEqual(['JGMC', '机构名称']);
    expect(snap.bindings[0].role).toBe('IDENTITY');
    expect(snap.valueNotes[0].meaning).toBe('本期');
    expect(snap.relations[0].fromColumns).toEqual(['JGMC']);
    expect(snap.relations[0].cardinality).toBe('1:N');
    expect(snap.hierarchies[0].levels).toEqual(['JT', 'FGS']);
  });

  it('加载异常降级空快照（问数不阻断）', async () => {
    const snap = await loadActiveOntology('ds1');
    expect(snap).toEqual({ entities: [], bindings: [], valueNotes: [], relations: [], hierarchies: [] });
  });
});

describe('CRUD 与版本', () => {
  it('创建实体：重名 409 语义；成功写 version=1 快照', async () => {
    queue.push([[{ id: 1 }], []]);
    const dup = await createEntity(
      { dataSourceId: 'ds1', name: '机构', entityType: 'SUBJECT', aliases: [], description: '', status: 'ACTIVE' },
      'admin'
    );
    expect(dup.ok).toBe(false);

    queue.push([[], []], [{ insertId: 11 }, []], [{}]);
    const ok = await createEntity(
      { dataSourceId: 'ds1', name: '机构', entityType: 'SUBJECT', aliases: [], description: '', status: 'ACTIVE' },
      'admin'
    );
    expect(ok).toEqual({ ok: true, id: 11 });
    const insertVersion = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO ontology_versions'));
    expect(insertVersion?.[1]?.[2]).toBe(1);
    expect(insertVersion?.[1]?.[4]).toBe('CREATE');
  });

  it('更新实体 version+1；删除实体清理绑定并留快照', async () => {
    // 更新：findById → 重名检查 → UPDATE → 版本 INSERT
    queue.push([[entityRow({ version: 2 })], []], [[], []], [{ affectedRows: 1 }], [{}]);
    const up = await updateEntity(1, { name: '机构', entityType: 'SUBJECT', aliases: [], description: '', status: 'ACTIVE' }, 'admin');
    expect(up.ok).toBe(true);
    const updateCall = querySpy.mock.calls.find((c) => String(c[0]).startsWith('UPDATE ontology_entities'));
    expect(updateCall?.[1]?.[5]).toBe(3);

    queue.length = 0;
    queue.push([[entityRow()], []], [{}], [{ affectedRows: 1 }], [{}]);
    expect(await deleteEntity(1, 'admin')).toBe(true);
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('DELETE FROM ontology_bindings'))).toBe(true);
  });

  it('绑定整组替换：先删后插', async () => {
    queue.push([[entityRow()], []], [{}], [{}]);
    const r = await replaceBindings(1, [binding()]);
    expect(r.ok).toBe(true);
    const calls = querySpy.mock.calls.map((c) => String(c[0]));
    expect(calls[1]).toContain('DELETE FROM ontology_bindings');
    expect(calls[2]).toContain('INSERT INTO ontology_bindings');
  });

  it('版本回溯：应用快照且动作记 RESTORE', async () => {
    const snap = { name: '机构', entityType: 'SUBJECT', aliases: ['JGMC'], description: '', status: 'ACTIVE' };
    queue.push(
      [[entityRow({ version: 4 })], []],
      [[{ version: 2, snapshot_json: JSON.stringify(snap) }], []],
      [[entityRow({ version: 4 })], []],
      [[], []],
      [{ affectedRows: 1 }],
      [{}]
    );
    const r = await restoreEntityVersion(1, 2, 'admin');
    expect(r.ok).toBe(true);
    const versionInsert = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO ontology_versions'));
    expect(versionInsert?.[1]?.[2]).toBe(5);
    expect(versionInsert?.[1]?.[4]).toBe('RESTORE');
  });

  it('值域 upsert：存在则更新，不存在则新增', async () => {
    queue.push([[{ id: 5 }], []], [{}]);
    expect(await upsertValueNote({ dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'BB', valueCode: '1', meaning: '本期', status: 'ACTIVE' }, 'admin')).toEqual({ ok: true, id: 5 });
    expect(querySpy.mock.calls[1][0]).toContain('UPDATE ontology_value_notes');

    queue.length = 0;
    queue.push([[], []], [{ insertId: 9 }, []]);
    expect(await upsertValueNote({ dataSourceId: 'ds1', tableName: 'JGXX', columnName: 'BB', valueCode: '2', meaning: '上期', status: 'ACTIVE' }, 'admin')).toEqual({ ok: true, id: 9 });
  });

  it('关系与层级创建：重名/重复路径拒绝，成功写 CREATE 快照', async () => {
    queue.push([[], []], [{ insertId: 3 }, []], [{}]);
    const rel = await createRelation(
      { dataSourceId: 'ds1', fromTable: 'A', fromColumns: ['ID'], toTable: 'B', toColumns: ['A_ID'], joinType: 'LEFT', cardinality: '1:N', purpose: '', status: 'ACTIVE' },
      'admin'
    );
    expect(rel).toEqual({ ok: true, id: 3 });

    queue.length = 0;
    queue.push([[{ id: 3 }], []]);
    const dup = await createRelation(
      { dataSourceId: 'ds1', fromTable: 'A', fromColumns: ['ID'], toTable: 'B', toColumns: ['A_ID'], joinType: 'LEFT', cardinality: '1:N', purpose: '', status: 'ACTIVE' },
      'admin'
    );
    expect(dup.ok).toBe(false);

    queue.length = 0;
    queue.push([[], []], [{ insertId: 7 }, []], [{}]);
    const h = await createHierarchy({ dataSourceId: 'ds1', name: '机构层级', levels: ['JT', 'FGS'], status: 'ACTIVE' }, 'admin');
    expect(h).toEqual({ ok: true, id: 7 });
  });

  it('版本列表：新→旧含 action/actor/snapshot', async () => {
    queue.push(
      [[
        { version: 2, action: 'UPDATE', actor: 'admin', created_at: '2026-10-13 10:00:00', snapshot_json: '{"name":"机构"}' },
        { version: 1, action: 'CREATE', actor: 'admin', created_at: '2026-10-12 10:00:00', snapshot_json: '{}' },
      ], []]
    );
    const list = await listOntologyVersions('entity', 1);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ version: 2, action: 'UPDATE', snapshot: { name: '机构' } });
  });
});
