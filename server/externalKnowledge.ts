/**
 * 外部知识库接入（企业级 RAG 服务对接）。
 * 管理员配置外部检索接口（URL + 可选 Bearer 认证），问数时与本地知识库一并检索注入，
 * 作为智能问数自主学习的又一来源（口径/术语/业务规则可沉淀在企业级知识平台）。
 *
 * 检索协议约定（简单通用，适配大多数 RAG 服务 / 可由轻量网关适配）：
 *   POST {endpoint}
 *   Content-Type: application/json
 *   Authorization: Bearer <api_key>   （auth_type=bearer 时）
 *   请求体：{ "query": "...", "topK": 4 }
 *   响应：JSON，命中列表在 results / documents / data / items 任一数组字段（或顶层数组），
 *   每项取 content / text / chunk / pageContent 之一作为片段文本，source / title 可选作来源标注。
 *
 * 任何单源异常（超时 / 非 2xx / 解析失败）降级为空结果，不阻断问数主链路；
 * api_key 以 AES-256-GCM 加密落库（复用数据源凭据加密链路），列表/详情不出明文。
 */
import { getPool } from './db';
import { encryptSecret, decryptSecret } from './secretsCrypto';
import { budgetText, EXTERNAL_KB_TOKEN_BUDGET } from './promptBudget';

export const EXTERNAL_KB_TOP_K = 4;
export const EXTERNAL_KB_DEFAULT_TIMEOUT_MS = 5000;

export interface ExternalKbSource {
  id: string;
  name: string;
  endpoint: string;
  authType: string;
  enabled: boolean;
  timeoutMs: number;
  /** 适用数据源范围：'*' 全部，否则为具体 data_source_id */
  dataSourceId: string;
  apiKey?: string;
  createdBy: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 供测试替换的 fetch 实现（默认用 Node 内置 fetch） */
let fetchImpl: typeof fetch = (...args: any[]) => (globalThis as any).fetch(...args);
export function setExternalKbFetch(impl: typeof fetch | null) {
  fetchImpl = impl ? impl : ((...args: any[]) => (globalThis as any).fetch(...args));
}

function normalizeRow(r: any): ExternalKbSource {
  return {
    id: String(r.id || ''),
    name: String(r.name || ''),
    endpoint: String(r.endpoint || ''),
    authType: String(r.auth_type || 'none'),
    enabled: Number(r.enabled) === 1,
    timeoutMs: Number(r.timeout_ms) || EXTERNAL_KB_DEFAULT_TIMEOUT_MS,
    dataSourceId: String(r.data_source_id || '*'),
    apiKey: r.api_key ? String(r.api_key) : undefined,
    createdBy: String(r.created_by || ''),
    createdAt: r.created_at ? String(r.created_at) : undefined,
    updatedAt: r.updated_at ? String(r.updated_at) : undefined,
  };
}

/** 校验外部源配置：endpoint 必须 http(s) 且长度受限 */
export function validateExternalKbInput(input: Partial<ExternalKbSource>): string | null {
  if (!input.name || !String(input.name).trim()) return '名称必填';
  const endpoint = String(input.endpoint || '').trim();
  if (!/^https?:\/\/.+/i.test(endpoint)) return '接口地址必须以 http(s):// 开头';
  if (endpoint.length > 500) return '接口地址过长';
  if (input.authType && !['none', 'bearer'].includes(String(input.authType))) return '认证方式仅支持 none / bearer';
  if (input.authType === 'bearer' && !String(input.apiKey || '').trim()) return 'Bearer 认证需填写 API Key';
  const timeout = Number(input.timeoutMs);
  if (!Number.isFinite(timeout) || timeout < 500 || timeout > 30000) return '超时须在 500~30000ms 之间';
  return null;
}

/**
 * 容错解析外部知识库检索响应：命中数组在 results/documents/data/items 之一或顶层数组；
 * 每项文本取 content/text/chunk/pageContent 之一，来源取 source/title 可选。
 * 解析不出任何片段时返回空数组（调用方降级），不抛错。
 */
export function parseExternalKbResponse(payload: unknown): { text: string; source?: string }[] {
  const out: { text: string; source?: string }[] = [];
  const pushItem = (item: any) => {
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string' && item.trim()) out.push({ text: item.trim() });
      return;
    }
    const text = [item.content, item.text, item.chunk, item.pageContent]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0);
    if (!text) return;
    const source = [item.source, item.title, item.name]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .find((v) => v.length > 0);
    out.push(source ? { text, source } : { text });
  };
  let list: unknown = payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const container = (payload as Record<string, unknown>)['results'] ??
      (payload as Record<string, unknown>)['documents'] ??
      (payload as Record<string, unknown>)['data'] ??
      (payload as Record<string, unknown>)['items'];
    list = Array.isArray(container) ? container : [];
  }
  if (!Array.isArray(list)) return [];
  for (const item of list) pushItem(item);
  // 单片段限长，防外部服务返回整本书
  return out.slice(0, 20).map((c) => ({ ...c, text: c.text.slice(0, 600) }));
}

/** 调用单个外部知识源检索（超时中断；返回片段列表，异常抛给调用方降级） */
export async function callExternalKb(
  source: Pick<ExternalKbSource, 'endpoint' | 'authType' | 'apiKey' | 'timeoutMs'>,
  query: string,
  topK = EXTERNAL_KB_TOP_K
): Promise<{ text: string; source?: string }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), source.timeoutMs || EXTERNAL_KB_DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (source.authType === 'bearer' && source.apiKey) {
      headers['Authorization'] = `Bearer ${source.apiKey}`;
    }
    const resp = await fetchImpl(source.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, topK }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    return parseExternalKbResponse(payload);
  } finally {
    clearTimeout(timer);
  }
}

export interface ExternalKbSearchResult {
  /** 已按预算截断、可直接注入阶段一 prompt 的文本块（无命中为空串） */
  snippet: string;
  okSources: number;
  failSources: number;
  totalChars: number;
}

/**
 * 问数链路入口：并行检索所有启用中且适用于该数据源的外部知识源，
 * 聚合格式化后按 token 预算截断。任何异常降级为空结果，绝不阻断问数。
 */
export async function searchExternalKnowledge(
  dataSourceId: string,
  query: string,
  topK = EXTERNAL_KB_TOP_K
): Promise<ExternalKbSearchResult> {
  const empty: ExternalKbSearchResult = { snippet: '', okSources: 0, failSources: 0, totalChars: 0 };
  try {
    const [rows] = await getPool().query(
      'SELECT * FROM external_kb_sources WHERE enabled = 1 AND (data_source_id = ? OR data_source_id = ?)',
      [String(dataSourceId || '').slice(0, 64), '*']
    );
    const sources = (rows as any[]).map(normalizeRow);
    if (sources.length === 0) return empty;

    const results = await Promise.allSettled(
      sources.map(async (s) => {
        let apiKey = s.apiKey;
        if (apiKey) {
          try {
            apiKey = decryptSecret(apiKey);
          } catch {
            apiKey = undefined;
          }
        }
        return callExternalKb({ endpoint: s.endpoint, authType: s.authType, apiKey, timeoutMs: s.timeoutMs }, query, topK);
      })
    );
    const lines: string[] = [];
    let okSources = 0;
    let failSources = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        okSources++;
        for (const chunk of r.value) {
          lines.push(`- [外部·${sources[i].name}${chunk.source ? `/${chunk.source}` : ''}] ${chunk.text.replace(/\s+/g, ' ').trim()}`);
        }
      } else {
        failSources++;
      }
    });
    if (lines.length === 0) return { ...empty, okSources, failSources };
    const raw = `外部知识库片段（来自企业外部知识源，用于理解业务口径与术语，生成 SQL 时参考，但表与列仍必须来自 Schema）:\n${lines.join('\n')}\n`;
    const snippet = budgetText(raw, EXTERNAL_KB_TOKEN_BUDGET);
    return { snippet, okSources, failSources, totalChars: lines.join('\n').length };
  } catch {
    return empty;
  }
}

// ---------- 管理接口（落库） ----------

/** 列出全部外部知识源（api_key 不出明文，仅返回 hasKey 标记） */
export async function listExternalKbSources(): Promise<(Omit<ExternalKbSource, 'apiKey'> & { hasKey: boolean })[]> {
  const [rows] = await getPool().query('SELECT * FROM external_kb_sources ORDER BY created_at DESC');
  return (rows as any[]).map((r) => {
    const s = normalizeRow(r);
    const { apiKey, ...rest } = s;
    return { ...rest, hasKey: Boolean(apiKey) };
  });
}

/** 新增或编辑外部知识源：api_key 加密落库；编辑时 apiKey 留空则保留原密钥 */
export async function saveExternalKbSource(
  input: Partial<ExternalKbSource>,
  createdBy: string,
  existingId?: string
): Promise<string> {
  const name = String(input.name || '').trim().slice(0, 100);
  const endpoint = String(input.endpoint || '').trim().slice(0, 500);
  const authType = input.authType === 'bearer' ? 'bearer' : 'none';
  const timeoutMs = Math.max(500, Math.min(30000, Number(input.timeoutMs) || EXTERNAL_KB_DEFAULT_TIMEOUT_MS));
  const dataSourceId = String(input.dataSourceId || '*').trim().slice(0, 64) || '*';
  const enabled = input.enabled === false ? 0 : 1;
  const pool = getPool();

  if (existingId) {
    const apiKeyPart =
      authType === 'bearer' && String(input.apiKey || '').trim()
        ? encryptSecret(String(input.apiKey).trim())
        : authType === 'none'
          ? null
          : undefined; // undefined = 保留原值
    if (apiKeyPart === undefined) {
      await pool.query(
        'UPDATE external_kb_sources SET name = ?, endpoint = ?, auth_type = ?, enabled = ?, timeout_ms = ?, data_source_id = ? WHERE id = ?',
        [name, endpoint, authType, enabled, timeoutMs, dataSourceId, existingId]
      );
    } else {
      await pool.query(
        'UPDATE external_kb_sources SET name = ?, endpoint = ?, auth_type = ?, api_key = ?, enabled = ?, timeout_ms = ?, data_source_id = ? WHERE id = ?',
        [name, endpoint, authType, apiKeyPart, enabled, timeoutMs, dataSourceId, existingId]
      );
    }
    return existingId;
  }
  const id = `ekb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const apiKeyEncrypted = authType === 'bearer' && String(input.apiKey || '').trim() ? encryptSecret(String(input.apiKey).trim()) : null;
  await pool.query(
    'INSERT INTO external_kb_sources (id, name, endpoint, auth_type, api_key, enabled, timeout_ms, data_source_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, name, endpoint, authType, apiKeyEncrypted, enabled, timeoutMs, dataSourceId, String(createdBy || '').slice(0, 50)]
  );
  return id;
}

/** 删除外部知识源（软影响：问数链路即时不再检索该源） */
export async function deleteExternalKbSource(id: string): Promise<boolean> {
  const [result] = (await getPool().query('DELETE FROM external_kb_sources WHERE id = ?', [id])) as any;
  return Boolean(result && result.affectedRows > 0);
}

/** 连通性测试：用传入配置即时检索一次，返回状态与耗时（不落库） */
export async function testExternalKbEndpoint(
  input: Pick<ExternalKbSource, 'endpoint' | 'authType' | 'apiKey' | 'timeoutMs'>,
  probeQuery = '连通性测试'
): Promise<{ ok: boolean; latencyMs: number; chunks: number; error?: string }> {
  const startedAt = Date.now();
  try {
    const chunks = await callExternalKb(input, probeQuery, 2);
    return { ok: true, latencyMs: Date.now() - startedAt, chunks: chunks.length };
  } catch (err: any) {
    const msg = String(err?.name === 'AbortError' ? '请求超时' : err?.message || err || '未知错误');
    return { ok: false, latencyMs: Date.now() - startedAt, chunks: 0, error: msg.slice(0, 200) };
  }
}
