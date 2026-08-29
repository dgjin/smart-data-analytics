/**
 * v0.9.2 长任务处理器（改进计划 2-1）：报告生成 / 问数报告 / PDF 导出的 worker 侧执行体。
 * 逻辑与 server/routes/report.ts 同步端点共享同一下层能力（runLiveReport / runPdfGenerator），
 * 权限/注入/限流校验在提交端点完成，处理器以提交时的用户快照身份落审计。
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { registerTaskHandler } from './taskQueue';
import { writeAudit } from './auditLog';
import { loadSchemaContext } from './schemaContext';
import { runLiveReport, consumeReportPlan } from './liveReport';
import { runSimulatedReport } from './simulatedReport';
import { getFallbackExecutiveReport } from '../serverFallbacks';
import { normalizeReport } from '../src/utils/queryResultNormalizer';
import { normalizeExportData, buildExportFilename } from './reportExport';
import { runPdfGenerator } from './pdfExport';
import { getPool } from './db';

/** 处理器内统一的用户快照（提交时冻结，worker 执行时不再依赖会话） */
export interface TaskUserSnapshot {
  id: number;
  username: string;
  role: string;
  department?: string;
}

/** PDF 结果文件目录（项目根 data/task-results；Docker 卷随 data/ 持久化） */
export function taskResultDir(): string {
  return path.join(process.cwd(), 'data', 'task-results');
}

export function taskResultFile(taskId: string): string {
  // taskId 为服务端生成的 task_<uuid>，不含路径分隔符；双保险过滤
  const safe = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(taskResultDir(), `${safe}.pdf`);
}

async function runReportGenerate(payload: any, reportProgress: (t: string) => Promise<void>): Promise<unknown> {
  const startedAt = Date.now();
  const user = payload.user as TaskUserSnapshot;
  const dataSourceId = typeof payload.dataSourceId === 'string' ? payload.dataSourceId : '';
  const safeTemplate = String(payload.templateType || '综合经营分析').slice(0, 200);
  const safeCustom = String(payload.customPrompt || '').slice(0, 1000);
  const amountUnit = payload.amountUnit ?? undefined;
  const auditBase = { userId: user.id, username: user.username, endpoint: 'report' as const, dataSourceId };
  const auditQuestion = `async-report:${safeTemplate}`;

  const ctx = await loadSchemaContext(dataSourceId, undefined);
  if (ctx.status === 'disconnected') {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
    throw new Error('该数据源的智能问数功能已被管理员停用');
  }

  // 报告计划批准路径（同步端点等价逻辑）：payload 携带 reportPlanId 时先消费
  let approvedPlans: Parameters<typeof runLiveReport>[0]['approvedPlans'];
  if (typeof payload.reportPlanId === 'string' && payload.reportPlanId) {
    const consumed = await consumeReportPlan(payload.reportPlanId, user.id, dataSourceId, safeTemplate, amountUnit);
    if (consumed.ok !== true) throw new Error(consumed.reason);
    approvedPlans = consumed.plan;
  }

  const canRunLive = ['mysql', 'postgresql', 'greenplum'].includes(ctx.dsType || '') && dataSourceId.length > 0;
  if (canRunLive) {
    await reportProgress('查询计划与真实数据执行中');
    const live = await runLiveReport({
      templateType: safeTemplate,
      customPrompt: safeCustom,
      schema: ctx.schema,
      guidance: ctx.guidance,
      dataSourceId,
      dsType: ctx.dsType || undefined,
      sensitiveRemoved: ctx.sensitiveRemoved,
      rowFilters: ctx.rowFilters,
      amountUnit,
      scenario: 'export',
      ...(approvedPlans ? { approvedPlans } : {}),
    });
    if (live.ok === true) {
      const report = normalizeReport(live.report);
      if (report) {
        writeAudit({ ...auditBase, question: auditQuestion, status: 'SUCCESS', executedSql: live.executedSqls.join(' ; '), rowCount: live.totalRows, durationMs: Date.now() - startedAt });
        return { success: true, report: { ...report, executedSqls: live.executedSqls }, dataProvenance: 'live' };
      }
    }
    writeAudit({ ...auditBase, question: auditQuestion, status: 'FALLBACK', detail: String(live.ok === true ? '报表结构校验失败' : live.error).slice(0, 200), executedSql: live.executedSqls.join(' ; '), durationMs: Date.now() - startedAt });
    return { success: true, isFallback: true, report: getFallbackExecutiveReport(safeTemplate, ctx.schema), dataProvenance: 'simulated' };
  }

  await reportProgress('演示报告生成中');
  const sim = await runSimulatedReport({ templateType: safeTemplate, customPrompt: safeCustom, schema: ctx.schema, guidance: ctx.guidance });
  if (sim.ok === true) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'SUCCESS', durationMs: Date.now() - startedAt });
    return { success: true, report: sim.report, dataProvenance: 'simulated' };
  }
  writeAudit({ ...auditBase, question: auditQuestion, status: 'FALLBACK', detail: sim.error.slice(0, 200), durationMs: Date.now() - startedAt });
  return { success: true, isFallback: true, report: getFallbackExecutiveReport(safeTemplate, ctx.schema), dataProvenance: 'simulated' };
}

async function runReportFromQuery(payload: any, reportProgress: (t: string) => Promise<void>): Promise<unknown> {
  const startedAt = Date.now();
  const user = payload.user as TaskUserSnapshot;
  const dataSourceId = typeof payload.dataSourceId === 'string' ? payload.dataSourceId : '';
  const safeQuestion = String(payload.question || '').trim().slice(0, 500);
  const amountUnit = payload.amountUnit ?? undefined;
  const auditBase = { userId: user.id, username: user.username, endpoint: 'report' as const, dataSourceId };
  const auditQuestion = `async-query-report:${safeQuestion.slice(0, 100)}`;

  const ctx = await loadSchemaContext(dataSourceId, undefined);
  if (ctx.status === 'disconnected') {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
    throw new Error('该数据源的智能问数功能已被管理员停用');
  }
  const canRunLive = ['mysql', 'postgresql', 'greenplum'].includes(ctx.dsType || '') && dataSourceId.length > 0;
  if (!canRunLive) throw new Error('仅数据库型数据源支持报告生成');

  let templateType = '智能推断';
  let customPrompt = safeQuestion;
  let templateName = '';
  let templateIdNum: number | null = null;
  if (typeof payload.templateId === 'number' && payload.templateId > 0) {
    const [rows] = await getPool().query('SELECT * FROM report_templates WHERE id = ?', [payload.templateId]);
    const template = (rows as any[])[0];
    if (template) {
      templateType = template.name;
      templateName = template.name;
      templateIdNum = template.id;
      const templateContent = JSON.parse(template.template_content);
      const sectionsPrompt = templateContent.sections?.map((s: any) => `${s.title}：${s.prompt}`).join('；') || '';
      customPrompt = `${safeQuestion}。请按照以下模板结构生成报告：${sectionsPrompt}`;
    }
  }

  await reportProgress('查询计划与真实数据执行中');
  const live = await runLiveReport({
    templateType,
    customPrompt,
    schema: ctx.schema,
    guidance: ctx.guidance,
    dataSourceId,
    dsType: ctx.dsType || undefined,
    sensitiveRemoved: ctx.sensitiveRemoved,
    rowFilters: ctx.rowFilters,
    amountUnit,
    scenario: 'export',
  });

  if (live.ok === true) {
    const report = normalizeReport(live.report);
    if (report) {
      const reportId = `report-${Date.now()}`;
      await getPool().query(
        'INSERT INTO query_reports (report_id, user_id, username, data_source_id, question, template_id, template_name, report_data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [reportId, user.id, user.username, dataSourceId, safeQuestion, templateIdNum, templateName, JSON.stringify(report)]
      );
      writeAudit({ ...auditBase, question: auditQuestion, status: 'SUCCESS', executedSql: live.executedSqls.join(' ; '), rowCount: live.totalRows, durationMs: Date.now() - startedAt });
      return { success: true, report: { ...report, executedSqls: live.executedSqls }, reportId, templateName, dataProvenance: 'live' };
    }
  }

  writeAudit({ ...auditBase, question: auditQuestion, status: 'FALLBACK', detail: String(live.ok === true ? '报表结构校验失败' : live.error).slice(0, 200), executedSql: live.executedSqls.join(' ; '), durationMs: Date.now() - startedAt });
  return { success: true, isFallback: true, report: getFallbackExecutiveReport(templateType, ctx.schema), templateName, dataProvenance: 'simulated' };
}

async function runExportPdf(payload: any, reportProgress: (t: string) => Promise<void>, taskId: string): Promise<unknown> {
  const startedAt = Date.now();
  const user = payload.user as TaskUserSnapshot;
  const auditBase = { userId: user.id, username: user.username, endpoint: 'report' as const };

  const data = normalizeExportData(payload.report);
  if (!data) {
    writeAudit({ ...auditBase, status: 'DENIED_INPUT', detail: '异步 PDF 导出参数非法', durationMs: Date.now() - startedAt });
    throw new Error('报告导出参数无效');
  }
  const orientation = payload.orientation === 'landscape' ? 'landscape' : 'portrait';
  // DLP 水印沿用提交端点注入的快照（导出人在提交时冻结，防伪造）
  const watermark = String(payload.watermark || '');

  await reportProgress('PDF 排版渲染中');
  const pdf = await runPdfGenerator({ ...data, orientation, watermark });
  await mkdir(taskResultDir(), { recursive: true });
  const file = taskResultFile(taskId);
  await writeFile(file, pdf);
  writeAudit({ ...auditBase, question: `async-export-pdf:${data.title}`, status: 'SUCCESS', durationMs: Date.now() - startedAt });
  return {
    file: true,
    filename: buildExportFilename(data.title, data.createdAt, '.pdf'),
    size: pdf.length,
  };
}

/** 注册全部内置处理器（server 启动时调用一次） */
export function registerBuiltinTaskHandlers(): void {
  registerTaskHandler('report_generate', (payload, ctx) => runReportGenerate(payload, ctx.reportProgress));
  registerTaskHandler('report_generate_from_query', (payload, ctx) => runReportFromQuery(payload, ctx.reportProgress));
  registerTaskHandler('report_export_pdf', (payload, ctx) => runExportPdf(payload, ctx.reportProgress, ctx.taskId));
}
