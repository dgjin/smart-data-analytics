/**
 * 铁律规则库（v0.9.35）：管理员按数据源登记的问数强制规则（口径红线/禁区/固定约束）。
 * 与语义指标库的差异：
 * - 指标库是「命中才注入」的检索式口径补充；铁律是该数据源全部 ACTIVE 规则「全量恒注入」阶段一 prompt，
 *   每次问数/报表生成 SQL 都必须逐条遵守，优先级高于样例与知识片段；
 * - 仅 ADMIN 可维护（创建即生效，无提议-审批流），保证规则权威性；
 * - 规则文本仅注入 prompt（不直接拼接 SQL），生成结果仍过安全执行层校验。
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { getPool } from '../infra/db';

export type IronRuleStatus = 'ACTIVE' | 'DISABLED';

export interface IronRule {
  id?: number;
  dataSourceId: string;
  /** 规则标题（数据源内唯一），如「禁止跨法人统计」 */
  title: string;
  /** 规则正文（自然语言描述，直接注入 prompt 约束 SQL 生成） */
  content: string;
  status: IronRuleStatus;
  createdBy?: string;
}

/** 每个数据源的铁律条数上限（prompt 注入体积保护） */
const MAX_IRON_RULES_PER_DS = 100;

/** 校验并规整铁律输入；非法时返回 error 说明（路由层据此 400） */
export function sanitizeIronRuleInput(input: any): { ok: true; rule: Omit<IronRule, 'id'> } | { ok: false; error: string } {
  const dataSourceId = typeof input?.dataSourceId === 'string' ? input.dataSourceId.trim() : '';
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const content = typeof input?.content === 'string' ? input.content.trim() : '';

  if (!dataSourceId) return { ok: false, error: '缺少 dataSourceId' };
  if (!title || title.length > 100) return { ok: false, error: '规则标题必填且不超过 100 字' };
  if (!content || content.length > 2000) return { ok: false, error: '规则正文必填且不超过 2000 字' };

  return {
    ok: true,
    rule: { dataSourceId, title, content, status: input?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE' },
  };
}

/** 铁律 prompt 段：全量 ACTIVE 规则恒注入阶段一，措辞强于指标层（最高优先级逐条遵守） */
export function buildIronRulesPrompt(rules: IronRule[]): string {
  if (rules.length === 0) return '';
  const lines = rules.map((r) => `- 【${r.title}】${r.content}`);
  return `【铁律规则】（管理员登记的本数据源强制规则，最高优先级，高于一切样例与知识片段。生成 SQL 时必须逐条严格遵守，不得违反；若用户问题或样例与铁律冲突，一律按铁律执行）:\n${lines.join('\n')}\n\n`;
}

// ---------- CRUD（routes/ironRules.ts 调用，全 ADMIN） ----------

function rowToRule(r: any): IronRule {
  return {
    id: Number(r.id),
    dataSourceId: String(r.data_source_id),
    title: String(r.title),
    content: String(r.content),
    status: r.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    createdBy: String(r.created_by || ''),
  };
}

/** 管理面板列表（按创建顺序，与 prompt 注入顺序一致） */
export async function listIronRules(dataSourceId: string): Promise<IronRule[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM iron_rules WHERE data_source_id = ? ORDER BY id ASC LIMIT ?',
    [dataSourceId, MAX_IRON_RULES_PER_DS]
  );
  return rows.map(rowToRule);
}

/** 问数/报表链路专用：全量取启用铁律（上限保护，失败由调用方 catch 降级） */
export async function loadActiveIronRules(dataSourceId: string): Promise<IronRule[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT * FROM iron_rules WHERE data_source_id = ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT ?",
    [dataSourceId, MAX_IRON_RULES_PER_DS]
  );
  return rows.map(rowToRule);
}

/** 创建铁律（仅 ADMIN，直接生效）：同数据源标题唯一 + 每源条数上限 */
export async function createIronRule(rule: Omit<IronRule, 'id'>, createdBy: string): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const pool = getPool();
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM iron_rules WHERE data_source_id = ? AND title = ? LIMIT 1',
    [rule.dataSourceId, rule.title]
  );
  if (dup.length > 0) return { ok: false, error: '同标题铁律已存在' };
  const [cnt] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS c FROM iron_rules WHERE data_source_id = ?',
    [rule.dataSourceId]
  );
  if (Number(cnt[0]?.c || 0) >= MAX_IRON_RULES_PER_DS) {
    return { ok: false, error: `每个数据源最多 ${MAX_IRON_RULES_PER_DS} 条铁律` };
  }
  const [result] = await pool.query<ResultSetHeader>(
    'INSERT INTO iron_rules (data_source_id, title, content, status, created_by) VALUES (?, ?, ?, ?, ?)',
    [rule.dataSourceId, rule.title, rule.content, rule.status, createdBy]
  );
  return { ok: true, id: result.insertId };
}

/** 更新铁律（仅 ADMIN；数据源归属不可变） */
export async function updateIronRule(id: number, rule: Omit<IronRule, 'id' | 'dataSourceId'>): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const pool = getPool();
  const [existing] = await pool.query<RowDataPacket[]>(
    'SELECT data_source_id FROM iron_rules WHERE id = ? LIMIT 1',
    [id]
  );
  if (existing.length === 0) return { ok: false, error: '铁律不存在', notFound: true };
  const [dup] = await pool.query<RowDataPacket[]>(
    'SELECT id FROM iron_rules WHERE data_source_id = ? AND title = ? AND id <> ? LIMIT 1',
    [String(existing[0].data_source_id), rule.title, id]
  );
  if (dup.length > 0) return { ok: false, error: '同标题铁律已存在' };
  await pool.query(
    'UPDATE iron_rules SET title = ?, content = ?, status = ? WHERE id = ?',
    [rule.title, rule.content, rule.status, id]
  );
  return { ok: true };
}

export async function deleteIronRule(id: number): Promise<boolean> {
  const [result] = await getPool().query<ResultSetHeader>('DELETE FROM iron_rules WHERE id = ?', [id]);
  return result.affectedRows > 0;
}

// ---------- 导入导出（管理员备份/迁移，与指标库导入导出同模式） ----------

/** 导出文件中的单条铁律（剥离库内 id 与创建痕迹） */
export interface IronRuleExportItem {
  title: string;
  content: string;
  status: IronRuleStatus;
}

/** 铁律库导出文件格式（JSON 备份） */
export interface IronRulesExportFile {
  version: '1.0';
  type: 'iron-rules';
  exportedAt: string;
  exportedBy: string;
  dataSourceId: string;
  dataSourceName: string;
  ruleCount: number;
  rules: IronRuleExportItem[];
}

/** 组装铁律库导出文件（纯函数可单测） */
export function buildIronRulesExport(
  dataSourceId: string,
  dataSourceName: string,
  rules: IronRule[],
  exportedBy: string
): IronRulesExportFile {
  return {
    version: '1.0',
    type: 'iron-rules',
    exportedAt: new Date().toISOString(),
    exportedBy,
    dataSourceId,
    dataSourceName,
    ruleCount: rules.length,
    rules: rules.map((r) => ({ title: r.title, content: r.content, status: r.status })),
  };
}

/** 铁律导入冲突处理策略：同标题跳过 / 覆盖更新（标题在数据源内唯一） */
export type IronRuleMergeStrategy = 'skip' | 'overwrite';

export interface IronRuleImportResult {
  success: boolean;
  dryRun: boolean;
  mergeStrategy: IronRuleMergeStrategy;
  importedCount: number;
  updatedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: Array<{ title: string; message: string }>;
  summary: { totalItems: number; newItems: number; conflictItems: number; invalidItems: number };
}

/** 单次导入文件条目上限（防滥用） */
const MAX_IMPORT_ITEMS = 500;

/**
 * 从导出文件恢复铁律到指定数据源（仅 ADMIN 经路由调用）。
 * - 每条经 sanitizeIronRuleInput 校验（与手工创建同一安全口径）；
 * - 冲突判定：目标数据源下同标题；skip 跳过，overwrite 覆盖更新；
 * - 文件内部同标题：首条处理后记入冲突集合，后续按冲突策略处理（与指标库导入语义一致）；
 * - dryRun 仅统计不写库。
 */
export async function importIronRules(
  dataSourceId: string,
  items: unknown[],
  strategy: IronRuleMergeStrategy,
  dryRun: boolean,
  actor: string
): Promise<IronRuleImportResult> {
  const result: IronRuleImportResult = {
    success: true,
    dryRun,
    mergeStrategy: strategy,
    importedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    errors: [],
    summary: { totalItems: items.length, newItems: 0, conflictItems: 0, invalidItems: 0 },
  };

  // 冲突判定依据：目标数据源现有 标题 → id 映射
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT id, title FROM iron_rules WHERE data_source_id = ?',
    [dataSourceId]
  );
  const existingByTitle = new Map<string, number>(rows.map((r: any) => [String(r.title), Number(r.id)]));

  for (const raw of items.slice(0, MAX_IMPORT_ITEMS)) {
    const title = typeof (raw as any)?.title === 'string' ? String((raw as any).title).trim() : '';
    const cleaned = sanitizeIronRuleInput({ ...(raw as object), dataSourceId });
    if (cleaned.ok !== true) {
      result.summary.invalidItems++;
      result.errorCount++;
      result.errors.push({ title: title || '(无标题)', message: cleaned.error });
      continue;
    }
    const conflictId = existingByTitle.get(cleaned.rule.title);
    try {
      if (conflictId !== undefined) {
        result.summary.conflictItems++;
        if (strategy === 'skip') {
          result.skippedCount++;
          continue;
        }
        // overwrite：覆盖更新（id < 0 为 dryRun 占位，跳过真实写库）
        if (!dryRun) {
          const { dataSourceId: _ignored, ...rest } = cleaned.rule;
          const r = await updateIronRule(conflictId, rest);
          if (r.ok !== true) throw new Error(r.error);
        }
        result.updatedCount++;
        continue;
      }
      result.summary.newItems++;
      if (!dryRun) {
        const r = await createIronRule(cleaned.rule, actor);
        if (r.ok !== true) throw new Error(r.error);
        // 文件内部同标题：首条入库后记入冲突集合，后续同标题条目按冲突策略处理
        existingByTitle.set(cleaned.rule.title, r.id);
      } else {
        existingByTitle.set(cleaned.rule.title, -1);
      }
      result.importedCount++;
    } catch (err: any) {
      result.errorCount++;
      result.errors.push({ title: cleaned.rule.title, message: err?.message || '未知错误' });
    }
  }

  result.success = result.errorCount === 0;
  return result;
}
