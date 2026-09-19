/**
 * 组织数据范围（OrgScope）——三层组织权限模型的数据隔离谓词生成器。
 *
 * 业务原则：
 *   - 总部条线管理部门：全辖数据（ALL，不生成过滤）
 *   - 各分公司：仅本机构数据（ORG，按机构列等值/IN 过滤，如 JGBH）
 *   - 各部门/团队：仅本项目数据（TEAM，按团队列过滤，如 SSTD）
 *   - 扩展档：仅本人经办（SELF，按经办人列等值过滤，如 XMJBRBH）
 *
 * 职责边界：本模块只做「纯函数」解析与谓词生成，不做 IO。
 *   - 用户范围：users.org_scope_json（NULL/ALL = 不限制，存量用户零影响）
 *   - 列映射：data_sources.org_columns_json（NULL = 该数据源不做组织隔离）
 *   - 生成的谓词与数据源级 rowFilters 合并后，交执行层 AST 强制注入（fail-closed）。
 */
import { createHash } from 'node:crypto';
import type { SchemaTable } from './schemaTypes';

export type OrgScopeLevel = 'ALL' | 'ORG' | 'TEAM' | 'SELF';

/** 用户级数据范围（users.org_scope_json） */
export interface UserOrgScope {
  level: OrgScopeLevel;
  /** level=ORG 时的机构列表（机构编号，如 JGBH） */
  orgs?: string[];
  /** level=TEAM 时的团队列表（所属团队，如 SSTD） */
  teams?: string[];
  /** level=SELF 时的经办人编号（如 XMJBRBH） */
  selfCode?: string;
}

/** 数据源组织列映射（data_sources.org_columns_json） */
export interface OrgColumns {
  /** 机构列（分公司/机构编号，如 JGBH） */
  org?: string;
  /** 团队列（所属团队/条线，如 SSTD） */
  team?: string;
  /** 责任人列（经办人编号，如 XMJBRBH） */
  owner?: string;
}

/** 单维度授权值上限（管理端保存时同样校验），防超长 IN 列表拖垮 SQL */
export const MAX_SCOPE_ITEMS = 200;

const LEVELS: OrgScopeLevel[] = ['ALL', 'ORG', 'TEAM', 'SELF'];

function asObject(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** 字符串列表清洗：去空白、剔空、去重、限长（保留顺序） */
function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' && typeof item !== 'number') continue;
    const s = String(item).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SCOPE_ITEMS) break;
  }
  return out;
}

/**
 * 是否显式配置过数据范围（含显式 ALL=全辖）。
 * 与 parseUserOrgScope 的差异：后者把 NULL 与显式 ALL 都归一为 null（不限制），
 * 但 v0.9.69「按所属组织派生」需区分「从未配置」（派生缺省）与「显式授权全辖」（不派生）。
 */
export function hasExplicitOrgScope(raw: unknown): boolean {
  const obj = asObject(raw);
  if (!obj) return false;
  return LEVELS.includes(String(obj.level || '').toUpperCase() as OrgScopeLevel);
}

/**
 * 解析用户数据范围：非法/缺失/NULL/level=ALL → null（表示不限制，等同现状）。
 * ORG/TEAM/SELF 但授权值为空时同样返回 null——「配了档位却没给值」按不限制处理，
 * 避免误配把用户锁死看不到任何数据（管理端保存时会拒绝空值，此处是防御性兜底）。
 */
export function parseUserOrgScope(raw: unknown): UserOrgScope | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const level = String(obj.level || '').toUpperCase() as OrgScopeLevel;
  if (!LEVELS.includes(level) || level === 'ALL') return null;

  if (level === 'ORG') {
    const orgs = cleanList(obj.orgs);
    return orgs.length > 0 ? { level, orgs } : null;
  }
  if (level === 'TEAM') {
    const teams = cleanList(obj.teams);
    if (teams.length === 0) return null;
    // 团队档可同时登记机构列表（双重收敛）；未登记则仅按团队过滤
    const orgs = cleanList(obj.orgs);
    return orgs.length > 0 ? { level, teams, orgs } : { level, teams };
  }
  const selfCode = typeof obj.selfCode === 'string' ? obj.selfCode.trim() : '';
  return selfCode ? { level: 'SELF', selfCode } : null;
}

/** 解析数据源组织列映射：三个列名全空/非法 → null（该数据源不做组织隔离） */
export function parseOrgColumns(raw: unknown): OrgColumns | null {
  const obj = asObject(raw);
  if (!obj) return null;
  const pick = (k: string): string | undefined => {
    const v = obj[k];
    if (typeof v !== 'string') return undefined;
    const s = v.trim();
    // 列名仅允许标识符字符，防配置面注入
    return /^[A-Za-z_][A-Za-z0-9_$]{0,63}$/.test(s) ? s : undefined;
  };
  const cols: OrgColumns = { org: pick('org'), team: pick('team'), owner: pick('owner') };
  return cols.org || cols.team || cols.owner ? cols : null;
}

/** 谓词内字符串字面量转义：单引号翻倍，杜绝拼接注入 */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** 单列过滤谓词：单值用 =，多值用 IN（值均转义） */
function predicate(column: string, values: string[]): string {
  if (values.length === 1) return `${column} = ${quote(values[0])}`;
  return `${column} IN (${values.map(quote).join(', ')})`;
}

/** 在表内按列名做大小写不敏感匹配，返回真实列名 */
function findColumn(table: SchemaTable, wanted: string): string | null {
  const target = wanted.toLowerCase();
  for (const c of table.columns || []) {
    if (typeof c?.name === 'string' && c.name.toLowerCase() === target) return c.name;
  }
  return null;
}

/**
 * 生成用户级行过滤谓词：实际表名 → 谓词（与数据源级 rowFilters 同构，供执行层 AST 注入）。
 * 规则：
 *   - 仅对「含对应组织列」的表生成谓词；表内无该列 = 该表不受此维度约束（放行）
 *   - 同表多维度（如 ORG + TEAM）用 AND 组合
 *   - level=TEAM 时额外按机构收敛：同时存在 org 列则叠加机构条件（团队归属机构的双重保险）
 */
/** 依据档位得出要施加的维度条件（列名在逐表匹配时确定，值固定） */
function effectiveDims(cols: OrgColumns, scope: UserOrgScope): { column: string; values: string[] }[] {
  const dims: { column: string; values: string[] }[] = [];
  if (scope.level === 'ORG') {
    if (cols.org) dims.push({ column: cols.org, values: scope.orgs || [] });
  } else if (scope.level === 'TEAM') {
    if (cols.team) dims.push({ column: cols.team, values: scope.teams || [] });
    // 团队档若用户同时持有机构列表，则机构一并收敛（管理端可同时配置）
    if (cols.org && scope.orgs && scope.orgs.length > 0) dims.push({ column: cols.org, values: scope.orgs });
  } else if (scope.level === 'SELF' && cols.owner) {
    dims.push({ column: cols.owner, values: scope.selfCode ? [scope.selfCode] : [] });
  }
  return dims.filter((d) => d.values.length > 0);
}

export function buildOrgRowFilters(
  tables: SchemaTable[],
  cols: OrgColumns | null | undefined,
  scope: UserOrgScope | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cols || !scope) return out;
  const dims = effectiveDims(cols, scope);

  for (const t of Array.isArray(tables) ? tables : []) {
    const name = typeof t?.name === 'string' ? t.name : '';
    if (!name) continue;
    const parts: string[] = [];
    for (const d of dims) {
      const real = findColumn(t, d.column);
      if (!real) continue; // 该表无此列：不受此维度约束
      parts.push(predicate(real, d.values));
    }
    if (parts.length > 0) out[name] = parts.join(' AND ');
  }
  return out;
}

/** 合并两组行过滤谓词（同表 AND 组合），保持数据源级与用户级同时生效 */
export function mergeRowFilters(
  base: Record<string, string> | null | undefined,
  extra: Record<string, string> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = { ...(base || {}) };
  for (const [table, pred] of Object.entries(extra || {})) {
    if (!pred) continue;
    const prev = out[table];
    out[table] = prev && prev !== pred ? `(${prev}) AND (${pred})` : pred;
  }
  return out;
}

/**
 * 数据范围指纹（用于结果缓存键分桶）：不同范围绝不共用同一份缓存结果，
 * 避免 A 机构命中 B 机构的问数结果（跨用户越权泄露）。
 * 不限制（null/ALL）时返回空串，保持存量缓存键不变。
 */
export function orgScopeFingerprint(scope: UserOrgScope | null | undefined): string {
  if (!scope) return '';
  const material = JSON.stringify({
    level: scope.level,
    orgs: [...(scope.orgs || [])].sort(),
    teams: [...(scope.teams || [])].sort(),
    selfCode: scope.selfCode || '',
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** 人类可读的范围描述（前端状态条 / 审计用） */
export function describeOrgScope(scope: UserOrgScope | null | undefined): string {
  if (!scope) return '全辖（不限制）';
  if (scope.level === 'ORG') return `本机构：${(scope.orgs || []).join('、')}`;
  if (scope.level === 'TEAM') {
    const orgs = (scope.orgs || []).length > 0 ? `（机构 ${(scope.orgs || []).join('、')}）` : '';
    return `本项目团队：${(scope.teams || []).join('、')}${orgs}`;
  }
  return `仅本人经办：${scope.selfCode || ''}`;
}

/**
 * 阶段一提示词的数据范围约束段：告知 LLM 可见范围，避免其生成"全辖对比"等
 * 与授权范围冲突的分析意图（真正的强制隔离在执行层 AST 注入，提示词只做语义对齐）。
 */
export function orgScopePromptHint(cols: OrgColumns | null | undefined, scope: UserOrgScope | null | undefined): string {
  if (!cols || !scope) return '';
  const visible = effectiveDims(cols, scope)
    .map((d) => predicate(d.column, d.values))
    .join(' AND ');
  if (!visible) return '';
  return `【数据范围约束（系统级强制）】
当前用户的数据权限范围是「${describeOrgScope(scope)}」，执行层已自动对相关表注入过滤条件（${visible}），你无需也不得在 SQL 中自行添加机构/团队过滤；严禁生成跨范围对比、汇总或推算他人数据的查询意图，所有结论必须严格限定在该范围内。`;
}

/** 组织节点层级（与 org_units.level 一致） */
export type OrgUnitLevel = 'HQ' | 'BRANCH' | 'DEPT' | 'TEAM';

/** 组织节点派生来源：节点层级 + 数据标识 + 后代数据标识 */
export interface OrgUnitScopeSource {
  level: OrgUnitLevel;
  /** 节点「数据标识」（业务数据中的实际取值，如机构编号 AH、团队名「一部一团队」） */
  dataCode: string;
  /** 后代节点的数据标识（部门向〃下辖全部团队收敛用；机构/团队层级可为空） */
  descendantCodes?: string[];
}

/** 组织树扁平行（构建节点→派生来源索引的输入） */
export interface OrgUnitFlatRow {
  id: number;
  parentId: number | null;
  level: string;
  dataCode: string;
}

/**
 * 按「用户所属组织节点」派生缺省数据范围（v0.9.69）：
 *   总部 → null（全辖，不限制）；机构 → ORG（本机构编号，机构列匹配）；
 *   部门 → TEAM（本部门 + 下辖全部团队数据标识，团队列匹配）；团队 → TEAM（仅本团队）。
 * 数据标识为空时无法派生 → null（防御：无值可匹配时不做误隔离，保持存量行为）。
 * 仅当用户未显式配置 org_scope_json 时作为缺省生效；显式配置（含显式 ALL）优先。
 */
export function deriveOrgScopeFromUnit(unit: OrgUnitScopeSource | null | undefined): UserOrgScope | null {
  if (!unit) return null;
  const level = String(unit.level || '').toUpperCase();
  if (level === 'HQ') return null;
  const self = String(unit.dataCode || '').trim();
  if (level === 'BRANCH') return self ? { level: 'ORG', orgs: [self] } : null;
  if (level === 'DEPT') {
    const teams = cleanList([self, ...(unit.descendantCodes || [])]);
    return teams.length > 0 ? { level: 'TEAM', teams } : null;
  }
  if (level === 'TEAM') return self ? { level: 'TEAM', teams: [self] } : null;
  return null;
}

/**
 * 有效数据范围解析：显式配置（含显式全辖）优先；未显式配置（NULL/非法）时按所属组织节点派生。
 */
export function resolveOrgScopeWithUnit(raw: unknown, unit: OrgUnitScopeSource | null | undefined): UserOrgScope | null {
  // 显式配置（含显式 ALL=全辖）优先；未配置（NULL/非法）时按所属组织派生
  return hasExplicitOrgScope(raw) ? parseUserOrgScope(raw) : deriveOrgScopeFromUnit(unit);
}

/**
 * 扁平组织树 → 「节点 id → 派生来源（含全部后代数据标识）」索引（纯函数，供鉴权与管理端复用）。
 * 后代按广度优先展开（先直接下级再逐层向下）；数据标识去重与上限（MAX_SCOPE_ITEMS）由 cleanList 在派生时保证。
 */
export function buildUnitScopeIndex(rows: OrgUnitFlatRow[]): Map<number, OrgUnitScopeSource> {
  const byId = new Map<number, OrgUnitScopeSource>();
  const childrenOf = new Map<number, number[]>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = Number(r?.id);
    if (!Number.isInteger(id)) continue;
    byId.set(id, { level: String(r.level || '').toUpperCase() as OrgUnitLevel, dataCode: String(r.dataCode || '').trim() });
    const pid = r.parentId === null || r.parentId === undefined ? null : Number(r.parentId);
    if (pid !== null && Number.isInteger(pid)) {
      const list = childrenOf.get(pid) || [];
      list.push(id);
      childrenOf.set(pid, list);
    }
  }
  const index = new Map<number, OrgUnitScopeSource>();
  for (const [id, base] of byId) {
    const codes: string[] = [];
    const visited = new Set<number>([id]);
    // 广度优先遍历：先直接下级、再逐层向下，保证取值顺序稳定可预期
    const queue = [...(childrenOf.get(id) || [])];
    for (let i = 0; i < queue.length; i++) {
      const childId = queue[i];
      if (visited.has(childId)) continue;
      visited.add(childId);
      const child = byId.get(childId);
      if (!child) continue;
      if (child.dataCode) codes.push(child.dataCode);
      queue.push(...(childrenOf.get(childId) || []));
    }
    index.set(id, codes.length > 0 ? { ...base, descendantCodes: codes } : base);
  }
  return index;
}
