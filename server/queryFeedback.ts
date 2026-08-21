/**
 * P1 反馈闭环 + Few-shot 样例库（Vanna training data 借鉴）。
 * 训练语料统一落在 sql_examples 表：管理员手工登记（MANUAL）、点赞自动沉淀（FEEDBACK_UP）、
 * 批量导入（IMPORT）三类来源；问数时检索相似样例以 user/assistant 消息对注入阶段一。
 * 管理员可对全部样例编辑/剔除，避免劣质样例长期污染 few-shot。
 */
import { getPool } from './db';
import { extractTableRefs, stripCommentsAndStrings } from './sqlExecutor';
import { callLLMJson, callEmbedding } from './llmClient';
import { approxTokens, FEWSHOT_TOKEN_BUDGET } from './promptBudget';

/** 余弦相似度（与 knowledgeBase 同实现；内联避免相互 import 形成循环依赖） */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 样例问题向量落库（JSON 数组文本）；embedding 引擎不可用时返回 null，检索自动降级 bigram */
async function embedExampleQuestion(question: string): Promise<string | null> {
  try {
    const vec = await callEmbedding(question.slice(0, 500), 'document');
    return JSON.stringify(vec);
  } catch {
    return null;
  }
}

export type FeedbackVerdict = 'UP' | 'DOWN';

export interface FeedbackInput {
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
  executedSql: string;
  verdict: FeedbackVerdict;
  provenance: string;
}

export async function saveFeedback(input: FeedbackInput): Promise<void> {
  // P1-1 反馈幂等：同用户同源同问答同结论 24h 内重复提交（连点/重放）直接跳过
  const [dup] = await getPool().query(
    `SELECT COUNT(*) AS cnt FROM query_feedback
     WHERE user_id = ? AND data_source_id = ? AND question = ? AND executed_sql = ? AND verdict = ?
       AND created_at > NOW() - INTERVAL 24 HOUR`,
    [input.userId, input.dataSourceId.slice(0, 64), input.question.slice(0, 500), input.executedSql.slice(0, 2000), input.verdict]
  );
  if (Number((dup as any[])[0]?.cnt) > 0) return;

  await getPool().query(
    'INSERT INTO query_feedback (user_id, username, data_source_id, question, executed_sql, verdict, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      input.userId,
      input.username.slice(0, 50),
      input.dataSourceId.slice(0, 64),
      input.question.slice(0, 500),
      input.executedSql.slice(0, 2000),
      input.verdict,
      input.provenance.slice(0, 20),
    ]
  );
  // Vanna auto_train 借鉴：点赞的真实执行问答对自动沉淀进样例库（同问题同 SQL 幂等跳过）
  if (input.verdict === 'UP' && input.provenance === 'live' && input.executedSql.trim()) {
    const pool = getPool();
    const [dup] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM sql_examples WHERE data_source_id = ? AND question = ? AND sql_text = ?',
      [input.dataSourceId.slice(0, 64), input.question.slice(0, 500), normalizeSql(input.executedSql)]
    );
    if (Number((dup as any[])[0]?.cnt) === 0) {
      // P1-3：问题向量同步落库，检索时免逐条 embed（本地 nomic 毫秒级；引擎不可用存 NULL 降级词法）
      const embeddingJson = await embedExampleQuestion(input.question);
      await pool.query(
        "INSERT INTO sql_examples (data_source_id, question, sql_text, source, created_by, embedding) VALUES (?, ?, ?, 'FEEDBACK_UP', ?, ?)",
        [input.dataSourceId.slice(0, 64), input.question.slice(0, 500), normalizeSql(input.executedSql), input.username.slice(0, 50), embeddingJson]
      );
    }
  }
}

/** 中文友好的相似度：二字滑窗（bigram）重合数，零依赖、够用即可 */
export function bigramOverlap(a: string, b: string): number {
  const grams = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) grams.add(a.slice(i, i + 2));
  let score = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (grams.has(b.slice(i, i + 2))) score++;
  }
  return score;
}

/** SQL 归一化：压缩为单行（去多余空白），用于样例去重与 prompt 展示 */
export function normalizeSql(sql: string): string {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

export interface FewShotExample {
  question: string;
  sql: string;
  source: 'MANUAL' | 'FEEDBACK_UP' | 'IMPORT';
}

export interface NegativeExample {
  question: string;
  /** 错误答案涉及的表名特征（逗号分隔）。P0-3：不再向 prompt 提供完整错误 SQL，防止 LLM 照抄负例。 */
  wrongTables: string;
}

/**
 * 自主学习之反例沉淀：同数据源点踩（DOWN）的问答对，按问题相似度取 top N，
 * 以「反面教材」形式注入阶段一 prompt，避免重复犯同类错误（与点赞正例互补）。
 * P0-3 双重防照抄：① 只返回问题与错误答案的表名特征，完整错误 SQL 不出库；
 * ② 相似度阈值 bigram≥4（低重叠属噪声，注入反而误导）。
 * 相同归一化 SQL 只留一条。
 */
export async function loadNegativeExamples(
  dataSourceId: string,
  question: string,
  maxCount = 2
): Promise<NegativeExample[]> {
  const [rows] = await getPool().query(
    `SELECT question, executed_sql FROM query_feedback
     WHERE data_source_id = ? AND verdict = 'DOWN' AND executed_sql <> ''
     ORDER BY id DESC LIMIT 50`,
    [dataSourceId]
  );
  const scored = (rows as any[])
    .map((r) => ({
      question: String(r.question),
      normSql: normalizeSql(String(r.executed_sql)).slice(0, 500),
      score: bigramOverlap(question, String(r.question)),
    }))
    .filter((r) => r.score >= 4)
    .sort((a, b) => b.score - a.score);
  const bySql = new Set<string>();
  const picked: NegativeExample[] = [];
  for (const s of scored) {
    if (picked.length >= maxCount) break;
    if (bySql.has(s.normSql)) continue;
    bySql.add(s.normSql);
    picked.push({
      question: s.question,
      wrongTables: extractTableRefs(stripCommentsAndStrings(s.normSql)).slice(0, 3).join(', '),
    });
  }
  return picked;
}

/**
 * 检索与当前问题最相似的样例（同数据源、近 100 条内），
 * 借鉴 DAIL-SQL 多维度打分：
 * - 问题语义相似度（P1-3）：样例向量落库 + 问题侧单次 embed，余弦 × 8（同义不同词也能召回）；
 *   embedding 不可用/向量缺失时自动降级纯词法，行为与旧版一致
 * - 问题词法相似度：bigram 重合
 * - SQL 结构相似度：样例 SQL 引用的表与当前问题 schema-linking 圈定表的重合数 × 3
 * 相同归一化 SQL 只保留得分最高的一条；按 token 预算贪心取 top，返回结构化问答对，
 * 由调用方以 user/assistant 消息对注入（Vanna few-shot 注入方式）。
 */
export async function loadFewShotExamples(
  dataSourceId: string,
  question: string,
  relevantTables: string[] = []
): Promise<FewShotExample[]> {
  const [rows] = await getPool().query(
    `SELECT question, sql_text, source, embedding FROM sql_examples
     WHERE data_source_id = ? AND sql_text <> ''
     ORDER BY id DESC LIMIT 100`,
    [dataSourceId]
  );
  const relevantSet = new Set(relevantTables.map((t) => String(t).toLowerCase()));

  // P1-3：问题侧仅 embed 一次；失败降级 null（纯词法打分）
  let qVec: number[] | null = null;
  try {
    qVec = await callEmbedding(question.slice(0, 500), 'query');
  } catch {
    qVec = null;
  }

  const scored = (rows as any[])
    .map((r) => {
      const rawSql = String(r.sql_text);
      let semantic = 0;
      if (qVec && typeof r.embedding === 'string' && r.embedding) {
        try {
          const vec = JSON.parse(r.embedding);
          if (Array.isArray(vec)) semantic = cosine(qVec, vec as number[]) * 8;
        } catch {
          // 向量损坏时不加分，降级词法
        }
      }
      const qScore = bigramOverlap(question, String(r.question)) + Math.max(0, semantic);
      const sqlTables = extractTableRefs(stripCommentsAndStrings(rawSql));
      const tableOverlap = relevantSet.size > 0 ? sqlTables.filter((t) => relevantSet.has(t)).length : 0;
      return {
        question: String(r.question),
        sql: normalizeSql(rawSql),
        source: (String(r.source) as FewShotExample['source']) || 'MANUAL',
        score: qScore + tableOverlap * 3,
      };
    })
    .filter((r) => r.score > 0);

  // 相同 SQL 去重：保留最高分
  const bySql = new Map<string, any>();
  for (const s of scored) {
    const prev = bySql.get(s.sql);
    if (!prev || s.score > prev.score) bySql.set(s.sql, s);
  }
  const ranked = [...bySql.values()].sort((a, b) => b.score - a.score);

  // token 预算内贪心取 top（最多 3 条）
  const picked: FewShotExample[] = [];
  let used = 0;
  for (const ex of ranked) {
    if (picked.length >= 3) break;
    const cost = approxTokens(ex.question) + approxTokens(ex.sql);
    if (used + cost > FEWSHOT_TOKEN_BUDGET) break;
    used += cost;
    picked.push({ question: ex.question, sql: ex.sql, source: ex.source });
  }
  return picked;
}

// ---------- SQL 样例库管理（管理员维护的训练语料） ----------

export interface SqlExampleRecord {
  id: number;
  dataSourceId: string;
  question: string;
  sql: string;
  source: 'MANUAL' | 'FEEDBACK_UP' | 'IMPORT';
  createdBy: string;
  createdAt: string;
}

function toExampleRecord(r: any): SqlExampleRecord {
  return {
    id: Number(r.id),
    dataSourceId: String(r.data_source_id),
    question: String(r.question),
    sql: String(r.sql_text),
    source: (String(r.source) as SqlExampleRecord['source']) || 'MANUAL',
    createdBy: String(r.created_by || ''),
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : '',
  };
}

/** 样例入参校验；返回错误文案或 null */
export function validateExampleInput(input: { question?: unknown; sql?: unknown }): string | null {
  const q = typeof input.question === 'string' ? input.question.trim() : '';
  if (!q) return '问题不能为空';
  if (q.length > 500) return '问题不能超过 500 字';
  const sql = typeof input.sql === 'string' ? input.sql.trim() : '';
  if (!sql) return 'SQL 不能为空';
  if (sql.length > 2000) return 'SQL 不能超过 2000 字';
  if (!/^select\b/i.test(sql)) return '仅支持登记 SELECT 查询样例';
  return null;
}

export async function listSqlExamples(dataSourceId: string): Promise<SqlExampleRecord[]> {
  const [rows] = await getPool().query(
    'SELECT * FROM sql_examples WHERE data_source_id = ? ORDER BY id DESC',
    [dataSourceId]
  );
  return (rows as any[]).map(toExampleRecord);
}

export async function createSqlExample(
  input: { dataSourceId: string; question: string; sql: string },
  createdBy: string,
  source: 'MANUAL' | 'IMPORT' = 'MANUAL'
): Promise<SqlExampleRecord> {
  const embeddingJson = await embedExampleQuestion(input.question);
  const result: any = await getPool().query(
    'INSERT INTO sql_examples (data_source_id, question, sql_text, source, created_by, embedding) VALUES (?, ?, ?, ?, ?, ?)',
    [input.dataSourceId.slice(0, 64), input.question.trim().slice(0, 500), normalizeSql(input.sql).slice(0, 2000), source, createdBy.slice(0, 50), embeddingJson]
  );
  const insertId = Number(result[0]?.insertId);
  const [rows] = await getPool().query('SELECT * FROM sql_examples WHERE id = ?', [insertId]);
  return toExampleRecord((rows as any[])[0]);
}

export async function updateSqlExample(
  id: number,
  input: { question: string; sql: string }
): Promise<boolean> {
  // P1-3：问题变更时向量同步重算，避免旧向量与新问题语义脱节
  const embeddingJson = await embedExampleQuestion(input.question);
  const result: any = await getPool().query(
    'UPDATE sql_examples SET question = ?, sql_text = ?, embedding = ? WHERE id = ?',
    [input.question.trim().slice(0, 500), normalizeSql(input.sql).slice(0, 2000), embeddingJson, id]
  );
  return Number(result[0]?.affectedRows) > 0;
}

export async function deleteSqlExample(id: number): Promise<boolean> {
  const result: any = await getPool().query('DELETE FROM sql_examples WHERE id = ?', [id]);
  return Number(result[0]?.affectedRows) > 0;
}

/** P2-8 冷启动：给一批 SQL 反推自然语言问题（Vanna generate_question 思路），不入库，供前端预览确认 */
export async function generateQuestionsForSqls(sqls: string[]): Promise<{ sql: string; question: string }[]> {
  const out: { sql: string; question: string }[] = [];
  for (const raw of sqls.slice(0, 10)) {
    const sql = normalizeSql(raw).slice(0, 2000);
    if (!sql || !/^select\b/i.test(sql)) {
      out.push({ sql, question: '' });
      continue;
    }
    let question: string;
    try {
      const text = await callLLMJson(
        '你是数据分析助手。给定一条 SELECT 查询，用一句简洁的中文自然语言问题描述它的分析意图（不要提及表名细节，聚焦业务含义）。只输出问题本身，不要任何前缀、引号或解释。',
        `SQL：${sql}`
      );
      question = String(text || '').trim().replace(/^["']|["']$/g, '').slice(0, 200);
    } catch {
      question = '';
    }
    out.push({ sql, question });
  }
  return out;
}
