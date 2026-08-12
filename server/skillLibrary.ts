/**
 * 技能库管理（P2-A Skills 增强）。
 * - USER scope：每位用户维护自己的技能库（仅本人可增删改）
 * - SYSTEM scope：系统默认技能库（管理员维护，全员在问数面板可见可用）
 * - 分享流程：用户对个人技能发起分享申请（PENDING_SHARE）→ 管理员审核
 *   通过后复制一份进入系统库（原作者署名保留），拒绝则退回私有。
 * 技能仍只是「提问模板」，不绕过 NL2SQL 与安全执行层。
 */
import mysql from 'mysql2/promise';
import { getPool } from './db';

export type SkillScope = 'USER' | 'SYSTEM';
export type SkillStatus = 'ACTIVE' | 'PENDING_SHARE';

export interface SkillRecord {
  skillId: string;
  name: string;
  description: string;
  promptTemplate: string;
  placeholders: string[];
  scope: SkillScope;
  status: SkillStatus;
  createdBy: string;
}

const MAX_NAME_LEN = 100;
const MAX_DESC_LEN = 500;
const MAX_TEMPLATE_LEN = 1000;

/** 从模板中提取 {{占位符}}（去重保序），与 skills.ts fillSkillTemplate 的解析规则一致 */
export function extractPlaceholders(template: string): string[] {
  const out: string[] = [];
  const re = /{{\s*([^}]+?)\s*}}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(template || ''))) !== null) {
    const key = m[1].trim();
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** 新增/编辑入参校验；返回错误文案或 null（通过）。placeholders 一律由模板自动提取 */
export function validateSkillInput(input: {
  name?: unknown;
  description?: unknown;
  promptTemplate?: unknown;
}): string | null {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return '技能名称不能为空';
  if (name.length > MAX_NAME_LEN) return `技能名称不能超过 ${MAX_NAME_LEN} 字`;
  const tpl = typeof input.promptTemplate === 'string' ? input.promptTemplate.trim() : '';
  if (!tpl) return '提问模板不能为空';
  if (tpl.length > MAX_TEMPLATE_LEN) return `提问模板不能超过 ${MAX_TEMPLATE_LEN} 字`;
  const desc = typeof input.description === 'string' ? input.description.trim() : '';
  if (desc.length > MAX_DESC_LEN) return `技能描述不能超过 ${MAX_DESC_LEN} 字`;
  return null;
}

function toRecord(row: mysql.RowDataPacket): SkillRecord {
  let ph: unknown = [];
  try {
    ph = JSON.parse(String(row.placeholders || '[]'));
  } catch {
    ph = [];
  }
  return {
    skillId: String(row.skill_id),
    name: String(row.name),
    description: String(row.description || ''),
    promptTemplate: String(row.prompt_template || ''),
    placeholders: Array.isArray(ph) ? ph.filter((x): x is string => typeof x === 'string') : [],
    scope: row.scope === 'SYSTEM' ? 'SYSTEM' : 'USER',
    status: row.status === 'PENDING_SHARE' ? 'PENDING_SHARE' : 'ACTIVE',
    createdBy: String(row.created_by || ''),
  };
}

async function findBySkillId(skillId: string): Promise<SkillRecord | null> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>(
    'SELECT * FROM skill_library WHERE skill_id = ? LIMIT 1',
    [skillId]
  );
  return rows.length > 0 ? toRecord(rows[0]) : null;
}

/** 问数面板可见技能：系统库全部生效技能 + 本人个人库生效技能 */
export async function listVisibleSkills(username: string): Promise<SkillRecord[]> {
  const [rows] = await getPool().query<mysql.RowDataPacket[]>(
    `SELECT * FROM skill_library
     WHERE status = 'ACTIVE' AND (scope = 'SYSTEM' OR (scope = 'USER' AND created_by = ?))
     ORDER BY scope = 'USER' ASC, name ASC`,
    [username]
  );
  return rows.map(toRecord);
}

/** 管理视图：我的技能（全部状态）+ 系统库；管理员额外返回待审核分享列表 */
export async function listManageSkills(
  username: string,
  isAdmin: boolean
): Promise<{ mySkills: SkillRecord[]; systemSkills: SkillRecord[]; pendingShares: SkillRecord[] }> {
  const pool = getPool();
  const [myRows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM skill_library WHERE scope = 'USER' AND created_by = ? ORDER BY updated_at DESC",
    [username]
  );
  const [sysRows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM skill_library WHERE scope = 'SYSTEM' ORDER BY name ASC"
  );
  let pendingShares: SkillRecord[] = [];
  if (isAdmin) {
    const [pendingRows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT * FROM skill_library WHERE scope = 'USER' AND status = 'PENDING_SHARE' ORDER BY updated_at ASC"
    );
    pendingShares = pendingRows.map(toRecord);
  }
  return {
    mySkills: myRows.map(toRecord),
    systemSkills: sysRows.map(toRecord),
    pendingShares,
  };
}

function newSkillId(): string {
  return `sk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

/** 新建个人技能 */
export async function createSkill(
  username: string,
  input: { name: string; description: string; promptTemplate: string }
): Promise<SkillRecord> {
  const skillId = newSkillId();
  const placeholders = extractPlaceholders(input.promptTemplate);
  await getPool().query(
    `INSERT INTO skill_library (skill_id, name, description, prompt_template, placeholders, scope, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'USER', 'ACTIVE', ?)`,
    [skillId, input.name.trim(), input.description.trim(), input.promptTemplate.trim(), JSON.stringify(placeholders), username]
  );
  return (await findBySkillId(skillId))!;
}

/** 编辑技能：个人技能仅本人可改；系统技能仅管理员可改 */
export async function updateSkill(
  username: string,
  isAdmin: boolean,
  skillId: string,
  input: { name: string; description: string; promptTemplate: string }
): Promise<{ ok: true; skill: SkillRecord } | { ok: false; status: number; error: string }> {
  const existing = await findBySkillId(skillId);
  if (!existing) return { ok: false, status: 404, error: '技能不存在' };
  const allowed = existing.scope === 'SYSTEM' ? isAdmin : existing.createdBy === username;
  if (!allowed) return { ok: false, status: 403, error: '没有该技能的维护权限' };
  const placeholders = extractPlaceholders(input.promptTemplate);
  await getPool().query(
    'UPDATE skill_library SET name = ?, description = ?, prompt_template = ?, placeholders = ? WHERE skill_id = ?',
    [input.name.trim(), input.description.trim(), input.promptTemplate.trim(), JSON.stringify(placeholders), skillId]
  );
  return { ok: true, skill: (await findBySkillId(skillId))! };
}

/** 删除技能：权限同编辑；系统技能仅管理员可删 */
export async function deleteSkill(
  username: string,
  isAdmin: boolean,
  skillId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = await findBySkillId(skillId);
  if (!existing) return { ok: false, status: 404, error: '技能不存在' };
  const allowed = existing.scope === 'SYSTEM' ? isAdmin : existing.createdBy === username;
  if (!allowed) return { ok: false, status: 403, error: '没有该技能的维护权限' };
  await getPool().query('DELETE FROM skill_library WHERE skill_id = ?', [skillId]);
  return { ok: true };
}

/** 发起分享申请：仅本人对私有且未在申请中的技能可操作 */
export async function requestShare(
  username: string,
  skillId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = await findBySkillId(skillId);
  if (!existing) return { ok: false, status: 404, error: '技能不存在' };
  if (existing.scope !== 'USER') return { ok: false, status: 400, error: '系统技能无需分享' };
  if (existing.createdBy !== username) return { ok: false, status: 403, error: '只能分享自己的技能' };
  if (existing.status === 'PENDING_SHARE') return { ok: false, status: 400, error: '该技能已在分享审核中' };
  await getPool().query("UPDATE skill_library SET status = 'PENDING_SHARE' WHERE skill_id = ?", [skillId]);
  return { ok: true };
}

/** 撤回分享申请（本人） */
export async function cancelShare(
  username: string,
  skillId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = await findBySkillId(skillId);
  if (!existing) return { ok: false, status: 404, error: '技能不存在' };
  if (existing.createdBy !== username) return { ok: false, status: 403, error: '只能撤回自己的分享申请' };
  if (existing.status !== 'PENDING_SHARE') return { ok: false, status: 400, error: '该技能不在分享审核中' };
  await getPool().query("UPDATE skill_library SET status = 'ACTIVE' WHERE skill_id = ?", [skillId]);
  return { ok: true };
}

/** 管理员批准分享：复制一份进入系统库（重名自动加后缀），原个人技能恢复 ACTIVE */
export async function approveShare(
  skillId: string
): Promise<{ ok: true; skill: SkillRecord } | { ok: false; status: number; error: string }> {
  const existing = await findBySkillId(skillId);
  if (!existing) return { ok: false, status: 404, error: '技能不存在' };
  if (existing.scope !== 'USER' || existing.status !== 'PENDING_SHARE') {
    return { ok: false, status: 400, error: '该技能不在分享审核中' };
  }
  // 系统库重名检查：同名则追加「（分享）」后缀，避免覆盖管理员既有维护条目
  const pool = getPool();
  const [dupRows] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT COUNT(*) AS cnt FROM skill_library WHERE scope = 'SYSTEM' AND name = ?",
    [existing.name]
  );
  const name = Number(dupRows[0]?.cnt) > 0 ? `${existing.name}（分享）` : existing.name;
  const sysId = newSkillId();
  await pool.query(
    `INSERT INTO skill_library (skill_id, name, description, prompt_template, placeholders, scope, status, created_by)
     VALUES (?, ?, ?, ?, ?, 'SYSTEM', 'ACTIVE', ?)`,
    [sysId, name, existing.description, existing.promptTemplate, JSON.stringify(existing.placeholders), existing.createdBy]
  );
  await pool.query("UPDATE skill_library SET status = 'ACTIVE' WHERE skill_id = ?", [skillId]);
  return { ok: true, skill: (await findBySkillId(sysId))! };
}

/** 管理员拒绝分享：退回私有 */
export async function rejectShare(
  skillId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const existing = await findBySkillId(skillId);
  if (!existing) return { ok: false, status: 404, error: '技能不存在' };
  if (existing.scope !== 'USER' || existing.status !== 'PENDING_SHARE') {
    return { ok: false, status: 400, error: '该技能不在分享审核中' };
  }
  await getPool().query("UPDATE skill_library SET status = 'ACTIVE' WHERE skill_id = ?", [skillId]);
  return { ok: true };
}
