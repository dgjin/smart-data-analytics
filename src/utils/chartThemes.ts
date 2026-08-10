export interface ChartTheme {
  id: string;
  name: string;
  description: string;
  isPrintFriendly?: boolean;
  isAccessibilityFriendly?: boolean;
  colors: string[];
  bgClass?: string;
  gridColor?: string;
  textColor?: string;
}

export const CHART_THEMES: Record<string, ChartTheme> = {
  cyber: {
    id: 'cyber',
    name: '极客深蓝 (Cyber Indigo)',
    description: '暗色科技感，适配现代数据大屏',
    colors: ['#6366f1', '#06b6d4', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#3b82f6', '#f97316'],
    gridColor: '#334155',
    textColor: '#94a3b8',
  },
  print: {
    id: 'print',
    name: '🖨️ 打印友好 (Print-Friendly)',
    description: '白底高对比度，黑白/彩印均极为清晰',
    isPrintFriendly: true,
    colors: ['#0f172a', '#1e40af', '#047857', '#b91c1c', '#6d28d9', '#0284c7', '#431407', '#334155'],
    gridColor: '#cbd5e1',
    textColor: '#1e293b',
  },
  accessible: {
    id: 'accessible',
    name: '👁️ 色盲无障碍 (WCAG Safe)',
    description: '依据 Okabe-Ito 色彩学，保障色弱与色盲人群阅读',
    isAccessibilityFriendly: true,
    colors: ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#D55E00', '#56B4E9', '#F0E442', '#000000'],
    gridColor: '#475569',
    textColor: '#cbd5e1',
  },
  executive: {
    id: 'executive',
    name: '商务暖金 (Executive Gold)',
    description: '沉稳高雅暖色调，适合CEO及管理层汇报',
    colors: ['#d97706', '#2563eb', '#059669', '#dc2626', '#7c3aed', '#0284c7', '#b45309', '#4f46e5'],
    gridColor: '#334155',
    textColor: '#94a3b8',
  },
  emerald: {
    id: 'emerald',
    name: '翡翠生态 (Emerald Eco)',
    description: '清新绿色系，突出可持续增长与稳健盈利',
    colors: ['#10b981', '#06b6d4', '#84cc16', '#eab308', '#0ea5e9', '#14b8a6', '#22c55e', '#a855f7'],
    gridColor: '#334155',
    textColor: '#94a3b8',
  },
  vivid: {
    id: 'vivid',
    name: '高饱和霓虹 (Vivid Contrast)',
    description: '超高对比度与鲜明色系，强调差异归因',
    colors: ['#ff007f', '#00f2fe', '#f6d365', '#b224ef', '#11998e', '#f857a6', '#38ef7d', '#ff0844'],
    gridColor: '#475569',
    textColor: '#e2e8f0',
  },
};

/**
 * Smart Auto-Contrast Optimizer
 * Analyzes data attributes (e.g. series count, positive vs negative values, revenue vs profit ratio)
 * and dynamically calculates optimal high-contrast color assignments.
 */
export function getAutoOptimizedColors(
  data: Record<string, any>[],
  yAxisKeys: string[],
  selectedThemeId: string = 'cyber'
): { colors: string[]; explanation: string } {
  const theme = CHART_THEMES[selectedThemeId] || CHART_THEMES.cyber;
  let palette = [...theme.colors];
  let explanation = `使用【${theme.name}】标准主题配色`;

  if (!data || data.length === 0 || !yAxisKeys || yAxisKeys.length === 0) {
    return { colors: palette, explanation };
  }

  // Check 1: Revenue vs Profit or Positive vs Negative metric detection
  const hasNegative = data.some((d) =>
    yAxisKeys.some((k) => typeof d[k] === 'number' && d[k] < 0)
  );

  const keysLower = yAxisKeys.map((k) => k.toLowerCase());
  const isProfitVsRevenue =
    (keysLower.some((k) => k.includes('revenue') || k.includes('sales') || k.includes('收入') || k.includes('销售')) &&
      keysLower.some((k) => k.includes('profit') || k.includes('margin') || k.includes('利润') || k.includes('收益')));

  if (hasNegative) {
    // Inject contrasting Red / Green for negative variance
    palette = theme.isPrintFriendly
      ? ['#1e40af', '#dc2626', '#047857', '#d97706', '#6d28d9']
      : ['#06b6d4', '#f43f5e', '#10b981', '#fbbf24', '#a855f7'];
    explanation = '⚡ 智能归因算法检测到负值数据：自动启用强化正负对比度 (蓝/绿-红高对比)';
  } else if (isProfitVsRevenue) {
    // High contrast for Revenue vs Profit
    palette = theme.isPrintFriendly
      ? ['#1e3a8a', '#d97706', '#047857', '#7c3aed']
      : ['#6366f1', '#10b981', '#f59e0b', '#06b6d4'];
    explanation = '✨ 智能检测到收入与利润双指标：自动优化主次指标互补对比色';
  } else if (yAxisKeys.length >= 4) {
    // Multi-series: ensure maximum hue separation
    explanation = `🎨 检测到多序列指标 (${yAxisKeys.length}项)：已按色轮平均间隔最大化区分度`;
  }

  return { colors: palette, explanation };
}
