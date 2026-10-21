/**
 * v0.9.110 业务本体（M1/M2）前端类型：镜像 server/query/ontology.ts 的 API 输出。
 * 仅覆盖管理端「治理与审核 › 业务本体」面板所需字段（实体/绑定/值域释义/关联路径/层级/版本/概览/路径）。
 */

export type OntologyEntityType = 'SUBJECT' | 'OBJECT' | 'TIME' | 'GEO';
export type OntologyStatus = 'ACTIVE' | 'DISABLED' | 'PENDING' | 'REJECTED';
export type OntologyBindingRole = 'IDENTITY' | 'ATTRIBUTE' | 'RELATION_KEY';
export type OntologyJoinType = 'INNER' | 'LEFT' | 'RIGHT';
export type OntologyCardinality = '1:1' | '1:N' | 'N:1' | 'N:N';
export type OntologyAssetType = 'entity' | 'relation' | 'hierarchy';

/** 业务实体（GET /api/ontology/entities 项，含绑定聚合） */
export interface OntologyEntityItem {
  id: number;
  dataSourceId: string;
  name: string;
  entityType: OntologyEntityType;
  aliases: string[];
  description: string;
  status: OntologyStatus;
  version: number;
  createdBy?: string;
  bindings: OntologyBindingItem[];
}

/** 表/列绑定（columnName 空串 = 表级绑定） */
export interface OntologyBindingItem {
  id?: number;
  entityId: number;
  dataSourceId: string;
  tableName: string;
  columnName: string;
  role: OntologyBindingRole;
}

/** 值域释义：表.列 = 值 → 业务含义 */
export interface OntologyValueNoteItem {
  id: number;
  dataSourceId: string;
  tableName: string;
  columnName: string;
  valueCode: string;
  meaning: string;
  status: 'ACTIVE' | 'DISABLED';
  createdBy?: string;
}

/** 已登记 JOIN 关联路径 */
export interface OntologyRelationItem {
  id: number;
  dataSourceId: string;
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  joinType: OntologyJoinType;
  cardinality: OntologyCardinality;
  purpose: string;
  status: OntologyStatus;
  version: number;
  createdBy?: string;
}

/** 业务层级：levels 由粗到细（如 集团 > 分公司 > 项目） */
export interface OntologyHierarchyItem {
  id: number;
  dataSourceId: string;
  name: string;
  levels: string[];
  status: OntologyStatus;
  version: number;
  createdBy?: string;
}

/** 版本历史条目（GET /:type/:id/versions） */
export interface OntologyVersionItem {
  version: number;
  action: string;
  actor: string;
  createdAt: string;
  snapshot: Record<string, unknown>;
}

/** 概览计数（GET /api/ontology/summary，仅 ACTIVE） */
export interface OntologySummaryCounts {
  entities: number;
  valueNotes: number;
  relations: number;
  hierarchies: number;
  bindings: number;
}

/** BFS 路径中的一条关系边（reversed=true 表示沿反向遍历） */
export interface OntologyPathEdge {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  joinType: OntologyJoinType;
  cardinality: OntologyCardinality;
  purpose: string;
  reversed: boolean;
}

/** BFS 检索到的最短路（GET /api/ontology/path） */
export interface OntologyRelationPath {
  tables: string[];
  edges: OntologyPathEdge[];
  hops: number;
}

export const ENTITY_TYPE_META: Record<OntologyEntityType, { label: string; cls: string }> = {
  SUBJECT: { label: '主体', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  OBJECT: { label: '客体', cls: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  TIME: { label: '时间', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  GEO: { label: '地理', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
};

export const BINDING_ROLE_META: Record<OntologyBindingRole, { label: string; cls: string }> = {
  IDENTITY: { label: '标识', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  RELATION_KEY: { label: '关联键', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  ATTRIBUTE: { label: '属性', cls: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
};

export const ONTOLOGY_STATUS_META: Record<string, { label: string; cls: string }> = {
  ACTIVE: { label: '生效中', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  DISABLED: { label: '已停用', cls: 'bg-slate-500/15 text-slate-400 border-slate-500/30' },
  PENDING: { label: '待确认', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  REJECTED: { label: '已驳回', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
};
