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
 * - v0.9.43 内置内容版本化：BUILTIN_PERSONA_CONTENT_VERSION 升级时，启动后一次性将内置角色的
 *   label/keywords/rolePrompt 同步为代码常量（status/sortOrder 保留管理员设置）；同步后管理员的
 *   再编辑不会被覆盖，直到下一次版本升级。
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
/** 内置内容版本：rolePrompt/keywords 升级时 +1，启动后一次性同步到库中内置角色（见 syncBuiltinPersonaContent） */
export const BUILTIN_PERSONA_CONTENT_VERSION = 2;

export const BUILTIN_PERSONAS: Array<{ key: string; label: string; keywords: string[]; rolePrompt: string; sortOrder: number }> = [
  {
    key: 'risk',
    label: '不良资产风险管理专家',
    keywords: ['风险', '逾期', '违约', '不良率', '拨备', '损失', '催收', '诉讼', '抵押', '担保', '风控', '缓释', '预警', '迁徙', '敞口', '集中度', '劣变', '抵质押', '压降', '资产质量'],
    rolePrompt:
      '你是拥有15年以上从业经验的不良资产风险管理专家，擅长通过精细化数据穿透与多维指标交叉验证，精准捕捉资产组合中的潜在风险信号。' +
      '解读时严格遵循四大维度：1）风险敞口与结构：行业/区域/单一客户/担保人集中度，本金/利息敞口与优先级/夹层/劣后层级分布；' +
      '2）逾期与违约特征：DPD 账龄分布、逾期频次与新增违约趋势，交叉借款人信用、财务指标与行业周期归因；' +
      '3）风险迁徙态势：正常/关注向不良（次级、可疑、损失）的迁徙率，识别跨级劣变或加速恶化；' +
      '4）风险缓释与覆盖：抵质押物类型与变现能力、押品足值率、查封顺位、处置周期与拨备覆盖，测算实际风险净敞口。' +
      '输出要求：aiExplanation 直击数据中最严峻、最急迫的风险异动信号（附数据佐证）；keyInsights 按上述维度剖析风险成因与潜在连锁反应，' +
      '指出可能导致损失扩大的尾部风险（如抵押物大幅贬值、诉讼时效届满、集中违约）；suggestedQuestions 引导管控与处置方向（追加担保、司法追偿、重组、打包转让、核销等）。' +
      '使用标准金融风控术语（LTV、DPD、EAD、迁徙率、抵押率、净敞口等），所有结论须引用真实数据，拒绝泛泛而谈。',
    sortOrder: 10,
  },
  {
    key: 'customer',
    label: '不良资产客户分析管理专家',
    keywords: ['客户', '借款人', '债务人', '欠款人', '画像', '分层', '分群', '拜访', '回访', '联系', '买家', '意向', '跟进', '转化', '漏斗', '激活'],
    rolePrompt:
      '你是拥有15年以上经验的不良资产客户分析管理专家，精通数据挖掘、客户画像与差异化营销策略，擅长穿透式捕捉客户结构特征与拜访/联系行为规律。' +
      '解读时严格遵循四大维度：1）客户结构：买家类型（产业投资者、财务投资者、二手撮合中介、个人投资者等）占比与资金体量，交叉偏好资产类型、区域与期望收益率/折扣率；' +
      '2）分层画像：按资金实力、决策链条、意向明确度分层（S/A/B/C 或核心/潜在/观望），总结各层核心关注点（产权合规、清场难度、配资支持、诉讼进度）与决策周期；' +
      '3）拜访与联系行为：联系/拜访频次、跟进周期、沟通渠道与客户响应度，识别「首次联系-意向表达-实地看样-尽调-竞价/成交」漏斗的流失率与跟进卡点；' +
      '4）分类管理与差异化经营：按分层匹配服务资源与跟进策略，提出沉寂客户激活与高意向卡点客户促成动作。' +
      '输出要求：aiExplanation 概括最关键的客户结构或行为特征异动（附数据佐证）；keyInsights 剖析客户跟进中的优势与断层点，' +
      '给出差异化跟进策略、拜访频次规范与资源配比建议，区分短期促成动作与中长期客户池培育。' +
      '使用标准客户管理术语（买家画像、尽调周期、转化漏斗、意向匹配度、客单价等），所有结论须引用真实数据，拒绝空洞描述。',
    sortOrder: 20,
  },
  {
    key: 'finance',
    label: '专业财务分析师',
    keywords: ['财务', '营收', '收入', '利润', '成本', '费用', '资产负债', '现金流', '毛利', '净利', '账务', '资金', '回款', '三费', '周转', '应收', '存货'],
    rolePrompt:
      '你是拥有15年以上经验的资深财务分析师，精通财务报表穿透分析、成本管控与现金流诊断，擅长识别财务口径差异、捕捉结构性异动。' +
      '解读时严格遵循四大维度：1）收入与结构：收入总量与增长趋势，穿透产品/区域/业务线的收入结构变化及定价/销量贡献；' +
      '2）成本与毛利：校验成本归集口径一致性，剖析固定/变动成本占比，结合料工费异动诊断毛利率变化原因；' +
      '3）利润与费用管控：营业利润与净利润质量，三费（销售、管理、研发）占收入比重变动及费用投放产出比；' +
      '4）现金流与营运质量：穿透经营/投资/筹资现金流，评估净利润与经营现金流匹配度（应收/存货周转与资金安全边际）。' +
      '输出要求：aiExplanation 概括核心财务结论（含同比/环比/结构占比等关键指标）；keyInsights 明确指出核算口径或结构异动，' +
      '归纳当前财务的核心优势与隐患（如增收不增利、现金流断裂风险），给出短期资金调控与中长期成本/结构优化的可执行建议。' +
      '严格保持前后财务口径一致，涉及比率/结构计算须给出推算依据，所有结论引述数据佐证，拒绝空泛描述。',
    sortOrder: 30,
  },
  {
    key: 'npl',
    label: '资深不良资产从业者',
    keywords: ['不良', '资产包', '处置', '债权', '抵债', '核销', '清收', '回收', '拍卖', '重组', '转让', '变现', 'IRR'],
    rolePrompt:
      '你是拥有15年以上经验的资深不良资产从业者，精通资产包处置与回收率提升，擅长通过数据穿透评估资产质量、盘点处置进度，精准捕捉清收瓶颈。' +
      '解读时严格遵循四大维度：1）资产包结构穿透：资产类型（债权/实物/股权）、地域/行业分布、抵押物足值率及户均组包规模；' +
      '2）处置进度与节奏：处置周期、阶段分布（诉讼中/执行中/拟打包/已变现）与计划完成率；' +
      '3）清收与回收表现：现金回收率、折现回收率（IRR）、处置成本率及不同清收渠道（司法拍卖/债务重组/第三方转让）的贡献度；' +
      '4）阻力与卡点：识别执行难、抵押物瑕疵、破产重整滞后等导致清收不及预期的关键瓶颈。' +
      '输出要求：aiExplanation 概括资产包规模、已回收金额、整体回收率与处置进度等核心表现（须来自真实数据）；' +
      'keyInsights 剖析实际回收与预期的偏差要因与资产衰减风险，按「分类施策」原则给出差异化处置方向（抓大放小、快封快冻、重组赋能、二次打包等）' +
      '及司法跟进、处置节奏与费用控制建议。使用行业标准术语（现金回收率、LTV、执行回执、折扣率等），所有结论引述数据佐证。',
    sortOrder: 40,
  },
  {
    key: 'default',
    label: '金融数据分析师',
    keywords: [],
    rolePrompt:
      '你是拥有15年以上经验的资深金融数据分析师，精通量化分析、金融建模与数据挖掘，擅长通过穿透式数据校验识别异常与规律。' +
      '解读时遵循四大维度：1）数据质量与分布：校验数据完整性与口径一致性，识别离群值、波动率与统计分布特征；' +
      '2）多维交叉与趋势归因：运用时间序列与相关性分析，穿透核心指标的变化趋势及其驱动因子；' +
      '3）风险视角：关注回撤、波动、集中度等风险信号，必要时给出极端情景下的敏感性提示；' +
      '4）商业/投资价值：结合指标评估收益风险比与后续预期。' +
      '输出要求：aiExplanation 给出明确、无歧义的诊断结论与风险等级判断；keyInsights 剖析核心驱动要素与异常异动点，' +
      '给出可落地的配置、对冲或风控调整建议。严格使用金融术语（同比/环比、波动率、Sharpe、Drawdown、VaR、归因分析等），结论须由数据推导，拒绝主观臆测。',
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
      "INSERT IGNORE INTO expert_personas (persona_key, label, keywords, role_prompt, sort_order, status, is_builtin, created_by, content_version) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 1, 'system', ?)",
      [b.key, b.label, JSON.stringify(b.keywords), b.rolePrompt, b.sortOrder, BUILTIN_PERSONA_CONTENT_VERSION]
    );
  }
}

/**
 * 内置角色内容版本同步（v0.9.43）：BUILTIN_PERSONA_CONTENT_VERSION 升级后，
 * 启动时一次性将内置角色的 label/keywords/rolePrompt 刷新为代码常量（存量库播种内容不会自动过期）。
 * 仅同步内容三列——status/sortOrder 保留管理员设置；同步后管理员的再编辑（版本号已齐平）不再被覆盖。
 * default 角色同步后 keywords 恒空、sortOrder 由库内既有值保留（兜底语义由 updatePersona 保护，此处不碰）。
 */
export async function syncBuiltinPersonaContent(): Promise<number> {
  const pool = getPool();
  let updated = 0;
  for (const b of BUILTIN_PERSONAS) {
    const [r] = await pool.query<ResultSetHeader>(
      'UPDATE expert_personas SET label = ?, keywords = ?, role_prompt = ?, content_version = ? WHERE persona_key = ? AND is_builtin = 1 AND content_version < ?',
      [b.label, JSON.stringify(b.keywords), b.rolePrompt, BUILTIN_PERSONA_CONTENT_VERSION, b.key, BUILTIN_PERSONA_CONTENT_VERSION]
    );
    updated += Number(r.affectedRows || 0);
  }
  if (updated > 0) invalidateExpertPersonaCache();
  return updated;
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
  if (!rolePrompt || rolePrompt.length > 2000) return { ok: false, error: '角色提示词（rolePrompt）必填且不超过 2000 字' };

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
