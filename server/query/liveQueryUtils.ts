/**
 * liveQuery 纯函数工具层：金额单位口径、真实 rows 后处理与统计、自纠错候选数、
 * 结果签名（多数表决）、阶段二规则化降级解读、英文标识符中文化兜底（v0.5.1 自报表链路下沉复用）。
 * 零 LLM/IO 依赖，供编排层与测试复用。
 */
import type { SchemaTable } from './schemaTypes';

export const VALID_STAGE1_CHARTS = ['bar', 'line', 'area', 'pie', 'donut', 'radar', 'scatter', 'treemap', 'heatmap'] as const;

/** 问数金额单位选项：用户问数前自选，SQL 生成时按除数换算（divisor=元为原值） */
export const AMOUNT_UNIT_OPTIONS: Record<string, { label: string; divisor: number; suffix: string }> = {
  '亿元': { label: '亿元', divisor: 100000000, suffix: 'yi' },
  '百万元': { label: '百万元', divisor: 1000000, suffix: 'baiwan' },
  '万元': { label: '万元', divisor: 10000, suffix: 'wan' },
  '元': { label: '元', divisor: 1, suffix: 'yuan' },
};

/** 金额单位白名单归一：非白名单值返回 undefined（不注入约定，保持原值口径） */
export function normalizeAmountUnit(v: unknown): string | undefined {
  const s = String(v || '').trim();
  return AMOUNT_UNIT_OPTIONS[s] ? s : undefined;
}

/** 金额单位 prompt 约定：拼在阶段一用户消息首位，指令 SQL 对金额列统一除以除数并带单位后缀；v0.5.2 起导出供报表链路复用；v0.9.41 补优先级声明（界面选定等同用户明确要求，解除与 system 内「金额原值保护」规则的语义冲突） */
export function buildAmountUnitPrompt(unit?: string): string {
  const opt = unit ? AMOUNT_UNIT_OPTIONS[unit] : undefined;
  if (!opt) return '';
  return `【金额单位约定】本次查询所有金额类指标统一以「${opt.label}」为单位输出：SQL 中对金额列聚合结果除以 ${opt.divisor} 并用 ROUND 保留两位小数（如 ROUND(SUM(金额列)/${opt.divisor}, 2)），别名带 _${opt.suffix} 后缀，列名/图表/解读沿用该单位。该约定由用户在界面选定，等同于用户明确要求，优先于「金额原值保护」规则。${opt.divisor === 1 ? '「元」为原值口径：直接 ROUND(SUM(金额列), 2)，不要除以 1。' : ''}\n\n`;
}

// ---------- 真实 rows 后处理与统计 ----------

/** mysql2 将 DECIMAL/聚合值返回为字符串；把可安全转换的列统一转为 number，便于图表与统计 */
export function coerceNumericColumns(rows: Record<string, any>[]): Record<string, any>[] {
  if (rows.length === 0) return rows;
  const cols = Object.keys(rows[0]);
  const numericCols = cols.filter((c) => {
    let seen = 0;
    for (const r of rows.slice(0, 50)) {
      const v = r[c];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number') { seen++; continue; }
      if (typeof v === 'string' && /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim())) { seen++; continue; }
      return false;
    }
    return seen > 0;
  });
  if (numericCols.length === 0) return rows;
  return rows.map((r) => {
    const next: Record<string, any> = { ...r };
    for (const c of numericCols) {
      const v = next[c];
      if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) next[c] = n;
      }
    }
    return next;
  });
}

/** 列统计摘要：数值列给 sum/avg/min/max，维度列给 distinct，辅助阶段二不编造数值 */
export function buildColumnStats(rows: Record<string, any>[]): Record<string, any> {
  if (rows.length === 0) return {};
  const stats: Record<string, any> = {};
  for (const c of Object.keys(rows[0])) {
    const nums = rows
      .map((r) => r[c])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (nums.length >= Math.max(1, Math.floor(rows.length * 0.5))) {
      const sum = nums.reduce((a, b) => a + b, 0);
      stats[c] = {
        总计: Math.round(sum * 100) / 100,
        均值: Math.round((sum / nums.length) * 100) / 100,
        最小: Math.min(...nums),
        最大: Math.max(...nums),
      };
    } else {
      const distinct = new Set(rows.map((r) => String(r[c]))).size;
      stats[c] = { 去重取值数: distinct };
    }
  }
  return stats;
}

/** 矫正图表轴键：必须与真实 rows 的列名一致，否则前端渲染空白 */
export function rectifyChartKeys(
  rows: Record<string, any>[],
  xAxisKey: unknown,
  yAxisKeys: unknown
): { xAxisKey: string; yAxisKeys: string[] } {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  const numericCols = cols.filter((c) => rows.some((r) => typeof r[c] === 'number'));
  const dimCols = cols.filter((c) => !numericCols.includes(c));

  let x = typeof xAxisKey === 'string' && cols.includes(xAxisKey) ? xAxisKey : '';
  if (!x) x = dimCols[0] || cols[0] || '';

  let ys = Array.isArray(yAxisKeys)
    ? yAxisKeys.filter((k): k is string => typeof k === 'string' && cols.includes(k))
    : [];
  if (ys.length === 0) ys = numericCols.length > 0 ? numericCols.slice(0, 3) : cols.filter((c) => c !== x).slice(0, 1);
  return { xAxisKey: x, yAxisKeys: ys };
}

/**
 * 组装结果列的中文表头映射：schema 列 description（管理员维护）为底，
 * yAxisNames / LLM columnNames 覆盖（聚合别名的中文名只有 LLM 知道）。
 * 只保留真实出现在结果行中的列，键全部限定为白名单内的列名。
 */
export function buildColumnNames(
  rows: Array<Record<string, unknown>>,
  schema: SchemaTable[],
  ...overrides: Array<Record<string, string> | undefined>
): Record<string, string> {
  const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
  if (cols.length === 0) return {};
  const out: Record<string, string> = {};
  const tables = Array.isArray(schema) ? schema : [];
  for (const col of cols) {
    for (const t of tables) {
      const c = (t?.columns || []).find((x) => x && x.name === col);
      if (c && typeof c.description === 'string' && c.description.trim()) {
        out[col] = c.description.trim();
        break;
      }
    }
  }
  for (const map of overrides) {
    if (!map || typeof map !== 'object') continue;
    for (const col of cols) {
      const v = map[col];
      if (typeof v !== 'string' || !v.trim()) continue;
      const val = v.trim().slice(0, 50);
      // 铁律兜底：override 值不含中文时，不允许盖掉已有的中文表头（防 LLM 英文占位值盖 schema 中文底）
      if (!/[\u4e00-\u9fff]/.test(val) && out[col] && /[\u4e00-\u9fff]/.test(out[col])) continue;
      out[col] = val;
    }
  }
  return out;
}

/**
 * v0.5.1 报表文案中文化（自 report/liveReport 下沉，问数/报表双链路复用）：
 * 从 schema 提取「英文标识符 → 中文名」映射。覆盖表名（name → displayName）与列名（name → description），
 * 供 prompt 注入与服务端兜底替换。
 */
export function buildIdentifierNameMap(schema: SchemaTable[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const t of Array.isArray(schema) ? schema : []) {
    if (!t || typeof t.name !== 'string' || !t.name.trim()) continue;
    const tableCn = typeof t.displayName === 'string' && t.displayName.trim() ? t.displayName.trim() : '';
    if (tableCn && tableCn !== t.name) map[t.name] = tableCn;
    for (const c of Array.isArray(t.columns) ? t.columns : []) {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) continue;
      const colCn = typeof c.description === 'string' && c.description.trim() ? c.description.trim() : '';
      // 列名映射不覆盖已有表名映射；同名取先出现者
      if (colCn && colCn !== c.name && !map[c.name]) map[c.name] = colCn;
    }
  }
  return map;
}

/** 转义正则元字符 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 文案中文化兜底：将文本中出现的英文表名/列名替换为中文名。
 * 规则：
 * - 标识符边界匹配（前后不能是字母/数字/下划线），避免误伤包含关系
 * - 长标识符优先替换（防短名先替换导致长名残留）
 * - 优先连同【】/[]/引号包裹符一起替换（如【dn_tzsy】→ 中文名，而非【中文名】）
 */
export function replaceIdentifiersWithChinese(text: string, nameMap: Record<string, string>): string {
  if (!text || typeof text !== 'string') return text;
  const keys = Object.keys(nameMap).sort((a, b) => b.length - a.length);
  if (keys.length === 0) return text;
  let out = text;
  for (const key of keys) {
    const cn = nameMap[key];
    if (!cn) continue;
    // 注意：字符串层 \[ / \] 会产生正则层的转义方括号，避免字符类提前闭合
    const wrapped = new RegExp('[【\\[\u300c\'"]' + escapeRegExp(key) + '[\\]】\u300d\'"]', 'g');
    out = out.replace(wrapped, cn);
    const bare = new RegExp('(?<![A-Za-z0-9_])' + escapeRegExp(key) + '(?![A-Za-z0-9_])', 'g');
    out = out.replace(bare, cn);
  }
  return out;
}

/**
 * 铁律「表头及说明必须中文」服务端兜底（v0.9.39）：LLM 未遵守时，
 * 将问数结果中残留的英文表名/列名替换为 schema 业务中文名。
 * 覆盖表头值、图表轴名/标题、推导过程与阶段二全部文案字段；
 * 无法映射的别名保持原值（如实兜底，不编造中文名）。
 */
export function sanitizeQueryResultChinese<T extends Record<string, any>>(result: T, schema: SchemaTable[]): T {
  const nameMap = buildIdentifierNameMap(schema);
  if (Object.keys(nameMap).length === 0) return result;
  const fix = (s: unknown): unknown => (typeof s === 'string' ? replaceIdentifiersWithChinese(s, nameMap) : s);
  /** 清洗 string 映射的每个值（columnNames / yAxisNames） */
  const fixMap = (m: unknown): unknown => {
    if (!m || typeof m !== 'object') return m;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) out[k] = fix(v);
    return out;
  };
  const out: Record<string, any> = { ...result };
  out.columnNames = fixMap(out.columnNames);
  if (out.chartConfig && typeof out.chartConfig === 'object') {
    const cc = { ...(out.chartConfig as Record<string, unknown>) };
    cc.title = fix(cc.title);
    cc.xAxisName = fix(cc.xAxisName);
    cc.yAxisNames = fixMap(cc.yAxisNames);
    out.chartConfig = cc;
  }
  out.aiExplanation = fix(out.aiExplanation);
  if (Array.isArray(out.keyInsights)) out.keyInsights = out.keyInsights.map(fix);
  if (Array.isArray(out.suggestedQuestions)) out.suggestedQuestions = out.suggestedQuestions.map(fix);
  if (Array.isArray(out.thoughtProcess)) out.thoughtProcess = out.thoughtProcess.map(fix);
  if (Array.isArray(out.kpiMetrics)) {
    out.kpiMetrics = out.kpiMetrics.map((k) => {
      if (!k || typeof k !== 'object') return k;
      const nk = { ...(k as Record<string, unknown>) };
      nk.label = fix(nk.label);
      nk.subtext = fix(nk.subtext);
      nk.change = fix(nk.change);
      return nk;
    });
  }
  return out as T;
}

/**
 * P1-B/P1-7 自纠错候选数（借鉴 DB-GPT Self-consistency 思想）。
 * 多候选 SQL 生成后逐候选执行、结果集多数表决择优，提升复杂问题准确率。
 * P1-7 分档触发：未显式配置时按问题结构复杂度分档——复杂问题（多表/嵌套/需清洗链）3 候选，
 * 简单问题保持 1 以控成本；env SELF_CORRECT_CANDIDATES 显式设置（1-3）时优先于分档（1 = 强制关闭多候选）。
 */
export function selfCorrectCandidates(complex?: boolean): number {
  const raw = process.env.SELF_CORRECT_CANDIDATES;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n <= 1 ? 1 : Math.min(3, Math.floor(n));
  }
  return complex === true ? 3 : 1;
}

/** 结果集规范化签名（多数表决用）：列名排序 + 数值列归一，消除列序/数值字符串差异 */
export function resultSignature(rows: Record<string, any>[]): string {
  const normalized = coerceNumericColumns(rows).map((r) => {
    const sorted: Record<string, any> = {};
    for (const k of Object.keys(r).sort()) sorted[k] = r[k];
    return sorted;
  });
  return JSON.stringify(normalized);
}

// ---------- 阶段二：真实 rows → 分析解读 ----------

/**
 * 阶段二异常降级：基于列统计生成规则化解读（不依赖 LLM）。
 * 当 LLM 调用失败/超时/返回无效 JSON 时，用已有 stats + rows 构造有数据支撑的解读，
 * 避免 "查询返回 N 行" 这种无信息量的兜底文案。
 */
export function buildFallbackAnalysis(
  rows: Array<Record<string, unknown>>,
  stats: Record<string, { 总计?: number; 均值?: number; 最小?: number | string; 最大?: number | string; 去重取值数?: number }>,
  columnNames: Record<string, string>,
  chartConfig: { xAxisKey?: string; yAxisKeys?: string[] }
): { aiExplanation: string; keyInsights: string[]; kpiMetrics: Array<{ label: string; value: string; subtext: string }> } {
  const rowCount = rows.length;
  // 数值列统计四字段同生同灭（buildColumnStats 一次写入 总计/均值/最小/最大），守卫判定 总计 后按完整形态使用
  type NumericStat = { 总计: number; 均值: number; 最小: number | string; 最大: number | string };
  const isNumericStat = (v: { 总计?: number } | undefined): v is NumericStat => !!v && typeof v.总计 === 'number';
  const numericStats = new Map<string, NumericStat>();
  for (const [key, value] of Object.entries(stats)) {
    if (isNumericStat(value)) numericStats.set(key, value);
  }
  const numericCols = [...numericStats.keys()];
  const dimCols = Object.keys(stats).filter((c) => !numericStats.has(c));

  // 1. aiExplanation：按数据特征组织
  const parts: string[] = [];
  parts.push(`查询共返回 ${rowCount} 条记录`);

  if (numericCols.length > 0) {
    const top = numericCols.slice(0, 2);
    const descs = top.map((c) => {
      const s = numericStats.get(c)!;
      const name = columnNames[c] || c;
      return `${name}总计 ${s.总计.toLocaleString('zh-CN')}，均值 ${s.均值.toLocaleString('zh-CN')}，区间 ${s.最小} ~ ${s.最大}`;
    });
    parts.push(`；${descs.join('；')}`);
  }

  if (dimCols.length > 0) {
    const d = dimCols[0];
    const name = columnNames[d] || d;
    parts.push(`；按${name}划分共 ${stats[d].去重取值数} 个维度`);
  }

  if (chartConfig.xAxisKey && chartConfig.yAxisKeys && chartConfig.yAxisKeys.length > 0) {
    const xName = columnNames[chartConfig.xAxisKey] || chartConfig.xAxisKey;
    parts.push(`，图表以 ${xName} 为维度展示`);
  }

  parts.push('。');

  // 2. keyInsights：从 stats 中提取 3 条
  const insights: string[] = [];
  if (numericCols.length > 0) {
    const c = numericCols[0];
    const s = numericStats.get(c)!;
    const name = columnNames[c] || c;
    insights.push(`${name}最高达 ${s.最大.toLocaleString('zh-CN')}，最低 ${s.最小.toLocaleString('zh-CN')}，波动幅度较大`);
    if (numericCols.length > 1) {
      const c2 = numericCols[1];
      const s2 = numericStats.get(c2)!;
      const name2 = columnNames[c2] || c2;
      insights.push(`${name2}均值为 ${s2.均值.toLocaleString('zh-CN')}，总计 ${s2.总计.toLocaleString('zh-CN')}`);
    }
  }
  if (dimCols.length > 0 && insights.length < 3) {
    const d = dimCols[0];
    const name = columnNames[d] || d;
    insights.push(`按${name}细分共 ${stats[d].去重取值数} 个分组，可进一步下钻分析`);
  }

  // 3. kpiMetrics：取前 2 个数值列做 KPI 卡片
  const kpis: Array<{ label: string; value: string; subtext: string }> = [];
  for (const c of numericCols.slice(0, 2)) {
    const s = numericStats.get(c)!;
    const name = columnNames[c] || c;
    kpis.push({ label: `${name}（总计）`, value: s.总计.toLocaleString('zh-CN'), subtext: `均值 ${s.均值.toLocaleString('zh-CN')}` });
    kpis.push({ label: `${name}（峰值）`, value: s.最大.toLocaleString('zh-CN'), subtext: `最小 ${s.最小.toLocaleString('zh-CN')}` });
  }

  return {
    aiExplanation: parts.join(''),
    keyInsights: insights.slice(0, 3),
    kpiMetrics: kpis.slice(0, 4),
  };
}
