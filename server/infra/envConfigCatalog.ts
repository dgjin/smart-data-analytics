/**
 * v0.9.61 环境配置在线化：env_config 面板的标准键位目录与纯逻辑。
 *
 * 背景：env_config 表自 v0.5.0 起只是「展示/登记」表面——面板文案声称「修改后即时生效」，
 * 实际无任何消费方把表值写入 process.env（既有缺陷）。本目录提供面板落库值的白名单、
 * 脱敏哨兵与合并规则；启动合并见 envConfigSync.ts，使面板值重启后依然优先。
 *
 * 优先级语义：面板保存的非空值 > 进程环境变量 / .env.local > 代码默认值。
 * 面板值为空 = 不覆盖（回退 .env.local）——故面板初始态（种子空值）不改变既有行为。
 */

/** 脱敏哨兵：GET 输出与 PUT「未修改」判定共用（客户端全量提交时该值的敏感项按未修改跳过） */
export const ENV_CONFIG_HIDDEN = '***hidden***';

/** 数据库连接配置：自举悖论——连接参数不能由数据库自身权威决定（建池先于读表）。
 *  面板保存仅登记/审计，不参与 process.env 热更；变更请直接修改 .env.local 并重启。 */
const NON_HOT_APPLICABLE_KEYS: ReadonlySet<string> = new Set([
  'MYSQL_HOST',
  'MYSQL_PORT',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
]);

export type EnvConfigCategory = 'database' | 'ai_engine' | 'auth' | 'system';

export interface EnvConfigSeedItem {
  key: string;
  category: EnvConfigCategory;
  description: string;
  sensitive?: boolean;
}

/** 标准键位种子（启动幂等补种，值一律留空=跟随 .env.local；已存在行不覆盖） */
export const ENV_CONFIG_SEED: readonly EnvConfigSeedItem[] = [
  // ---- 数据库（面板仅登记：见 NON_HOT_APPLICABLE_KEYS 自举悖论说明）----
  { key: 'MYSQL_HOST', category: 'database', description: 'MySQL 主机地址（面板仅登记；变更需改 .env.local 并重启）' },
  { key: 'MYSQL_PORT', category: 'database', description: 'MySQL 端口（面板仅登记；变更需改 .env.local 并重启）' },
  { key: 'MYSQL_USER', category: 'database', description: 'MySQL 用户名（面板仅登记；变更需改 .env.local 并重启）' },
  { key: 'MYSQL_PASSWORD', category: 'database', description: 'MySQL 密码（面板仅登记；变更需改 .env.local 并重启）', sensitive: true },
  { key: 'MYSQL_DATABASE', category: 'database', description: 'MySQL 数据库名（面板仅登记；变更需改 .env.local 并重启）' },
  // ---- AI 引擎 ----
  { key: 'AI_ENGINE', category: 'ai_engine', description: 'AI 引擎（ollama/gemini/qwen/deepseek；留空=按密钥存在性自动：gemini > qwen > deepseek > ollama）' },
  { key: 'LLM_MODEL', category: 'ai_engine', description: 'Ollama 主推理模型（本地推荐 qwen3.8:27b-mlx）' },
  { key: 'OLLAMA_URL', category: 'ai_engine', description: 'Ollama 服务地址（默认 http://localhost:11434）' },
  { key: 'OLLAMA_TIMEOUT_MS', category: 'ai_engine', description: 'Ollama 调用超时（ms，默认 180000）' },
  { key: 'QWEN_API_KEY', category: 'ai_engine', description: '通义千问百炼 API Key', sensitive: true },
  { key: 'QWEN_URL', category: 'ai_engine', description: '千问兼容模式端点（Coding Plan Key 需用专属端点）' },
  { key: 'QWEN_MODEL', category: 'ai_engine', description: '千问模型名（默认 qwen3.8-max）' },
  { key: 'DEEPSEEK_API_KEY', category: 'ai_engine', description: 'DeepSeek API Key（DeepSeek 无公共向量端点，embedding 自动回退本地 Ollama）', sensitive: true },
  { key: 'DEEPSEEK_URL', category: 'ai_engine', description: 'DeepSeek 端点（默认 https://api.deepseek.com/v1）' },
  { key: 'DEEPSEEK_MODEL', category: 'ai_engine', description: 'DeepSeek 模型名（默认 deepseek-flash）' },
  { key: 'DEEPSEEK_TIMEOUT_MS', category: 'ai_engine', description: 'DeepSeek 调用超时（ms，默认 180000）' },
  { key: 'LLM_SQL_ENGINE', category: 'ai_engine', description: '阶段一（SQL 生成/修复/复杂度评估）快速模型引擎（留空=主引擎；勿用 deepseek-r1 推理模型）' },
  { key: 'LLM_SQL_MODEL', category: 'ai_engine', description: '阶段一快速模型名（需与引擎同时配置）' },
  { key: 'LLM_ANALYSIS_ENGINE', category: 'ai_engine', description: '阶段二（数据解读）快速模型引擎（留空=主引擎）' },
  { key: 'LLM_ANALYSIS_MODEL', category: 'ai_engine', description: '阶段二快速模型名（需与引擎同时配置）' },
  { key: 'LLM_SQL_ROUTE_MAX_TABLES', category: 'ai_engine', description: '小模型路由表数阈值（默认 1=仅单表走快速模型；放宽后关注准确率回归）' },
  { key: 'QUERY_CACHE_TTL_MINUTES', category: 'ai_engine', description: '问数结果缓存 TTL（分钟，默认 30；数据源变更自动失效）' },
  // ---- 认证授权 ----
  { key: 'JWT_SECRET', category: 'auth', description: 'JWT 签名密钥（修改后所有登录态立即失效；已加密的数据源凭据需重新录入）', sensitive: true },
  { key: 'JWT_EXPIRES_IN', category: 'auth', description: '登录态有效期（默认 12h）' },
  // ---- 系统参数 ----
  { key: 'USER_QUERY_RATE_MAX', category: 'system', description: '每用户问数限流上限（默认 20）' },
  { key: 'APP_URL', category: 'system', description: '应用托管地址（部署/链接相关）' },
];

/** 可维护键白名单（由种子目录派生，单一数据源） */
export const ENV_CONFIG_ALLOWED_KEYS: ReadonlySet<string> = new Set(ENV_CONFIG_SEED.map((s) => s.key));

export interface EnvConfigEntry {
  key: string;
  value: string;
}

/**
 * PUT 校验结果。
 * 注：不用布尔字面量判别联合——仓库 tsconfig 主档未开 strictNullChecks，
 * 该档下 `if (!res.ok)` 的成员收窄不可靠（lint 主档与 server/strict 档行为不一致），
 * 故用单接口 + 可选 error（ok=false 时 error 必有值）。
 */
export interface EnvConfigSanitizeResult {
  /** 结构/白名单校验是否全部通过 */
  ok: boolean;
  /** 通过校验、需落库并热更的条目（ok=true 时有意义） */
  accepted: EnvConfigEntry[];
  /** 脱敏哨兵按「未修改」跳过的键（ok=true 时有意义） */
  skippedUnchanged: string[];
  /** 校验失败原因（ok=false 时有意义） */
  error?: string;
}

/** PUT 输入校验与过滤：结构校验 → 白名单校验 → 脱敏哨兵按「未修改」跳过 */
export function sanitizeEnvConfigUpdates(updates: unknown): EnvConfigSanitizeResult {
  const rejected = (error: string): EnvConfigSanitizeResult => ({ ok: false, accepted: [], skippedUnchanged: [], error });
  if (!Array.isArray(updates) || updates.length === 0) return rejected('Invalid input');
  const accepted: EnvConfigEntry[] = [];
  const skippedUnchanged: string[] = [];
  for (const item of updates) {
    const key = (item as { key?: unknown } | null)?.key;
    const value = (item as { value?: unknown } | null)?.value;
    if (typeof key !== 'string' || typeof value !== 'string') return rejected('Invalid input');
    if (!ENV_CONFIG_ALLOWED_KEYS.has(key)) return rejected(`Forbidden key: ${key}`);
    // 敏感字段未修改（GET 输出原样回传）→ 跳过，防止脱敏串覆盖真实值
    if (value === ENV_CONFIG_HIDDEN) {
      skippedUnchanged.push(key);
      continue;
    }
    accepted.push({ key, value });
  }
  return { ok: true, accepted, skippedUnchanged };
}

/** 面板保存值合并进 process.env：非空覆盖、空值跳过（回退 .env.local）、MYSQL_* 跳过；返回实际写入的 key */
export function applyEnvConfigToProcess(entries: readonly EnvConfigEntry[]): string[] {
  const applied: string[] = [];
  for (const { key, value } of entries) {
    if (!ENV_CONFIG_ALLOWED_KEYS.has(key) || NON_HOT_APPLICABLE_KEYS.has(key)) continue;
    if (value === '' || process.env[key] === value) continue;
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

/** DB 行 → 可合并条目（仅白名单内非空值）；供启动合并与测试复用 */
export function mergeableRows(rows: readonly { key: string; value: string | null }[]): EnvConfigEntry[] {
  return rows
    .filter((r) => ENV_CONFIG_ALLOWED_KEYS.has(r.key) && (r.value ?? '') !== '')
    .map((r) => ({ key: r.key, value: String(r.value) }));
}
