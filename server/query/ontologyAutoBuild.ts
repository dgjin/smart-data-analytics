/**
 * 业务本体自动搭建（v0.9.112）：基于数据源 Schema（表 / 列中文描述）做规则化推断，
 * 产出「实体 + 绑定 + 值域释义 + 关联路径 + 业务层级」草案。
 *
 * 设计原则：
 * - 纯函数、无 IO：路由层负责读 schema_json 与落库，前端负责预览与确认；
 * - 可解释：每个推断项都带 reasons / reason，便于管理员复核；
 * - 保守：只从明确的编号-名称列对、`X=Y` 枚举、`取值：` 描述、跨表同名列与分级列族推断，
 *   不猜测日期关联、不编造枚举含义，无法识别的项写入 skipped 提示。
 */

import type { OntologyCardinality, OntologyEntityType, OntologyJoinType } from './ontology';

export interface AutoBuildColumn {
  name: string;
  type?: string;
  description?: string;
  isMetric?: boolean;
  isDimension?: boolean;
}

export interface AutoBuildTable {
  name: string;
  displayName?: string;
  description?: string;
  rowCount?: number;
  columns?: AutoBuildColumn[];
}

export interface DraftBinding {
  tableName: string;
  columnName: string;
  role: 'IDENTITY' | 'ATTRIBUTE' | 'RELATION_KEY';
}

export interface DraftEntity {
  name: string;
  entityType: OntologyEntityType;
  aliases: string[];
  description: string;
  bindings: DraftBinding[];
  reasons: string[];
}

export interface DraftValueNote {
  tableName: string;
  columnName: string;
  valueCode: string;
  meaning: string;
  reason: string;
}

export interface DraftRelation {
  fromTable: string;
  fromColumns: string[];
  toTable: string;
  toColumns: string[];
  joinType: OntologyJoinType;
  cardinality: OntologyCardinality;
  purpose: string;
  reason: string;
}

export interface DraftHierarchy {
  name: string;
  levels: string[];
  reason: string;
}

export interface OntologyDraft {
  entities: DraftEntity[];
  valueNotes: DraftValueNote[];
  relations: DraftRelation[];
  hierarchies: DraftHierarchy[];
  skipped: string[];
  stats: {
    tables: number;
    columns: number;
    entities: number;
    bindings: number;
    valueNotes: number;
    relations: number;
    hierarchies: number;
  };
}

/** 自动生成上限：与提示词注入上限同量级，避免一次写入过多噪声 */
export const MAX_AUTO_ENTITIES = 10;
export const MAX_AUTO_VALUE_NOTES = 200;
export const MAX_AUTO_RELATIONS = 12;
export const MAX_AUTO_HIERARCHIES = 5;

const IDENT_RE = /^[A-Za-z_]\w*$/;
const BINDING_LIMIT = 20;

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function firstSegment(desc: string): string {
  return desc.split(/[（(]/)[0].trim();
}

/** 去掉「编号 / 代码 / 号 / 名称」等后缀，得到业务概念名 */
function conceptName(raw: string): string {
  return firstSegment(raw)
    .replace(/(编号|代码|号码|号|名称|姓名|ID)$/i, '')
    .trim();
}

/** 表主题名：displayName 去技术后缀与粒度说明，如「主营业务-业务粒度宽表」→「主营业务」 */
function themeName(table: AutoBuildTable): string {
  const base = (table.displayName || table.name || '').split(/[-_]/)[0].trim();
  return base.replace(/(宽表|明细表|统计表|事实表|汇总表|表)$/, '').trim() || table.name;
}

function entityTypeOf(name: string): OntologyEntityType {
  if (/省|市|区|县|地区|地域|城市/.test(name)) return 'GEO';
  if (/日期|时间|年份|月份|账期/.test(name)) return 'TIME';
  if (/机构|客户|债务人|人员|团队|部门|公司|银行|合作方/.test(name)) return 'SUBJECT';
  return 'OBJECT';
}

/** 列是否为编号 / 代码类关联键 */
function isKeyColumn(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*(BH|DM|ID)$/.test(name);
}

/** 从列描述解析枚举：`1=核算版；2=分成版`、`取值：是/否`、`取值如：A、B、C`、`如：A、B` */
export function parseEnumValues(desc: string): { code: string; meaning: string }[] {
  const out: { code: string; meaning: string }[] = [];
  const seen = new Set<string>();
  const normalize = (s: string) => (/[\u4e00-\u9fa5]/.test(s) ? s.replace(/\s+/g, '') : s.replace(/\s+/g, ' ')).trim();
  const push = (code: string, meaning: string) => {
    const c = normalize(code).slice(0, 100);
    const m = normalize(meaning).slice(0, 200);
    if (!c || !m || seen.has(c)) return;
    seen.add(c);
    out.push({ code: c, meaning: m });
  };

  // 枚举值常写在括号内（如「版本（1=核算版；2=分成版）」），因此对完整描述匹配
  const body = desc.trim();
  if (!body) return out;

  // 模式一：X=Y（支持多个分号/逗号分隔项）
  for (const m of body.matchAll(/([A-Za-z0-9_-]{1,20})\s*[=＝]\s*([^；;，,、）)]{1,100})/g)) {
    const code = m[1];
    const meaning = m[2].trim();
    // 过滤 SQL 片段（如 SUM(SFCL='是')）与代码表达式
    if (/['"()]/.test(meaning) || /^(SUM|COUNT|WHERE|SELECT|CASE)/i.test(meaning)) continue;
    push(code, meaning);
  }

  // 模式二：取值：是/否、取值如：A、B、如：A、B、方式：A或B（要求 ≥2 项，避免把单个日期/说明当成枚举）
  const valueMatch = body.match(/(?:取值如|取值|方式|如)\s*[:：]\s*([^；;）)]+)/);
  if (valueMatch) {
    const items = valueMatch[1]
      .split(/[、,，/或]/)
      .map((raw) => raw.trim().replace(/等$/, ''))
      .filter((v) => v.length > 0 && v.length <= 20 && !/从属|默认|统计|业务编号|项目|^\d{4}[-/年]/.test(v));
    if (items.length >= 2) for (const v of items) push(v, v);
  }

  return out.slice(0, 12);
}

/** 分级列描述归一：优先括号外（如「业务一级类别（如：…）」），否则括号内（如「所属行业（项目一级行业）」） */
function levelDescriptor(desc: string): string {
  const pattern = /^(.*?)([一二三四五六七八九十])级(分类|类别|行业)$/;
  const outside = desc.replace(/（[^）]*）/g, '').trim();
  if (pattern.test(outside)) return outside;
  const inside = desc.match(/（([^）]+)）/)?.[1]?.trim() || '';
  return pattern.test(inside) ? inside : '';
}

/** 识别「一级/二级/三级…分类」列族 → 层级 */
function buildHierarchies(tables: AutoBuildTable[], skipped: string[]): DraftHierarchy[] {
  const groups = new Map<string, { order: number; name: string; columns: string[]; source: string }>();
  const cnOrder: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

  for (const table of tables) {
    for (const col of table.columns || []) {
      const desc = levelDescriptor(text(col.description, 120));
      if (!desc) continue;
      const m = desc.match(/^(.*?)([一二三四五六七八九十])级(分类|类别|行业)$/);
      if (!m) continue;
      const prefix = m[1].trim();
      const suffix = m[3];
      const key = `${table.name}|${prefix}|${suffix}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          order: 0,
          name: prefix ? `${prefix}${suffix}层级` : `${themeName(table)}${suffix}层级`,
          columns: [],
          source: table.name,
        };
        groups.set(key, group);
      }
      group.columns.push(col.name);
      group.order = Math.max(group.order, cnOrder[m[2]] || 0);
    }
  }

  const out: DraftHierarchy[] = [];
  for (const group of groups.values()) {
    if (group.columns.length >= 2) {
      // 按中文序补全：列顺序由描述中的级别决定，调用方按原始顺序已近似正确
      out.push({
        name: group.name.slice(0, 50),
        levels: group.columns.slice(0, 10),
        reason: `识别到「${group.name}」分级列族（${group.columns.join(' → ')}）`,
      });
    }
  }

  // 地域层级：所属省 / 所属市 / 所属区县
  for (const table of tables) {
    const geo = (table.columns || []).filter((c) => /^所属(省|市|区|县|地区|城市)$/.test(firstSegment(text(c.description, 40))));
    const levels = ['省', '市', '区', '县', '地区', '城市']
      .map((suffix) => geo.find((c) => firstSegment(text(c.description, 40)) === `所属${suffix}`)?.name)
      .filter((x): x is string => Boolean(x));
    if (levels.length >= 2) {
      out.push({ name: '地域层级', levels: levels.slice(0, 10), reason: `识别到地域列族（${levels.join(' → ')}）` });
      break;
    }
  }

  if (out.length === 0) skipped.push('未识别到「一级/二级…」分级列族，业务层级未生成');
  return out.slice(0, MAX_AUTO_HIERARCHIES);
}

/** 从同表「编号 + 名称」列对生成实体（含跨表绑定合并） */
function buildEntities(tables: AutoBuildTable[], skipped: string[]): DraftEntity[] {
  interface Candidate {
    name: string;
    aliases: Set<string>;
    bindings: DraftBinding[];
    tables: Set<string>;
    reasons: string[];
    descriptions: string[];
  }

  const candidates = new Map<string, Candidate>();
  const add = (name: string, alias: string, binding: DraftBinding, reason: string, desc: string) => {
    const key = name.toLowerCase();
    let c = candidates.get(key);
    if (!c) {
      c = { name, aliases: new Set(), bindings: [], tables: new Set(), reasons: [], descriptions: [] };
      candidates.set(key, c);
    }
    // 别名只收业务化短词：过滤过长描述、斜杠并列与括号说明
    const aliasText = alias.trim();
    if (aliasText && aliasText !== name && aliasText.length <= 12 && !/[/（）()]/.test(aliasText)) {
      c.aliases.add(aliasText);
    }
    if (!c.tables.has(binding.tableName)) c.tables.add(binding.tableName);
    if (!c.bindings.some((b) => b.tableName === binding.tableName && b.columnName === binding.columnName)) {
      c.bindings.push(binding);
    }
    if (!c.reasons.includes(reason)) c.reasons.push(reason);
    if (desc && !c.descriptions.includes(desc)) c.descriptions.push(desc);
  };

  // 表主题实体：让「财务 / 主营业务」这类业务主题命中并参与圈表加权
  for (const table of tables) {
    const name = themeName(table);
    if (!name) continue;
    add(
      name,
      table.displayName || table.name,
      { tableName: table.name, columnName: '', role: 'IDENTITY' },
      `表主题「${table.displayName || table.name}」→ 表级绑定 ${table.name}`,
      table.description || ''
    );
    const dateCol = (table.columns || []).find((c) => /日期|时间/.test(c.description || '') && /RQ$|DATE$|TIME$/i.test(c.name));
    if (dateCol) {
      // 日期列只作关联键，不作为实体别名（SJRQ/BBRQ 并非业务主题的同义词）
      add(
        name,
        '',
        { tableName: table.name, columnName: dateCol.name, role: 'RELATION_KEY' },
        `日期列 ${dateCol.name} 作为时间维度关联键`,
        ''
      );
    }
  }

  // 编号 + 名称列对 → 业务维度实体
  let unpairedKeys = 0;
  for (const table of tables) {
    const columns = table.columns || [];
    const byName = new Map<string, AutoBuildColumn>();
    for (const c of columns) byName.set(c.name.toUpperCase(), c);

    for (const keyCol of columns) {
      const km = keyCol.name.match(/^(.+?)(BH|DM|ID)$/);
      if (!km) continue;
      const mc = byName.get(`${km[1]}MC`);
      if (!mc) {
        if (keyCol.isDimension !== false) unpairedKeys += 1;
        continue;
      }
      const keyDesc = text(keyCol.description, 100);
      const nameDesc = text(mc.description, 100);
      const keyConcept = conceptName(keyDesc);
      const nameConcept = conceptName(nameDesc);
      // 编号/名称列描述各含多个候选（如「债券代码/基金代码」）：仅取第一段一致的概念
      const keyFirst = conceptName(keyDesc.split('/')[0] || '');
      const nameFirst = conceptName(nameDesc.split('/')[0] || '');
      const concept = keyConcept && nameConcept && keyConcept === nameConcept ? keyConcept : keyFirst && keyFirst === nameFirst ? keyFirst : '';
      if (!concept || concept.length > 20) {
        if (keyFirst && nameFirst) {
          skipped.push(`列对 ${keyCol.name}/${mc.name} 的业务含义不明确（${keyFirst} / ${nameFirst}），未生成实体`);
        }
        continue;
      }
      const display = table.displayName || table.name;
      add(
        concept,
        keyCol.name,
        { tableName: table.name, columnName: keyCol.name, role: 'IDENTITY' },
        `${display} 的主标识列 ${keyCol.name}（IDENTITY）`,
        ''
      );
      add(
        concept,
        mc.name,
        { tableName: table.name, columnName: mc.name, role: 'ATTRIBUTE' },
        `${display} 的名称列 ${mc.name}（ATTRIBUTE）`,
        keyDesc || nameDesc
      );
      add(concept, keyDesc && keyDesc !== concept ? keyDesc : '', { tableName: table.name, columnName: keyCol.name, role: 'IDENTITY' }, '', '');
      if (nameDesc.replace(/名称$/, '') !== concept) {
        add(concept, nameDesc.replace(/名称$/, ''), { tableName: table.name, columnName: mc.name, role: 'ATTRIBUTE' }, '', '');
      }
    }
  }

  if (unpairedKeys > 0) {
    skipped.push(`${unpairedKeys} 个编号列未找到配对名称列，未生成实体（可在面板手动补充）`);
  }

  const list = [...candidates.values()].filter((c) => c.bindings.length > 0);
  // 排序：跨表出现次数优先，其次名称更短（更接近业务概念）
  list.sort((a, b) => b.tables.size - a.tables.size || a.name.length - b.name.length || a.name.localeCompare(b.name));

  return list.slice(0, MAX_AUTO_ENTITIES).map((c) => {
    const bindings = c.bindings.slice(0, BINDING_LIMIT);
    const tableNames = [...new Set(bindings.map((b) => b.tableName))];
    const descParts = c.descriptions.filter(Boolean);
    const description = (descParts[0] || `${c.name}（自动识别自 ${tableNames.join('、')}）`).slice(0, 300);
    return {
      name: c.name.slice(0, 50),
      entityType: entityTypeOf(c.name),
      aliases: [...c.aliases].slice(0, 10),
      description,
      bindings,
      reasons: c.reasons.slice(0, 6),
    };
  });
}

/** 跨表同名列（编号/代码类）→ 关联路径，默认大表 N : 小表 1 */
function buildRelations(tables: AutoBuildTable[], skipped: string[]): DraftRelation[] {
  if (tables.length < 2) return [];
  const out: DraftRelation[] = [];
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const a = tables[i];
      const b = tables[j];
      const aCols = new Map((a.columns || []).map((c) => [c.name.toUpperCase(), c]));
      const shared = (b.columns || []).filter((c) => isKeyColumn(c.name) && aCols.has(c.name.toUpperCase()) && c.isDimension !== false);
      for (const col of shared) {
        const aCol = aCols.get(col.name.toUpperCase()) as AutoBuildColumn;
        const aRows = typeof a.rowCount === 'number' ? a.rowCount : 0;
        const bRows = typeof b.rowCount === 'number' ? b.rowCount : 0;
        const from = aRows >= bRows ? a : b;
        const to = from === a ? b : a;
        const fromDesc = text(aCol.description, 60) || col.name;
        out.push({
          fromTable: from.name,
          fromColumns: [col.name],
          toTable: to.name,
          toColumns: [col.name],
          joinType: 'LEFT',
          cardinality: aRows > 0 && bRows > 0 && aRows !== bRows ? 'N:1' : '1:1',
          purpose: `按 ${fromDesc} 对齐「${from.displayName || from.name}」与「${to.displayName || to.name}」（自动推断，使用前请复核过滤条件与粒度）`.slice(0, 300),
          reason: `两表共有维度列 ${col.name}`,
        });
      }
    }
  }
  if (out.length === 0) skipped.push('两表之间未发现同名编号/代码类维度列，关联路径未生成');
  return out.slice(0, MAX_AUTO_RELATIONS);
}

/**
 * 代码与含义同形（如「取值如：主营业务、金融市场业务」的文本型分类列）时释义无增量：
 * 这些合法取值已随列说明进入 Schema 段，重复写入只会挤占关联路径/业务层级的注入预算。
 */
function isRedundantPair(code: string, meaning: string): boolean {
  return code === meaning;
}

/** 解析单列描述生成值域释义 */
function buildValueNotes(tables: AutoBuildTable[], skipped: string[]): DraftValueNote[] {
  const out: DraftValueNote[] = [];
  const seen = new Set<string>();
  let redundant = 0;
  for (const table of tables) {
    for (const col of table.columns || []) {
      // 指标列描述常含口径说明（如「BB=1 防重复」），不作为枚举来源
      if (col.isMetric === true) continue;
      const desc = text(col.description, 300);
      if (!desc) continue;
      const values = parseEnumValues(desc).filter((v) => v.code.toUpperCase() !== col.name.toUpperCase());
      if (values.length === 0) continue;
      for (const v of values) {
        if (isRedundantPair(v.code, v.meaning)) {
          redundant++;
          continue;
        }
        if (out.length >= MAX_AUTO_VALUE_NOTES) break;
        const key = `${table.name}.${col.name}.${v.code}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          tableName: table.name,
          columnName: col.name,
          valueCode: v.code,
          meaning: v.meaning,
          reason: `列描述中识别到枚举「${v.code}=${v.meaning}」`,
        });
      }
    }
  }
  if (redundant > 0) {
    skipped.push(`${redundant} 条「代码与含义同形」的文本型取值未生成值域释义（合法取值已在 Schema 列说明中）`);
  }
  if (out.length === 0) skipped.push('列描述中未识别到「值=含义 / 取值：…」枚举，值域释义未生成');
  return out;
}

/**
 * 生成业务本体草案（主入口）。
 * 输入为数据源 schema_json 的表结构数组；纯函数，无副作用。
 */
export function buildOntologyDraft(input: AutoBuildTable[]): OntologyDraft {
  const skipped: string[] = [];
  const tables: AutoBuildTable[] = [];
  const seenTables = new Set<string>();
  for (const raw of Array.isArray(input) ? input : []) {
    const name = text(raw?.name, 64);
    if (!name || !IDENT_RE.test(name) || seenTables.has(name.toLowerCase())) {
      if (name) skipped.push(`表名非法或重复，已跳过：${name}`);
      continue;
    }
    const columns = (Array.isArray(raw?.columns) ? raw!.columns : [])
      .map((c) => ({ ...c, name: text(c?.name, 64) }))
      .filter((c) => Boolean(c.name) && IDENT_RE.test(c.name));
    seenTables.add(name.toLowerCase());
    tables.push({ ...raw, name, columns });
  }

  if (tables.length === 0) {
    return {
      entities: [],
      valueNotes: [],
      relations: [],
      hierarchies: [],
      skipped: ['数据源未提供有效表结构，请先在「数据源与 Schema」完成提取'],
      stats: { tables: 0, columns: 0, entities: 0, bindings: 0, valueNotes: 0, relations: 0, hierarchies: 0 },
    };
  }

  const entities = buildEntities(tables, skipped);
  const valueNotes = buildValueNotes(tables, skipped);
  const relations = buildRelations(tables, skipped);
  const hierarchies = buildHierarchies(tables, skipped);

  const columns = tables.reduce((sum, t) => sum + (t.columns?.length || 0), 0);
  const bindings = entities.reduce((sum, e) => sum + e.bindings.length, 0);

  return {
    entities,
    valueNotes,
    relations,
    hierarchies,
    skipped: skipped.slice(0, 20),
    stats: {
      tables: tables.length,
      columns,
      entities: entities.length,
      bindings,
      valueNotes: valueNotes.length,
      relations: relations.length,
      hierarchies: hierarchies.length,
    },
  };
}
