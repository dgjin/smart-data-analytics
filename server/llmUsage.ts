/**
 * P2-4 LLM 用量埋点：每次 LLM 调用记录 token 与耗时（按引擎/模型/通道），
 * 落库 llm_usage 表支撑多引擎成本对比；写入 fire-and-forget，失败不阻断主链路。
 */
import { getPool } from './db';

export type LlmChannel = 'json' | 'text' | 'embedding';

export interface LlmUsageEntry {
  engine: string;
  model: string;
  channel: LlmChannel;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  ok: boolean;
}

/** 单次调用用量落库（异步不等待；库未初始化/写入失败仅记日志） */
export function recordLlmUsage(entry: LlmUsageEntry): void {
  const total = (entry.promptTokens | 0) + (entry.completionTokens | 0);
  try {
    void getPool()
      .query(
        'INSERT INTO llm_usage (engine, model, channel, prompt_tokens, completion_tokens, total_tokens, duration_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          entry.engine.slice(0, 16),
          entry.model.slice(0, 128),
          entry.channel,
          entry.promptTokens | 0,
          entry.completionTokens | 0,
          total,
          entry.durationMs | 0,
          entry.ok ? 1 : 0,
        ]
      )
      .catch((err: any) => console.warn('[LlmUsage] record failed:', err?.message || err));
  } catch (err: any) {
    console.warn('[LlmUsage] record failed:', err?.message || err);
  }
}

export interface LlmUsageSummary {
  engine: string;
  model: string;
  calls: number;
  okCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  avgDurationMs: number;
}

/** 近 N 天按引擎/模型聚合（多引擎成本对比视图） */
export async function summarizeLlmUsage(days = 7): Promise<LlmUsageSummary[]> {
  const d = Math.max(1, Math.min(90, days | 0));
  const [rows] = await getPool().query(
    `SELECT engine, model,
            COUNT(*) AS calls,
            SUM(ok) AS okCalls,
            SUM(prompt_tokens) AS promptTokens,
            SUM(completion_tokens) AS completionTokens,
            SUM(total_tokens) AS totalTokens,
            AVG(duration_ms) AS avgDurationMs
     FROM llm_usage
     WHERE created_at >= NOW() - INTERVAL ? DAY
     GROUP BY engine, model
     ORDER BY totalTokens DESC`,
    [d]
  );
  return (rows as any[]).map((r) => ({
    engine: String(r.engine),
    model: String(r.model),
    calls: Number(r.calls) || 0,
    okCalls: Number(r.okCalls) || 0,
    promptTokens: Number(r.promptTokens) || 0,
    completionTokens: Number(r.completionTokens) || 0,
    totalTokens: Number(r.totalTokens) || 0,
    avgDurationMs: Math.round(Number(r.avgDurationMs) || 0),
  }));
}
