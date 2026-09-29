/**
 * v0.9.84 首启初始化向导 - 状态与探测服务（设计见 docs/首启初始化向导交互设计20260929.md §6）：
 * - 向导状态：全局单行表 setup_wizard_state（id 恒为 1），读写 + 断点续做快照；
 * - 环境探测：readiness 探针 + LLM 最小对话探测 + embedding ping + 数据源/知识库统计；
 * - 待办清单：Step④ 数据组装（铁律 / 阈值 / 向量化 / 知识 / 样例五项）。
 * 路由层见 server/routes/setup.ts；自动初始化流水线 handler 见 taskHandlers（setup_pipeline）。
 */
import mysql from 'mysql2/promise';
import { getPool } from './infra/db';
import { logger } from './infra/logger';
import { getErrorMessage } from './infra/errorUtils';
import { buildDefaultProbes, runReadiness, type ReadinessReport } from './infra/health';
import { callLLMText, llmEngineInfo, type LlmEngineInfo } from './llm/llmClient';
import { callEmbedding, currentEmbedModelId } from './llm/llmEmbedding';
import { isDemoDataSetLoaded } from './setupDemoData';

export type WizardStatus = 'pending' | 'in_progress' | 'completed';

export interface SetupWizardState {
  status: WizardStatus;
  /** 首个未完成步骤（0..4）；只前移不回退 */
  currentStep: number;
  /** 各步骤结果快照：{"0":{...},"2":{...}}；pipeline 键存流水线快照 */
  stepResults: Record<string, unknown>;
  /** 最近一次流水线任务 id（async_tasks） */
  pipelineTaskId: string | null;
  /** L2 横幅静默截止（7 天不再提醒） */
  skippedUntil: string | null;
  startedBy: string;
  completedAt: string | null;
  updatedAt: string | null;
}

/** 流水线子任务状态（设计 §四 Step③ 进度 UI 契约） */
export interface PipelineSubtask {
  key: string;
  label: string;
  state: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  /** 计数摘要，如 {tables:42, columns:613} / {chunks:120} */
  counters?: Record<string, number> | null;
  error?: string | null;
  ms?: number | null;
}

export interface PipelineSnapshot {
  dataSourceId: string;
  startedAt: string;
  subtasks: PipelineSubtask[];
}

const EMPTY_STATE: SetupWizardState = {
  status: 'pending',
  currentStep: 0,
  stepResults: {},
  pipelineTaskId: null,
  skippedUntil: null,
  startedBy: '',
  completedAt: null,
  updatedAt: null,
};

function toStatus(v: unknown): WizardStatus {
  const s = String(v || '');
  return s === 'in_progress' || s === 'completed' ? s : 'pending';
}

function parseStepResults(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toIso(v: unknown): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** 读取向导状态（单行；行缺失时惰性补种，保持"恰好一行"约定） */
export async function getWizardState(): Promise<SetupWizardState> {
  const pool = getPool();
  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM setup_wizard_state WHERE id = 1 LIMIT 1');
  const r = rows[0];
  if (!r) {
    await pool.query("INSERT IGNORE INTO setup_wizard_state (id, status) VALUES (1, 'pending')");
    return { ...EMPTY_STATE };
  }
  return {
    status: toStatus(r.status),
    currentStep: Number(r.current_step) || 0,
    stepResults: parseStepResults(r.step_results),
    pipelineTaskId: r.pipeline_task_id ? String(r.pipeline_task_id) : null,
    skippedUntil: toIso(r.skipped_until),
    startedBy: String(r.started_by || ''),
    completedAt: toIso(r.completed_at),
    updatedAt: toIso(r.updated_at),
  };
}

/**
 * 保存步骤结果快照（step 0..4，按索引存入 step_results）。
 * status 由 pending 转 in_progress；current_step 只前移不回退（断点续做定位第一个未完成步骤）。
 */
export async function saveStepResult(step: number, result: unknown, actor: string): Promise<void> {
  const idx = Math.min(Math.max(Math.floor(Number(step) || 0), 0), 4);
  await getPool().query(
    `UPDATE setup_wizard_state
        SET step_results = JSON_SET(COALESCE(step_results, JSON_OBJECT()), ?, CAST(? AS JSON)),
            current_step = GREATEST(current_step, ?),
            status = IF(status = 'pending', 'in_progress', status),
            started_by = IF(started_by = '', ?, started_by)
      WHERE id = 1`,
    [`$."${idx}"`, JSON.stringify(result ?? {}), idx, actor],
  );
}

/** 读取流水线快照（无则 null；step_results.pipeline） */
export async function getPipelineSnapshot(): Promise<PipelineSnapshot | null> {
  const state = await getWizardState();
  const p = state.stepResults.pipeline as PipelineSnapshot | undefined;
  return p && Array.isArray(p.subtasks) ? p : null;
}

/** 写入流水线快照（原子替换 step_results.pipeline；供流水线 handler 增量更新） */
export async function savePipelineSnapshot(snapshot: PipelineSnapshot): Promise<void> {
  await getPool().query(
    `UPDATE setup_wizard_state
        SET step_results = JSON_SET(COALESCE(step_results, JSON_OBJECT()), '$."pipeline"', CAST(? AS JSON))
      WHERE id = 1`,
    [JSON.stringify(snapshot)],
  );
}

/** 记录最近一次流水线任务 id */
export async function setPipelineTask(taskId: string | null): Promise<void> {
  await getPool().query('UPDATE setup_wizard_state SET pipeline_task_id = ? WHERE id = 1', [taskId]);
}

/** L2 横幅"7 天不再提醒"：设置静默截止（1..365 天，缺省 7） */
export async function skipWizardReminder(days: number): Promise<void> {
  const d = Math.min(Math.max(Math.floor(Number(days) || 7), 1), 365);
  await getPool().query('UPDATE setup_wizard_state SET skipped_until = DATE_ADD(NOW(), INTERVAL ? DAY) WHERE id = 1', [d]);
}

/** 向导完成（任一 CTA 触发） */
export async function completeWizard(actor: string): Promise<void> {
  await getPool().query(
    `UPDATE setup_wizard_state
        SET status = 'completed', current_step = 4, completed_at = NOW(),
            started_by = IF(started_by = '', ?, started_by)
      WHERE id = 1`,
    [actor],
  );
}

// ---------------- 环境探测 ----------------

export interface LlmProbeResult {
  ok: boolean;
  engine: string;
  model: string;
  label: string;
  latencyMs: number;
  /** 模型回复样本（截断，仅供连通性展示） */
  sample?: string;
  error?: string;
}

export interface EmbeddingProbeResult {
  ok: boolean;
  model: string;
  dims?: number;
  latencyMs: number;
  error?: string;
}

/** 探测限时：LLM 首调用含模型冷加载可能数秒（Ollama），embedding 本应毫秒级 */
const LLM_PROBE_TIMEOUT_MS = 15_000;
const EMBED_PROBE_TIMEOUT_MS = 10_000;

function withProbeTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 探测超时（${Math.round(ms / 1000) || 1}s）`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** LLM 最小对话探测（经引擎熔断/failover 链真实发起一次极短调用；无密钥且 Ollama 不可达即失败） */
export async function probeLlm(): Promise<LlmProbeResult> {
  const info = llmEngineInfo();
  const t0 = Date.now();
  try {
    const text = await withProbeTimeout(
      callLLMText('你是连通性测试助手，除测试口令外不输出任何内容。', '请只回复：PONG'),
      LLM_PROBE_TIMEOUT_MS,
      'LLM',
    );
    return {
      ok: true,
      engine: info.engine,
      model: info.model,
      label: info.label,
      latencyMs: Date.now() - t0,
      sample: String(text || '').trim().slice(0, 40),
    };
  } catch (err) {
    return { ok: false, engine: info.engine, model: info.model, label: info.label, latencyMs: Date.now() - t0, error: getErrorMessage(err) };
  }
}

/** embedding 可用性探测（返回向量维度；不可用时携带降级原因，语义见设计 Step① 判定表） */
export async function probeEmbedding(): Promise<EmbeddingProbeResult> {
  const model = currentEmbedModelId();
  const t0 = Date.now();
  try {
    const vec = await withProbeTimeout(callEmbedding('连通性探测'), EMBED_PROBE_TIMEOUT_MS, 'Embedding');
    return { ok: true, model, dims: vec.length, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, model, latencyMs: Date.now() - t0, error: getErrorMessage(err) };
  }
}

export interface EnvSummary {
  llm: LlmEngineInfo;
  embedding: { model: string };
  datasources: { total: number; connected: number; demoLoaded: boolean };
  health: ReadinessReport;
}

/** 环境汇总（GET /state 用）：readiness 探针 + 引擎配置态 + 数据源统计；轻量，不做真实 LLM/embedding 调用 */
export async function collectEnvSummary(): Promise<EnvSummary> {
  const pool = getPool();
  const [[dsRows], health, demoLoaded] = await Promise.all([
    pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'connected' THEN 1 ELSE 0 END) AS connected FROM data_sources",
    ),
    runReadiness(buildDefaultProbes()),
    // v0.9.86：「内置演示数据」以一键加载产物（ds_setup_demo）为准，供 Step① 检测项与 Step③ 快速体验引导联动
    isDemoDataSetLoaded(),
  ]);
  return {
    llm: llmEngineInfo(),
    embedding: { model: currentEmbedModelId() },
    datasources: {
      total: Number(dsRows[0]?.total) || 0,
      connected: Number(dsRows[0]?.connected) || 0,
      demoLoaded,
    },
    health,
  };
}

// ---------------- 待办清单（Step④） ----------------

export interface ChecklistItem {
  key: string;
  title: string;
  detail: string;
  status: 'todo' | 'done' | 'warn';
  /** 前端深链标识（如 'admin:rules' / 'setup:step2'） */
  link?: string;
}

/** 解析单行 anomaly_capabilities_json 的 domainThresholds.enabled */
function thresholdEnabled(raw: unknown): boolean {
  try {
    const cap = typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
    const dt = (cap as Record<string, unknown> | null)?.domainThresholds as { enabled?: boolean } | undefined;
    return dt?.enabled === true;
  } catch {
    return false;
  }
}

/** Step④ 待办清单：五项动态组装（铁律 / 阈值 / Embedding / 业务知识 / 样例库） */
export async function buildChecklist(): Promise<ChecklistItem[]> {
  const pool = getPool();
  const [[ironRows], [kbRows], [entryRows], [exRows], [capRows]] = await Promise.all([
    pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS cnt FROM iron_rules WHERE status = 'PENDING'"),
    pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM knowledge_base'),
    pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM knowledge_base_entries'),
    pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM sql_examples'),
    pool.query<mysql.RowDataPacket[]>('SELECT anomaly_capabilities_json FROM data_sources WHERE anomaly_capabilities_json IS NOT NULL'),
  ]);
  const pendingRules = Number(ironRows[0]?.cnt) || 0;
  const chunks = Number(kbRows[0]?.cnt) || 0;
  const entries = Number(entryRows[0]?.cnt) || 0;
  const examples = Number(exRows[0]?.cnt) || 0;
  const thresholdOn = capRows.some((r) => thresholdEnabled(r.anomaly_capabilities_json));
  const embed = await probeEmbedding();

  return [
    pendingRules > 0
      ? { key: 'iron_rules', title: `铁律模板待确认 ${pendingRules} 条`, detail: '接入数据源自动生成的治理规则模板需管理员确认后方可生效', status: 'todo', link: 'admin:rules' }
      : { key: 'iron_rules', title: '铁律模板', detail: '无待确认模板', status: 'done', link: 'admin:rules' },
    thresholdOn
      ? { key: 'thresholds', title: '语义指标阈值', detail: '已启用领域阈值检测', status: 'done', link: 'admin:thresholds' }
      : { key: 'thresholds', title: '语义指标阈值未启用', detail: '启用后长龄化率、逾期金额等领域指标可参与异常检测', status: 'todo', link: 'admin:thresholds' },
    embed.ok
      ? { key: 'embedding', title: `Embedding 模型（${embed.model}）`, detail: `可用 · 维度 ${embed.dims}`, status: 'done', link: 'setup:step2' }
      : { key: 'embedding', title: 'Embedding 模型未就绪', detail: `${embed.error || '探测失败'}——知识向量检索将退化为词法匹配，建议补齐后重跑向导第③步`, status: 'warn', link: 'setup:step2' },
    entries > 0
      ? { key: 'knowledge', title: `业务知识条目 ${entries} 条`, detail: '可继续补充业务口径与自定义知识', status: 'done', link: 'admin:knowledge' }
      : { key: 'knowledge', title: '业务知识待补充', detail: '补充数据字典、口径说明可显著提升问数准确率', status: 'todo', link: 'admin:knowledge' },
    examples > 0
      ? { key: 'examples', title: `SQL 样例库 ${examples} 条`, detail: chunks > 0 ? '向量检索已就绪' : '知识向量切片为空，检索可能退化', status: chunks > 0 ? 'done' : 'warn', link: 'admin:examples' }
      : { key: 'examples', title: '样例句法库为空', detail: '冷启动问数准确率偏低，建议种子化或导入样例', status: 'warn', link: 'admin:examples' },
  ];
}

/** 向导完成后的总结数字（Step⑤ 总结卡；数据源级统计） */
export async function buildSummary(): Promise<Record<string, number>> {
  const pool = getPool();
  const [[dsRows], [kbRows], [exRows]] = await Promise.all([
    pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt, SUM(JSON_LENGTH(COALESCE(schema_json, JSON_ARRAY()))) AS tables FROM data_sources'),
    pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM knowledge_base'),
    pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM sql_examples'),
  ]);
  let tables = Number(dsRows[0]?.tables) || 0;
  if (!Number.isFinite(tables)) tables = 0;
  logger.debug(`[Setup] summary: datasources=${Number(dsRows[0]?.cnt) || 0} tables≈${tables}`);
  return {
    datasources: Number(dsRows[0]?.cnt) || 0,
    tables,
    chunks: Number(kbRows[0]?.cnt) || 0,
    examples: Number(exRows[0]?.cnt) || 0,
  };
}
