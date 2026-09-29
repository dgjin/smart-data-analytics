/**
 * v0.9.2 长任务处理器（改进计划 2-1）：报告生成 / 问数报告 / PDF 导出的 worker 侧执行体。
 * 逻辑与 server/routes/report.ts 同步端点共享同一下层能力（runLiveReport / runPdfGenerator），
 * 权限/注入/限流校验在提交端点完成，处理器以提交时的用户快照身份落审计。
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type mysql from 'mysql2/promise';
import { registerTaskHandler } from './infra/taskQueue';
import { writeAudit } from './infra/auditLog';
import { loadSchemaContext, isLiveCapableType } from './query/schemaContext';
import { executeSafeSql } from './query/sqlExecutor';
import { maskRows } from './query/dlp';
import { runLiveReport, consumeReportPlan } from './report/liveReport';
import { runSimulatedReport } from './report/simulatedReport';
import { getFallbackExecutiveReport } from './serverFallbacks';
import { normalizeReport } from '../src/utils/queryResultNormalizer';
import { normalizeExportData, buildExportFilename } from './report/reportExport';
import { runPdfGenerator } from './report/pdfExport';
import { getPool } from './infra/db';
import type { UserRole } from './auth/auth';
import { executeAutoConfig, type AutoConfigReport } from './datasource/autoConfig';
import { seedSchemaFewShotExamples, syncKnowledgeEntriesToRag, syncSchemaMetadataToRag } from './knowledge/autoKnowledgeSync';
import { getPipelineSnapshot, probeEmbedding, savePipelineSnapshot, type PipelineSnapshot, type PipelineSubtask } from './setupWizard';
import { loadDemoDataSet } from './setupDemoData';
import { getErrorMessage } from './infra/errorUtils';
import { logger } from './infra/logger';
import type { SchemaTable } from './query/schemaTypes';

/** 处理器内统一的用户快照（提交时冻结，worker 执行时不再依赖会话） */
export interface TaskUserSnapshot {
  id: number;
  username: string;
  role: UserRole;
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

async function runReportGenerate(payload: Record<string, unknown>, reportProgress: (t: string) => Promise<void>): Promise<unknown> {
  const startedAt = Date.now();
  const user = payload.user as TaskUserSnapshot;
  const dataSourceId = typeof payload.dataSourceId === 'string' ? payload.dataSourceId : '';
  const safeTemplate = String(payload.templateType || '综合经营分析').slice(0, 200);
  const safeCustom = String(payload.customPrompt || '').slice(0, 1000);
  const amountUnit = typeof payload.amountUnit === 'string' ? payload.amountUnit : undefined;
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

  const canRunLive = isLiveCapableType(ctx.dsType, ctx.fileBacked) && dataSourceId.length > 0;
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

async function runReportFromQuery(payload: Record<string, unknown>, reportProgress: (t: string) => Promise<void>): Promise<unknown> {
  const startedAt = Date.now();
  const user = payload.user as TaskUserSnapshot;
  const dataSourceId = typeof payload.dataSourceId === 'string' ? payload.dataSourceId : '';
  const safeQuestion = String(payload.question || '').trim().slice(0, 500);
  const amountUnit = typeof payload.amountUnit === 'string' ? payload.amountUnit : undefined;
  const auditBase = { userId: user.id, username: user.username, endpoint: 'report' as const, dataSourceId };
  const auditQuestion = `async-query-report:${safeQuestion.slice(0, 100)}`;

  const ctx = await loadSchemaContext(dataSourceId, undefined);
  if (ctx.status === 'disconnected') {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
    throw new Error('该数据源的智能问数功能已被管理员停用');
  }
  const canRunLive = isLiveCapableType(ctx.dsType, ctx.fileBacked) && dataSourceId.length > 0;
  if (!canRunLive) throw new Error('仅数据库型或已导入数据的文件型数据源支持报告生成');

  let templateType = '智能推断';
  let customPrompt = safeQuestion;
  let templateName = '';
  let templateIdNum: number | null = null;
  if (typeof payload.templateId === 'number' && payload.templateId > 0) {
    const [rows] = await getPool().query<mysql.RowDataPacket[]>('SELECT * FROM report_templates WHERE id = ?', [payload.templateId]);
    const template = rows[0];
    if (template) {
      templateType = template.name;
      templateName = template.name;
      templateIdNum = template.id;
      const templateContent = JSON.parse(template.template_content) as { sections?: { title?: unknown; prompt?: unknown }[] };
      const sectionsPrompt = templateContent.sections?.map((s) => `${s.title}：${s.prompt}`).join('；') || '';
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

/**
 * v0.9.76 P1-10 灵活查询后台执行：交互端点预估大查询时改走本任务（提交即返回 taskId）。
 * 结果按提交人快照 DLP 脱敏后存任务表（result_json），前端轮询 /api/tasks/:id 渲染；
 * 执行走导出级连接池配额与超时（不挤占交互问数，见 sqlExecutor 场景分级）。
 */
const FLEX_QUERY_STORED_ROW_LIMIT = 20000;

async function runFlexQuery(payload: Record<string, unknown>, reportProgress: (t: string) => Promise<void>): Promise<unknown> {
  const startedAt = Date.now();
  const user = payload.user as TaskUserSnapshot;
  const dataSourceId = typeof payload.dataSourceId === 'string' ? payload.dataSourceId : '';
  const sql = typeof payload.sql === 'string' ? payload.sql : '';
  const auditBase = { userId: user.id, username: user.username, endpoint: 'flex_query' as const, dataSourceId };
  const auditQuestion = `async-flex:${sql.slice(0, 120)}`;

  const ctx = await loadSchemaContext(dataSourceId, undefined);
  if (ctx.status === 'disconnected') {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_SWITCH', detail: '数据源已停用智能问数', durationMs: Date.now() - startedAt });
    throw new Error('该数据源的智能问数功能已被管理员停用');
  }

  await reportProgress('大查询后台执行中');
  const outcome = await executeSafeSql(dataSourceId, sql, ctx.schema, ctx.sensitiveRemoved, FLEX_QUERY_STORED_ROW_LIMIT, ctx.rowFilters, 'export');
  if (outcome.ok !== true) {
    writeAudit({ ...auditBase, question: auditQuestion, status: 'DENIED_INPUT', detail: String(outcome.reason).slice(0, 200), durationMs: Date.now() - startedAt });
    throw new Error(outcome.reason);
  }

  // P2-12 DLP：按提交人快照脱敏后落盘（任务结果仅本人或 ADMIN 可见，见 routes/tasks.ts）
  const dlpOut = maskRows(outcome.result.rows, user);
  const durationMs = Date.now() - startedAt;
  const isSlow = durationMs > 3000 || outcome.result.rowCount > 100000;
  writeAudit({
    ...auditBase,
    question: auditQuestion,
    status: 'SUCCESS',
    detail: `${isSlow ? 'SLOW: ' : ''}异步执行 ${durationMs}ms，行数 ${outcome.result.rowCount}`,
    executedSql: outcome.result.finalSql,
    rowCount: outcome.result.rowCount,
    durationMs,
  });
  return {
    success: true,
    rows: dlpOut.rows,
    rowCount: outcome.result.rowCount,
    truncated: outcome.result.truncated,
    rowLimit: FLEX_QUERY_STORED_ROW_LIMIT,
    finalSql: outcome.result.finalSql,
    executionTimeMs: durationMs,
    dataProvenance: 'live',
    ...(dlpOut.maskedColumns.length > 0 ? { dlp: { maskedColumns: dlpOut.maskedColumns, maskedLabels: dlpOut.maskedLabels } } : {}),
  };
}

async function runExportPdf(payload: Record<string, unknown>, reportProgress: (t: string) => Promise<void>, taskId: string): Promise<unknown> {
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

// ---------------- v0.9.84 首启初始化向导流水线 ----------------

/** 流水线子任务定义（顺序即依赖；与《首启初始化向导交互设计》Step③ 表格一一对应） */
const SETUP_SUBTASK_DEFS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'schema_collect', label: 'Schema 元数据采集' },
  { key: 'capability_config', label: '画像与能力配置' },
  { key: 'knowledge_skeleton', label: '知识骨架生成' },
  { key: 'knowledge_vectorize', label: '知识条目向量入库' },
  { key: 'schema_vectorize', label: 'Schema 元数据向量入库' },
  { key: 'fewshot_seed', label: '样例库种子' },
];

/** schema_json 边界解析（mysql2 可能已自动解析 JSON 列） */
function parseSchemaJson(raw: unknown): SchemaTable[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as SchemaTable[];
  try {
    const v = JSON.parse(String(raw)) as unknown;
    return Array.isArray(v) ? (v as SchemaTable[]) : [];
  } catch {
    return [];
  }
}

/** 初始化全新流水线快照（所有子任务 pending） */
function initPipelineSnapshot(dataSourceId: string): PipelineSnapshot {
  return {
    dataSourceId,
    startedAt: new Date().toISOString(),
    subtasks: SETUP_SUBTASK_DEFS.map((d) => ({ ...d, state: 'pending', counters: null, error: null, ms: null })),
  };
}

/** 单子任务包装：状态推进 + 快照增量落库 + 失败中断（已成功子任务保留，人工重试只重跑失败项） */
async function execSetupSubtask(
  snapshot: PipelineSnapshot,
  key: string,
  reportProgress: (t: string) => Promise<void>,
  progressText: string,
  fn: () => Promise<{ counters?: Record<string, number>; skip?: string }>,
): Promise<void> {
  const def = SETUP_SUBTASK_DEFS.find((d) => d.key === key);
  if (!def) return;
  let st = snapshot.subtasks.find((s) => s.key === key);
  if (!st) {
    st = { ...def, state: 'pending', counters: null, error: null, ms: null };
    snapshot.subtasks.push(st);
  }
  const t0 = Date.now();
  st.state = 'running';
  st.error = null;
  await savePipelineSnapshot(snapshot);
  await reportProgress(progressText);
  try {
    const out = await fn();
    st.state = out.skip ? 'skipped' : 'success';
    st.error = out.skip ?? null;
    st.counters = out.counters ?? null;
  } catch (err) {
    st.state = 'failed';
    st.error = getErrorMessage(err).slice(0, 300);
    st.ms = Date.now() - t0;
    await savePipelineSnapshot(snapshot);
    throw err;
  }
  st.ms = Date.now() - t0;
  await savePipelineSnapshot(snapshot);
}

/**
 * v0.9.84 首启初始化向导：自动初始化流水线（6 子任务，见 docs/首启初始化向导交互设计20260929.md Step③）。
 * - 子任务 1 读落库 schema_json（接入/同步结构时已采集，避免执行期依赖目标库连通）；
 * - 子任务 2/3 复用 autoConfig 纯函数；子任务 4/5/6 复用 autoKnowledgeSync 分解函数（确定性 doc_id 幂等）；
 * - 部分失败策略：单子任务失败即中断后续（已成功保留），payload.subtask 携带 key 时仅重跑该子任务；
 * - Embedding 不可用时子任务 4/5 标 skipped 不阻断后续（待办清单持续提示，检索走既有词法降级链）。
 */
async function runSetupPipeline(payload: Record<string, unknown>, reportProgress: (t: string) => Promise<void>): Promise<unknown> {
  const user = payload.user as TaskUserSnapshot;
  const dataSourceId = typeof payload.dataSourceId === 'string' ? payload.dataSourceId : '';
  const retryKey = typeof payload.subtask === 'string' && payload.subtask ? payload.subtask : '';
  if (!dataSourceId) throw new Error('缺少 dataSourceId 参数');
  if (retryKey && !SETUP_SUBTASK_DEFS.some((d) => d.key === retryKey)) throw new Error(`未知子任务：${retryKey}`);
  const actor = String(user?.username || 'system').slice(0, 50);
  const startedAt = Date.now();

  // 数据源存在性校验（向导期间被删除 → 明确指引返回数据源选择）
  const [dsRows] = await getPool().query<mysql.RowDataPacket[]>('SELECT id, name, schema_json FROM data_sources WHERE id = ? LIMIT 1', [dataSourceId]);
  const ds = dsRows[0];
  if (!ds) throw new Error('数据源不存在（可能已被删除），请返回数据源选择重新接入');
  const dsName = String(ds.name || dataSourceId);
  const tables = parseSchemaJson(ds.schema_json);

  // 快照：全新执行初始化；单子任务重试沿用现有进度（已成功子任务不重跑）
  let snapshot: PipelineSnapshot;
  if (retryKey) {
    const existing = await getPipelineSnapshot();
    snapshot =
      existing && existing.dataSourceId === dataSourceId
        ? { ...existing, subtasks: existing.subtasks.map((s) => ({ ...s })) }
        : initPipelineSnapshot(dataSourceId);
  } else {
    snapshot = initPipelineSnapshot(dataSourceId);
  }
  await savePipelineSnapshot(snapshot);
  const shouldRun = (key: string) => !retryKey || retryKey === key;
  const retryLabel = retryKey ? SETUP_SUBTASK_DEFS.find((d) => d.key === retryKey)?.label || retryKey : '';
  await reportProgress(retryKey ? `重试子任务：${retryLabel}` : '自动初始化流水线启动');

  let report: AutoConfigReport | null = null;
  const autoConfigOf = (): AutoConfigReport => {
    const rpt = report ?? executeAutoConfig(dataSourceId, dsName, tables);
    report = rpt;
    return rpt;
  };

  // 子任务 1：Schema 元数据采集（读取落库结构；空则失败并指引「同步结构」）
  if (shouldRun('schema_collect')) {
    await execSetupSubtask(snapshot, 'schema_collect', reportProgress, '子任务 1/6：Schema 元数据采集', async () => {
      if (tables.length === 0) {
        throw new Error('该数据源尚未采集 Schema 元数据，请先在数据源管理中执行「同步结构」后重试');
      }
      const columns = tables.reduce((n, t) => n + (Array.isArray(t.columns) ? t.columns.length : 0), 0);
      return { counters: { tables: tables.length, columns } };
    });
  }

  // 子任务 2：画像与能力配置（executeAutoConfig 纯函数 + capability 落库）
  if (shouldRun('capability_config')) {
    await execSetupSubtask(snapshot, 'capability_config', reportProgress, '子任务 2/6：画像与能力配置', async () => {
      const rpt = autoConfigOf();
      await getPool().query('UPDATE data_sources SET anomaly_capabilities_json = ? WHERE id = ?', [JSON.stringify(rpt.capabilities), dataSourceId]);
      const cap = rpt.capabilities;
      const enabled = [cap.timeSeriesRecalc.enabled, cap.categoricalDetection.enabled, cap.caliberCheck.enabled].filter(Boolean).length;
      return { counters: { capabilities: enabled } };
    });
  }

  // 子任务 3：知识骨架生成（knowledge_base_entries + 铁律模板 PENDING；确定性 entry_id 幂等覆盖）
  if (shouldRun('knowledge_skeleton')) {
    await execSetupSubtask(snapshot, 'knowledge_skeleton', reportProgress, '子任务 3/6：知识骨架生成', async () => {
      const rpt = autoConfigOf();
      const pool = getPool();
      for (let i = 0; i < rpt.knowledgeEntries.length; i++) {
        const entry = rpt.knowledgeEntries[i];
        await pool.query(
          `INSERT INTO knowledge_base_entries (entry_id, data_source_id, title, content, tags, category, version, is_preset, created_by)
           VALUES (?, ?, ?, ?, ?, ?, '1.0', 0, ?)
           ON DUPLICATE KEY UPDATE content = VALUES(content), title = VALUES(title), tags = VALUES(tags)`,
          [`kb_auto_${dataSourceId}_${i + 1}`, dataSourceId, entry.title, entry.content, JSON.stringify(entry.tags), entry.category, actor],
        );
      }
      for (const tpl of rpt.ironRuleTemplates) {
        await pool.query(
          `INSERT INTO iron_rules (data_source_id, title, content, status, created_by)
           VALUES (?, ?, ?, 'PENDING', ?)
           ON DUPLICATE KEY UPDATE content = VALUES(content)`,
          [dataSourceId, tpl.title, tpl.content, actor],
        );
      }
      return { counters: { entries: rpt.knowledgeEntries.length, ironRules: rpt.ironRuleTemplates.length } };
    });
  }

  // Embedding 可用性探测：不可用时子任务 4/5 跳过（不阻断 6 与整体完成）
  let embedSkip = '';
  if (shouldRun('knowledge_vectorize') || shouldRun('schema_vectorize')) {
    const probe = await probeEmbedding();
    if (!probe.ok) {
      embedSkip = `Embedding 模型不可用（${probe.error || '探测失败'}）：知识向量检索退化为词法匹配，可在「系统设置」补齐后重试本子任务`;
      await reportProgress('Embedding 不可用：子任务 4/5 跳过');
    }
  }

  // 子任务 4：知识条目向量入库（断点 1 闭环：entries → knowledge_base）
  if (shouldRun('knowledge_vectorize')) {
    await execSetupSubtask(snapshot, 'knowledge_vectorize', reportProgress, '子任务 4/6：知识条目向量入库', async () => {
      if (embedSkip) return { skip: embedSkip };
      const summary = await syncKnowledgeEntriesToRag(dataSourceId, autoConfigOf().knowledgeEntries, actor);
      return { counters: { docs: summary.docs, chunks: summary.chunks, pruned: summary.pruned } };
    });
  }

  // 子任务 5：Schema 元数据向量入库（断点 2 闭环：每表切一块 embedding）
  if (shouldRun('schema_vectorize')) {
    await execSetupSubtask(snapshot, 'schema_vectorize', reportProgress, '子任务 5/6：Schema 元数据向量入库', async () => {
      if (embedSkip) return { skip: embedSkip };
      const summary = await syncSchemaMetadataToRag(dataSourceId, dsName, tables, actor);
      return { counters: { docs: summary.docs, chunks: summary.chunks, pruned: summary.pruned } };
    });
  }

  // 子任务 6：样例库种子（断点 3 闭环：通用 few-shot 语法范式；不依赖 embedding 可用性）
  if (shouldRun('fewshot_seed')) {
    await execSetupSubtask(snapshot, 'fewshot_seed', reportProgress, '子任务 6/6：样例库种子', async () => {
      const summary = await seedSchemaFewShotExamples(dataSourceId, tables, actor);
      return { counters: { seeded: summary.seeded, skipped: summary.skipped } };
    });
  }

  const totals = {
    success: snapshot.subtasks.filter((s) => s.state === 'success').length,
    skipped: snapshot.subtasks.filter((s) => s.state === 'skipped').length,
    failed: snapshot.subtasks.filter((s) => s.state === 'failed').length,
  };
  logger.info(`[SetupPipeline] ${dataSourceId}${retryKey ? ` 重试 ${retryKey}` : ''} 完成：成功 ${totals.success}，跳过 ${totals.skipped}，失败 ${totals.failed}，耗时 ${Date.now() - startedAt}ms`);
  return {
    dataSourceId,
    ...(retryKey ? { retry: retryKey } : {}),
    subtasks: snapshot.subtasks.map((s) => ({ key: s.key, state: s.state, counters: s.counters, ms: s.ms })),
    totals,
  };
}

/**
 * v0.9.86 向导 Phase 2：内置演示数据集一键加载任务（routes/setup POST /demo-data 提交）。
 * 建演示表/确定性样本/注册数据源/治理配置/向量化均在 loadDemoDataSet 内（复用文件数据源白名单与接入自动化闭环）；
 * 进度经 reportProgress 续写 async_tasks.progress 供前端轮询展示。
 */
async function runSetupDemoData(payload: Record<string, unknown>, reportProgress: (t: string) => Promise<void>): Promise<unknown> {
  const user = payload.user as TaskUserSnapshot;
  const startedAt = Date.now();
  const result = await loadDemoDataSet(user?.username || '', reportProgress);
  logger.info(
    `[SetupDemo] 演示数据集加载完成：${result.tables} 表/${result.rows} 行，向量块 ${result.vectorChunks}，样例 ${result.fewShotSeeded}，耗时 ${Date.now() - startedAt}ms`
  );
  return result;
}

/** 注册全部内置处理器（server 启动时调用一次）；队列侧 payload 为 JSON.parse 产物，边界处收窄为对象 */
export function registerBuiltinTaskHandlers(): void {
  registerTaskHandler('report_generate', (payload, ctx) => runReportGenerate((payload ?? {}) as Record<string, unknown>, ctx.reportProgress));
  registerTaskHandler('report_generate_from_query', (payload, ctx) => runReportFromQuery((payload ?? {}) as Record<string, unknown>, ctx.reportProgress));
  registerTaskHandler('report_export_pdf', (payload, ctx) => runExportPdf((payload ?? {}) as Record<string, unknown>, ctx.reportProgress, ctx.taskId));
  registerTaskHandler('flex_query', (payload, ctx) => runFlexQuery((payload ?? {}) as Record<string, unknown>, ctx.reportProgress));
  registerTaskHandler('setup_pipeline', (payload, ctx) => runSetupPipeline((payload ?? {}) as Record<string, unknown>, ctx.reportProgress));
  registerTaskHandler('setup_demo_data', (payload, ctx) => runSetupDemoData((payload ?? {}) as Record<string, unknown>, ctx.reportProgress));
}
