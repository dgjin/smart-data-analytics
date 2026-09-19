/**
 * 组织节点 → 数据范围派生（IO 薄层，v0.9.69）。
 *
 * 背景：用户「所属组织」（users.org_unit_id）与「数据范围档位」（users.org_scope_json）此前是
 * 两套独立配置——组织树里选定了所属部门，问数时并不会因此产生任何过滤（默认全辖），
 * 与「按组织归属隔离数据」的预期不符。
 *
 * 本模块把组织树（org_units）实时读入内存索引，为「未显式配置范围」的用户派生缺省范围：
 *   总部 → 不限制；机构 → 本机构（ORG）；部门 → 本部门 + 下辖全部团队（TEAM）；团队 → 本团队（TEAM）。
 * 实时读取不做缓存：管理员调整组织树或用户所属节点后，下一次请求即刻生效。
 */
import type mysql from 'mysql2/promise';
import { getPool } from '../infra/db';
import {
  buildUnitScopeIndex,
  deriveOrgScopeFromUnit,
  hasExplicitOrgScope,
  parseUserOrgScope,
  type OrgUnitFlatRow,
  type OrgUnitScopeSource,
  type UserOrgScope,
} from './orgScope';

interface OrgUnitRow extends mysql.RowDataPacket {
  id: number;
  parent_id: number | null;
  level: string;
  data_code: string | null;
}

/** 读取组织树并构建「节点 id → 派生来源（含全部后代数据标识）」索引 */
export async function loadUnitScopeIndex(): Promise<Map<number, OrgUnitScopeSource>> {
  const [rows] = await getPool().query<OrgUnitRow[]>('SELECT id, parent_id, level, data_code FROM org_units');
  const flat: OrgUnitFlatRow[] = (rows || []).map((r) => ({
    id: Number(r.id),
    parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    level: String(r.level || ''),
    dataCode: String(r.data_code || ''),
  }));
  return buildUnitScopeIndex(flat);
}

/** 有效数据范围：显式配置优先（含显式全辖）；未显式配置且绑定了组织节点时按节点派生；否则 null（不限制）。 */
export async function resolveEffectiveOrgScope(
  rawScope: unknown,
  orgUnitId: number | null | undefined
): Promise<UserOrgScope | null> {
  // 显式配置（含 {"level":"ALL"} 显式全辖）优先，解析结果可能为 null = 不限制
  if (hasExplicitOrgScope(rawScope)) return parseUserOrgScope(rawScope);
  const unitId = Number(orgUnitId);
  // 未绑定组织节点（或值非法）→ 不派生，保持存量行为（不限制）
  if (!Number.isInteger(unitId) || unitId <= 0) return null;
  const index = await loadUnitScopeIndex();
  return deriveOrgScopeFromUnit(index.get(unitId) ?? null);
}

export interface OrgScopeInput {
  rawScope: unknown;
  orgUnitId: number | null | undefined;
}

export interface EffectiveOrgScopeResult {
  /** 生效范围（显式或派生；null = 不限制） */
  effective: UserOrgScope | null;
  /** true = 该范围由所属组织节点自动派生（列表中提示用） */
  derived: boolean;
}

/**
 * 批量解析有效范围（管理端列表用）：仅当存在「未显式配置 + 已绑定节点」的用户时才查一次组织树，
 * 避免 N+1 查询；显式配置优先，与鉴权链路同源规则。
 */
export async function resolveEffectiveOrgScopes(items: OrgScopeInput[]): Promise<EffectiveOrgScopeResult[]> {
  const configured = items.map((it) => hasExplicitOrgScope(it.rawScope));
  const needTree = items.some((it, i) => !configured[i] && Number(it.orgUnitId) > 0);
  const index = needTree ? await loadUnitScopeIndex() : null;
  return items.map((it, i) => {
    if (configured[i]) return { effective: parseUserOrgScope(it.rawScope), derived: false };
    const unitId = Number(it.orgUnitId);
    if (!index || !Number.isInteger(unitId) || unitId <= 0) return { effective: null, derived: false };
    const derived = deriveOrgScopeFromUnit(index.get(unitId) ?? null);
    return { effective: derived, derived: derived !== null };
  });
}
