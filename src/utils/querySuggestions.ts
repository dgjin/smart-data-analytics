import { ColumnSchema, DataScope, TableSchema } from '../types/analytics';
import { applyDataScope } from './dataScope';

/**
 * 智能问数推荐问题生成：完全基于所选数据源的真实表结构（应用问数范围 scope 过滤后），
 * 按指标/维度标注（缺失时按列类型回退推导）组合出多种分析意图的自然语言提示，
 * 替代一切硬编码示例，保证提示内容与实际可查询的数据一致。
 */

/** 列的可读标签：优先中文描述，剥掉括号注释（如 "销售金额(元)" → "销售金额"），回退列名 */
function colLabel(c: ColumnSchema): string {
  const raw = (c.description || c.name).trim();
  return raw.replace(/[(（][^)）]*[)）]/g, '').trim() || c.name;
}

/** 表的可读标签：优先显示名，回退表名 */
function tableLabel(t: TableSchema): string {
  return (t.displayName || t.name).trim();
}

function isMetricCol(c: ColumnSchema): boolean {
  if (c.isMetric) return true;
  if (c.isDimension || c.isPrimaryKey) return false;
  // 回退推导：未标注时数值列视为指标
  return c.type === 'number';
}

function isDimensionCol(c: ColumnSchema): boolean {
  if (c.isDimension) return true;
  if (c.isMetric || c.isPrimaryKey) return false;
  // 回退推导：日期/类别/短文本列视为维度
  return c.type === 'date' || c.type === 'category' || c.type === 'string';
}

/**
 * 基于真实 Schema 生成推荐问题（已应用 scope 白名单过滤）。
 * 跨表轮转取模板，保证多张表都有曝光；结果去重并以 max 为上限。
 */
export function generateSchemaSuggestions(
  tables: TableSchema[],
  scope?: DataScope | null,
  max: number = 12
): string[] {
  const scoped = applyDataScope(Array.isArray(tables) ? tables : [], scope);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };

  // 第一轮：每表产出 1 条"趋势/分布"主推荐，保证表间覆盖
  for (const t of scoped) {
    const metrics = t.columns.filter(isMetricCol);
    const dims = t.columns.filter(isDimensionCol);
    const dateDim = dims.find((c) => c.type === 'date');
    const tn = tableLabel(t);
    if (metrics.length > 0 && dateDim) {
      push(`分析 ${tn} 的 ${colLabel(metrics[0])} 按 ${colLabel(dateDim)} 的变化趋势`);
    } else if (metrics.length > 0 && dims.length > 0) {
      push(`分析 ${tn} 的 ${colLabel(metrics[0])} 按 ${colLabel(dims[0])} 分布`);
    } else if (dims.length > 0) {
      push(`统计 ${tn} 各 ${colLabel(dims[0])} 的记录数量`);
    } else if (metrics.length > 0) {
      push(`统计 ${tn} 的 ${colLabel(metrics[0])} 总和与平均值`);
    }
  }

  // 第二轮：每表产出"对比/TopN/占比"等进阶推荐，扩充候选池
  for (const t of scoped) {
    const metrics = t.columns.filter(isMetricCol);
    const dims = t.columns.filter(isDimensionCol);
    const tn = tableLabel(t);
    if (metrics.length > 0 && dims.length > 0) {
      const m0 = colLabel(metrics[0]);
      const d0 = colLabel(dims[0]);
      push(`对比 ${tn} 不同 ${d0} 的 ${m0}`);
      push(`查询 ${tn} 中 ${m0} 最高的前10个 ${d0}`);
      push(`统计 ${tn} 各 ${d0} 的 ${m0} 占比`);
      if (metrics.length > 1 && dims.length > 1) {
        push(`分析 ${tn} 的 ${colLabel(metrics[1])} 按 ${colLabel(dims[1])} 分布`);
      }
    }
  }

  return out.slice(0, max);
}

/** 组装输入框占位提示：带一条真实推荐示例，超长截断 */
export function buildQueryPlaceholder(suggestions: string[], fallback: string): string {
  const first = suggestions[0];
  if (!first) return fallback;
  const clipped = first.length > 36 ? `${first.slice(0, 36)}...` : first;
  return `用自然语言提问，如：${clipped}`;
}
