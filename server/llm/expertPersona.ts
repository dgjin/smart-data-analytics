/**
 * 问数专家角色（persona）路由与维护（v0.9.40 库化）。
 *
 * 核心流程：
 * - 阶段二解读前，按问题文本对 ACTIVE 角色按 sortOrder 升序做关键词包含匹配，第一个命中生效；
 *   均未命中时使用 persona_key='default' 的兜底角色（不参与关键词匹配）。
 * - 角色配置持久化于 expert_personas 表（启动时播种内置 5 角色），仅 ADMIN 可维护；
 *   问数链路经 60s 内存缓存读取，写操作即时失效缓存。
 *
 * 关键设计：
 * - 内置角色（is_builtin=1）可编辑但不可删除；default 角色不可禁用、不可删除、关键词恒为空
 *   （保证路由永远有兜底，防止误操作导致解读链路无角色可用）。
 * - 库不可用（查询异常）时回退到代码内置常量路由（降级不撒谎：功能可用，配置修改暂不生效）。
 * - 优先级语义：sortOrder 小的先匹配——具体职能（风险/客户/财务）应排在宽泛领域（不良）之前，
 *   避免「不良率」这类风险指标词被「不良」领域词抢先命中（内置顺序已体现）。
 */
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { getPool } from '../infra/db';

export interface ExpertPersona {
  key: string;
  /** 展示用标签（前端回答卡片角标） */
  label: string;
  /** 阶段二 system prompt 的角色设定句 */
  rolePrompt: string;
}

/** 库记录（管理面板与 CRUD 用完整结构） */
export interface PersonaRecord {
  id?: number;
  personaKey: string;
  label: string;
  keywords: string[];
  rolePrompt: string;
  /** 匹配优先级：数字小的先匹配（默认 100，内置为 10/20/30/40，default 恒 9999） */
  sortOrder: number;
  status: 'ACTIVE' | 'DISABLED';
  isBuiltin: boolean;
  createdBy?: string;
}

/** 内置角色常量：库播种源 + 库不可用时的路由兜底（单一事实源，勿在 db.ts 重复硬编码） */
export const BUILTIN_PERSONAS: Array<{ key: string; label: string; keywords: string[]; rolePrompt: string; sortOrder: number }> = [
  {
    key: 'risk',
    label: '不良资产风险管理专家',
    keywords: ['风险', '逾期', '违约', '不良率', '拨备', '损失', '催收', '诉讼', '抵押', '担保', '风控', '缓释', '预警', '迁徙'],
    rolePrompt:
      '你是不良资产从业的风险管理专家，擅长从数据中分析风险。解读时聚焦风险敞口、逾期与违约特征、风险迁徙与缓释状况，指出数据中暴露的风险信号并给出风险提示与管控建议。',
    sortOrder: 10,
  },
  {
    key: 'customer',
    label: '不良资产客户分析管理专家',
    keywords: ['客户', '借款人', '债务人', '欠款人', '画像', '分层', '分群', '拜访', '回访', '联系'],
    rolePrompt:
      '你是不良资产客户分析管理的专家，擅长数据分析。解读时聚焦客户结构、分层画像、拜访与联系行为特征，给出客户分类管理与差异化经营建议。',
    sortOrder: 20,
  },
  {
    key: 'finance',
    label: '专业财务分析师',
    keywords: ['财务', '营收', '收入', '利润', '成本', '费用', '资产负债', '现金流', '毛利', '净利', '账务', '资金', '回款'],
    rolePrompt:
      '你是专业的财务分析师。解读时聚焦收入、成本、利润、现金流等财务表现，关注口径一致性与结构性变化，给出财务视角的专业结论。',
    sortOrder: 30,
  },
  {
    key: 'npl',
    label: '资深不良资产从业者',
    keywords: ['不良', '资产包', '处置', '债权', '抵债', '核销', '清收', '回收'],
    rolePrompt:
      '你是资深的不良资产从业者，擅长数据分析。解读时聚焦资产包结构、处置进度、清收与回收表现，给出处置策略与经营建议。',
    sortOrder: 40,
  },
  {
    key: 'default',
    label: '金融数据分析师',
    keywords: [],
    rolePrompt: '你是专业的金融数据分析师。基于真实数据给出专业、严谨、可落地的分析结论。',
    sortOrder: 9999,
  },
];

// ---------- 同步路由（代码内置常量；库不可用时的兜底与单测入口） ----------

/** 按问题文本命中关键词路由专家角色（仅内置常量）；无任何命中时返回默认金融数据分析师 */
export function resolveExpertPersona(question: string): ExpertPersona {
  const q = String(question || '');
  for (const rule of BUILTIN_PERSONAS) {
    if (rule.key === 'default') continue;
    if (rule.keywords.some((k) => q.includes(k))) {
      return { key: rule.key, label: rule.label, rolePrompt: rule.rolePrompt };
    }
  }
  const d = BUILTIN_PERSONAS.find((r) => r.key === 'default')!;
  return { key: 'default', label: d.label, rolePrompt: d.rolePrompt };
}

// ---------- 库化加载（问数链路用；60s 内存缓存 + 写操作即时失效） ----------

// 注意：模块级缓存仅在进程内加速读取，正确性不依赖共享（失效即回源重查）
let personaCache: { rows: PersonaRecord[]; loadedAt: number } | null = null;
const PERSONA_CACHE_TTL_MS = 60 * 1000;

/** 写操作后调用：即时失效缓存，下一次问数回源取最新配置 */
export function invalidateExpertPersonaCache(): void {
  personaCache = null;
}

function rowToPersona(r: any): PersonaRecord {
  let keywords: string[] = [];
  try {
    const parsed = JSON.parse(String(r.keywords || '[]'));
    if (Array.isArray(parsed)) keywords = parsed.filter((k): k is string => typeof k === 'string');
  } catch { /* 非法 JSON 按空关键词处理（该角色不参与匹配） */ }
  return {
    id: Number(r.id),
    personaKey: String(r.persona_key),
    label: String(r.label),
    keywords,
    rolePrompt: String(r.role_prompt),
    sortOrder: Number(r.sort_order ?? 100),
    status: r.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    isBuiltin: Number(r.is_builtin) === 1,
    createdBy: String(r.created_by || ''),
  };
}

/** 管理面板列表：全量（含禁用），按匹配优先级排序 */
export async function listPersonas(): Promise<PersonaRecord[]> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT * FROM expert_personas ORDER BY sort_order ASC, id ASC LIMIT 200'
  );
  return rows.map(rowToPersona);
}

/** 问数链路专用：ACTIVE 角色（60s 缓存；失败向上抛由调用方回退内置常量） */
async function loadActivePersonasCached(): Promise<PersonaRecord[]> {
  if (personaCache && Date.now() - personaCache.loadedAt < PERSONA_CACHE_TTL_MS) {
    return personaCache.rows;
  }
  const [rows] = await getPool().query<RowDataPacket[]>(
    "SELECT * FROM expert_personas WHERE status = 'ACTIVE' ORDER BY sort_order ASC, id ASC LIMIT 200"
  );
  const parsed = rows.map(rowToPersona);
  personaCache = { rows: parsed, loadedAt: Date.now() };
  return parsed;
}

/**
 * 库化路由（问数链路入口）：ACTIVE 角色按 sortOrder 升序关键词匹配，无命中用库中 default 角色。
 * 库查询异常时回退代码内置常量（降级不撒谎：路由仍可用，但管理员修改暂不生效）。
 */
export async function resolveExpertPersonaAsync(question: string): Promise<ExpertPersona> {
  try {
    const rows = await loadActivePersonasCached();
    const q = String(question || '');
    for (const r of rows) {
      if (r.personaKey === 'default') continue;
      if (r.keywords.some((k) => k && q.includes(k))) {
        return { key: r.personaKey, label: r.label, rolePrompt: r.rolePrompt };
      }
    }
    const d = rows.find((r) => r.personaKey === 'default');
    if (d) return { key: 'default', label: d.label, rolePrompt: d.rolePrompt };
  } catch {
    // 库不可用：落回内置常量路由
  }
  return resolveExpertPersona(question);
}

// ---------- 启动播种（server.ts 在 initSchema 后调用；表非空则跳过，幂等） ----------

export async function ensureExpertPersonasSeeded(): Promise<void> {
  const pool = getPool();
  const [rows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS c FROM expert_personas');
  if (Number(rows[0]?.c || 0) > 0) return;
  for (const b of BUILTIN_PERSONAS) {
    await pool.query(
      "INSERT IGNORE INTO expert_personas (persona_key, label, keywords, role_prompt, sort_order, status, is_builtin, created_by) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, 'system')",
      [b.key, b.label, JSON.stringify(b.keywords), b.rolePrompt, b.sortOrder]
    );
  }
}

// ---------- CRUD（routes/expertPersonas.ts 调用，全 ADMIN） ----------

/** 校验并规整角色输入；非法时返回 error 说明（路由层据此 400） */
export function sanitizePersonaInput(input: any): { ok: true; persona: Omit<PersonaRecord, 'id' | 'personaKey' | 'isBuiltin'> } | { ok: false; error: string } {
  const label = typeof input?.label === 'string' ? input.label.trim() : '';
  const rolePrompt = typeof input?.rolePrompt === 'string' ? input.rolePrompt.trim() : '';
  const rawKeywords = Array.isArray(input?.keywords) ? input.keywords : [];
  const keywords: string[] = [];
  for (const k of rawKeywords) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t) continue; // 空关键词跳过（表单分隔输入易产生空项）
    if (t.length > 30) return { ok: false, error: '触发关键词单个长度须为 1-30 字' };
    if (!keywords.includes(t)) keywords.push(t);
    if (keywords.length > 20) return { ok: false, error: '触发关键词最多 20 个' };
  }
  const sortOrder = Number.isInteger(Number(input?.sortOrder)) ? Math.max(0, Math.min(9999, Number(input.sortOrder))) : 100;

  if (!label || label.length > 50) return { ok: false, error: '角色标签必填且不超过 50 字' };
  if (!rolePrompt || rolePrompt.length > 500) return { ok: false, error: '角色提示词（rolePrompt）必填且不超过 500 字' };

  return {
    ok: true,
    persona: {
      label,
      keywords,
      rolePrompt,
      sortOrder,
      status: input?.status === 'DISABLED' ? 'DISABLED' : 'ACTIVE',
    },
  };
}

/** 新建自定义角色（仅 ADMIN）：personaKey 内部生成（p_ 前缀），立即生效 */
export async function createPersona(
  persona: Omit<PersonaRecord, 'id' | 'personaKey' | 'isBuiltin'>,
  createdBy: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const key = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const [result] = await getPool().query<ResultSetHeader>(
    'INSERT INTO expert_personas (persona_key, label, keywords, role_prompt, sort_order, status, is_builtin, created_by) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
    [key, persona.label, JSON.stringify(persona.keywords), persona.rolePrompt, persona.sortOrder, persona.status, createdBy]
  );
  invalidateExpertPersonaCache();
  return { ok: true, id: result.insertId };
}

/**
 * 更新角色（仅 ADMIN）。保护规则：
 * - default 角色：仅允许改标签与 rolePrompt（关键词恒空、状态恒 ACTIVE、优先级恒 9999），保证路由兜底永可用；
 * - 其余内置角色：label/keywords/rolePrompt/sortOrder/status 均可改（is_builtin 与 key 不可变）。
 */
export async function updatePersona(
  id: number,
  persona: Omit<PersonaRecord, 'id' | 'personaKey' | 'isBuiltin'>
): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const pool = getPool();
  const [existing] = await pool.query<RowDataPacket[]>('SELECT persona_key FROM expert_personas WHERE id = ? LIMIT 1', [id]);
  if (existing.length === 0) return { ok: false, error: '角色不存在', notFound: true };
  const isDefault = String(existing[0].persona_key) === 'default';
  const eff = isDefault
    ? { ...persona, keywords: [] as string[], status: 'ACTIVE' as const, sortOrder: 9999 }
    : persona;
  await pool.query(
    'UPDATE expert_personas SET label = ?, keywords = ?, role_prompt = ?, sort_order = ?, status = ? WHERE id = ?',
    [eff.label, JSON.stringify(eff.keywords), eff.rolePrompt, eff.sortOrder, eff.status, id]
  );
  invalidateExpertPersonaCache();
  return { ok: true };
}

/** 删除角色（仅 ADMIN；内置角色拒绝删除——内置是路由语义的一部分，删除会造成路由缺口） */
export async function deletePersona(id: number): Promise<{ ok: true } | { ok: false; error: string; notFound?: boolean }> {
  const pool = getPool();
  const [existing] = await pool.query<RowDataPacket[]>('SELECT is_builtin FROM expert_personas WHERE id = ? LIMIT 1', [id]);
  if (existing.length === 0) return { ok: false, error: '角色不存在', notFound: true };
  if (Number(existing[0].is_builtin) === 1) return { ok: false, error: '内置角色不可删除（可编辑或停用）' };
  await pool.query<ResultSetHeader>('DELETE FROM expert_personas WHERE id = ?', [id]);
  invalidateExpertPersonaCache();
  return { ok: true };
}
