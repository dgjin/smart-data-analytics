/**
 * v0.9.22 历史报表维护（修改条件重新生成 / 删除）的纯函数逻辑：
 * - 生成条件解析：genParams 快照优先，旧版报表回退平铺 customPrompt + 调用方默认模板/单位；
 * - 重新生成准入判定与结果合并（就地替换时保留报表 id 与批注等交互状态）。
 * 抽为纯函数供 ReportGenerator（手动重新生成与 v0.4.8 自动重生成）共用，并独立单测。
 */
import { SavedReport, ReportGenParams } from '../types/analytics';

/** 重新生成的完整生效条件（数据源取自报表平铺字段） */
export interface ResolvedRegenParams extends ReportGenParams {
  dataSourceId: string;
}

/**
 * 解析报表的生成条件：genParams 快照优先；旧版报表无快照时回退平铺 customPrompt 字段，
 * 模板与金额单位由调用方给默认值（手动入口给当前 UI 选择，自动重生成给组件当前模板/模块生效单位）。
 */
export function resolveReportGenParams(
  report: Pick<SavedReport, 'genParams' | 'customPrompt' | 'dataSourceId'>,
  fallbackTemplate: string,
  fallbackUnit: string
): ResolvedRegenParams {
  const snap = report.genParams;
  return {
    templateType: snap?.templateType || fallbackTemplate,
    customPrompt: snap?.customPrompt ?? report.customPrompt ?? '',
    amountUnit: snap?.amountUnit || fallbackUnit,
    dataSourceId: report.dataSourceId,
  };
}

/** 重新生成准入：仅 live 报表（有真实数据源）且操作人有生成权限（ADMIN/ANALYST）；simulated/演示报表不可重新生成 */
export function canRegenerateReport(
  report: Pick<SavedReport, 'dataProvenance' | 'dataSourceId'> | null | undefined,
  canGenerate: boolean
): boolean {
  return !!report && canGenerate && report.dataProvenance === 'live' && !!report.dataSourceId;
}

/**
 * 重新生成成功后的就地替换合并：保留原报表 id 与批注（charts 级批注随 charts 整体替换），
 * 更新内容字段与生成条件快照；createdAt 取新报表生成日期。
 */
export function applyRegenResult(
  original: SavedReport,
  data: { title?: string; summary?: string; createdAt?: string; insights?: any[]; kpiList?: any[]; charts?: any[]; executedSqls?: string[] },
  params: ResolvedRegenParams,
  dataProvenance: 'live' | 'simulated'
): SavedReport {
  return {
    ...original,
    title: data.title || original.title,
    summary: data.summary || original.summary,
    createdAt: data.createdAt || new Date().toISOString().split('T')[0],
    insights: data.insights || [],
    kpiList: data.kpiList || [],
    charts: data.charts || [],
    ...(Array.isArray(data.executedSqls) ? { executedSqls: data.executedSqls } : {}),
    comments: original.comments, // 重新生成不清空已有批注
    customPrompt: params.customPrompt.trim() ? params.customPrompt.trim() : undefined,
    genParams: {
      templateType: params.templateType,
      customPrompt: params.customPrompt.trim(),
      amountUnit: params.amountUnit,
    },
    dataProvenance,
  };
}
