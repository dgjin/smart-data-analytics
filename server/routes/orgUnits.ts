/**
 * 组织架构树路由（仅 ADMIN）：总部→机构→部门→团队 四级单表自关联。
 *
 * - 层级强校验：机构挂总部、部门挂机构、团队挂部门（团队为末级，其下不可新增）
 * - 删除保护：总部不可删；存在下级或仍有用户归属时拒绝
 * - 改名同步：节点名即用户 `department` 文本，而该文本是数据源可见性 ACL 的匹配键，
 *   改名不同步会导致被授权用户被静默拒之门外，故一并改写 users.department 与 data_sources.acl_json
 * - 数据标识：节点在业务数据中的取值（机构编号如 AH、团队名如「投资一部」）。
 *   新增缺省按层级路径自动编号（机构 BR01 / 部门 BR01-D01 / 团队 BR01-D01-T01），
 *   POST /auto-code 为存量空节点一键补全（总部无数据标识）
 */
import { Router } from 'express';
import type { RowDataPacket, ResultSetHeader } from 'mysql2';
import { authMiddleware, requireRole } from '../auth/auth';
import { getPool } from '../infra/db';
import { logger } from '../infra/logger';
import { writeAudit } from '../infra/auditLog';
import { getErrorMessage, getErrorCode } from '../infra/errorUtils';
import { parseAcl } from '../auth/accessControl';

const router = Router();
router.use(authMiddleware, requireRole('ADMIN'));

const LEVELS = ['HQ', 'BRANCH', 'DEPT', 'TEAM'] as const;
type OrgLevel = (typeof LEVELS)[number];
const LEVEL_LABELS: Record<OrgLevel, string> = { HQ: '总部', BRANCH: '机构', DEPT: '部门', TEAM: '团队' };
/** 各层级允许的下级（团队为末级） */
const CHILD_LEVEL: Record<OrgLevel, OrgLevel | null> = { HQ: 'BRANCH', BRANCH: 'DEPT', DEPT: 'TEAM', TEAM: null };
const STEP = 10;
const NAME_MAX = 100;
const DATA_CODE_MAX = 100;
/** 可参与自动编码的层级（总部不参与） */
const FILL_LEVELS: ReadonlyArray<Exclude<OrgLevel, 'HQ'>> = ['BRANCH', 'DEPT', 'TEAM'];
const DATA_CODE_SEQ_PAD = 2;
const CODE_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

interface OrgRow extends RowDataPacket {
  id: number;
  parent_id: number | null;
  level: OrgLevel;
  name: string;
  data_code: string;
  sort_order: number;
}

/**
 * 层级路径编号：机构 BR01；部门 {机构编码}-D01；团队 {部门编码}-T01。
 * 序号 = 现有编码中同前缀最大值 + 1（两位补零，超过 99 自然进位三位）；父编码缺失时退化为 D01 / T01。
 * 与前端 src/utils/orgDataCode.ts 的 buildOrgDataCode 保持同规则（弹窗预填用）。
 */
export function buildDataCode(level: Exclude<OrgLevel, 'HQ'>, parentCode: string, existingCodes: Iterable<string>): string {
  const local = level === 'BRANCH' ? 'BR' : level === 'DEPT' ? 'D' : 'T';
  const prefix = level === 'BRANCH' || !parentCode ? local : `${parentCode}-${local}`;
  const pattern = new RegExp(`^${prefix.replace(CODE_ESCAPE_RE, '\\$&')}(\\d+)$`);
  let max = 0;
  for (const code of existingCodes) {
    const matched = pattern.exec(String(code || '').trim());
    if (matched) max = Math.max(max, Number(matched[1]));
  }
  return `${prefix}${String(max + 1).padStart(DATA_CODE_SEQ_PAD, '0')}`;
}

/** 全库已用数据标识（自动编码去重用；组织节点数量级小，整表取列） */
async function loadAllDataCodes(): Promise<string[]> {
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT data_code FROM org_units');
  return rows.map((row) => String(row.data_code || '').trim()).filter(Boolean);
}

async function loadNode(id: number): Promise<OrgRow | null> {
  const [rows] = await getPool().query<OrgRow[]>(
    'SELECT id, parent_id, level, name, data_code, sort_order FROM org_units WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] ?? null;
}

/** 同级同名判定（parent_id 用 <=> 兼容总部 NULL 父节点；excludeId 供改名时排除自身） */
async function siblingNameTaken(parentId: number | null, name: string, excludeId?: number): Promise<boolean> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    `SELECT id FROM org_units WHERE parent_id <=> ? AND name = ?${excludeId ? ' AND id != ?' : ''} LIMIT 1`,
    excludeId ? [parentId, name, excludeId] : [parentId, name]
  );
  return rows.length > 0;
}

async function countChildren(id: number): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM org_units WHERE parent_id = ?', [id]);
  return Number(rows[0]?.cnt || 0);
}

async function countBoundUsers(id: number): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM users WHERE org_unit_id = ?', [id]);
  return Number(rows[0]?.cnt || 0);
}

/** 数据源 ACL 部门清单中的旧节点名就地替换为新名（逐条读写；数据源数量级小，先 LIKE 粗筛再精确校验） */
async function renameInDataSourceAcls(oldName: string, newName: string): Promise<number> {
  const [rows] = await getPool().query<RowDataPacket[]>(
    'SELECT id, acl_json FROM data_sources WHERE acl_json IS NOT NULL AND acl_json LIKE ?',
    [`%${oldName}%`]
  );
  let changed = 0;
  for (const row of rows) {
    const acl = parseAcl(row.acl_json);
    if (!acl || !acl.departments.includes(oldName)) continue;
    acl.departments = acl.departments.map((d) => (d === oldName ? newName : d));
    await getPool().query('UPDATE data_sources SET acl_json = ? WHERE id = ?', [JSON.stringify(acl), row.id]);
    changed++;
  }
  return changed;
}

/** 写操作统一审计（fail-open，不阻塞主流程） */
function audit(req: { user?: { id: number; username: string } }, detail: string): void {
  writeAudit({
    userId: req.user!.id,
    username: req.user!.username,
    endpoint: 'admin',
    status: 'SUCCESS',
    detail,
  });
}

// GET /api/admin/org-units —— 扁平节点列表（前端组树；含绑定用户数与下级数，供删除保护提示）
router.get('/', async (_req, res) => {
  try {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT u.id, u.parent_id AS parentId, u.level, u.name, u.data_code AS dataCode, u.sort_order AS sortOrder,
              (SELECT COUNT(*) FROM users x WHERE x.org_unit_id = u.id) AS userCount,
              (SELECT COUNT(*) FROM org_units c WHERE c.parent_id = u.id) AS childCount
       FROM org_units u ORDER BY u.sort_order ASC, u.id ASC`
    );
    const units = rows.map((row) => ({
      id: Number(row.id),
      parentId: row.parentId === null ? null : Number(row.parentId),
      level: row.level as OrgLevel,
      name: String(row.name),
      dataCode: String(row.dataCode || ''),
      sortOrder: Number(row.sortOrder || 0),
      userCount: Number(row.userCount || 0),
      childCount: Number(row.childCount || 0),
    }));
    return res.json({ success: true, units });
  } catch (err) {
    logger.error('[OrgUnits] list failed:', getErrorMessage(err));
    return res.status(500).json({ error: '组织架构加载失败' });
  }
});

// POST /api/admin/org-units { parentId, level, name, dataCode? }
router.post('/', async (req, res) => {
  const body = req.body || {};
  const { parentId } = body;
  const level = String(body.level || '').toUpperCase() as OrgLevel;
  if (!LEVELS.includes(level)) {
    return res.status(400).json({ error: '节点类型无效，可选：BRANCH（机构）/ DEPT（部门）/ TEAM（团队）' });
  }
  if (level === 'HQ') {
    return res.status(400).json({ error: '总部为系统内置唯一根节点，不可新增' });
  }
  if (!Number.isInteger(parentId)) {
    return res.status(400).json({ error: '请指定上级节点' });
  }
  const trimmedName = String(body.name ?? '').trim();
  if (!trimmedName || trimmedName.length > NAME_MAX) {
    return res.status(400).json({ error: `节点名称需为 1-${NAME_MAX} 个字符` });
  }
  let dataCode = String(body.dataCode ?? '').trim();
  if (dataCode.length > DATA_CODE_MAX) {
    return res.status(400).json({ error: `数据标识不能超过 ${DATA_CODE_MAX} 个字符` });
  }

  try {
    const parent = await loadNode(parentId);
    if (!parent) {
      return res.status(400).json({ error: '上级节点不存在' });
    }
    const allowed = CHILD_LEVEL[parent.level];
    if (allowed !== level) {
      return res.status(400).json({
        error: `「${parent.name}」是${LEVEL_LABELS[parent.level]}，其下级只能是${allowed ? LEVEL_LABELS[allowed] : '（无，团队为末级）'}`,
      });
    }
    if (await siblingNameTaken(parentId, trimmedName)) {
      return res.status(409).json({ error: '同级下已存在同名节点' });
    }
    // 数据标识缺省 = 服务端按层级路径自动编码（前端已预填，此处兜底 API 直调）
    let autoCoded = false;
    if (!dataCode) {
      dataCode = buildDataCode(level, String(parent.data_code || '').trim(), await loadAllDataCodes());
      autoCoded = true;
    }
    const [maxRows] = await getPool().query<RowDataPacket[]>(
      'SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM org_units WHERE parent_id <=> ?',
      [parentId]
    );
    const sortOrder = Number(maxRows[0]?.maxOrder || 0) + STEP;
    const [result] = await getPool().query<ResultSetHeader>(
      'INSERT INTO org_units (parent_id, level, name, data_code, sort_order, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [parentId, level, trimmedName, dataCode, sortOrder, req.user!.username]
    );
    audit(req, `新增组织节点 ${LEVEL_LABELS[level]}「${trimmedName}」（上级：${parent.name}${autoCoded ? `；数据标识 ${dataCode} 自动生成` : ''}）`);
    return res.status(201).json({
      success: true,
      unit: { id: result.insertId, parentId, level, name: trimmedName, dataCode, sortOrder, userCount: 0, childCount: 0 },
    });
  } catch (err) {
    if (getErrorCode(err) === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '同级下已存在同名节点' });
    }
    logger.error('[OrgUnits] create failed:', getErrorMessage(err));
    return res.status(500).json({ error: '组织节点创建失败' });
  }
});

// POST /api/admin/org-units/auto-code —— 为未配置数据标识的节点按层级路径批量生成（总部除外）
router.post('/auto-code', async (req, res) => {
  try {
    const [rows] = await getPool().query<OrgRow[]>('SELECT id, parent_id, level, name, data_code FROM org_units');
    const codeOf = new Map<number, string>();
    for (const row of rows) {
      const code = String(row.data_code || '').trim();
      if (code) codeOf.set(Number(row.id), code);
    }
    const filled: Array<{ id: number; name: string; dataCode: string }> = [];
    // 自上而下逐层生成，子节点取父级已生成（或已有）的编码作为前缀
    for (const level of FILL_LEVELS) {
      for (const row of rows) {
        if (row.level !== level) continue;
        const id = Number(row.id);
        if (codeOf.has(id)) continue;
        const parentCode = row.parent_id === null ? '' : codeOf.get(Number(row.parent_id)) || '';
        const code = buildDataCode(level, parentCode, codeOf.values());
        await getPool().query('UPDATE org_units SET data_code = ? WHERE id = ?', [code, id]);
        codeOf.set(id, code);
        filled.push({ id, name: String(row.name), dataCode: code });
      }
    }
    if (filled.length > 0) {
      audit(req, `一键补全组织节点数据标识（${filled.length} 个）`);
    }
    return res.json({ success: true, filled: filled.length, codes: filled });
  } catch (err) {
    logger.error('[OrgUnits] auto-code failed:', getErrorMessage(err));
    return res.status(500).json({ error: '数据标识自动编码失败' });
  }
});

// PUT /api/admin/org-units/:id { name?, dataCode? } —— 改名同步用户部门文本与数据源 ACL 部门清单
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: '组织节点 ID 无效' });
  }
  const { name, dataCode } = req.body || {};
  try {
    const node = await loadNode(id);
    if (!node) {
      return res.status(404).json({ error: '组织节点不存在' });
    }

    const updates: string[] = [];
    const params: unknown[] = [];
    let renamedTo: string | null = null;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed || trimmed.length > NAME_MAX) {
        return res.status(400).json({ error: `节点名称需为 1-${NAME_MAX} 个字符` });
      }
      if (trimmed !== node.name) {
        if (await siblingNameTaken(node.parent_id, trimmed, id)) {
          return res.status(409).json({ error: '同级下已存在同名节点' });
        }
        updates.push('name = ?');
        params.push(trimmed);
        renamedTo = trimmed;
      }
    }
    if (dataCode !== undefined) {
      const code = String(dataCode ?? '').trim();
      if (code.length > DATA_CODE_MAX) {
        return res.status(400).json({ error: `数据标识不能超过 ${DATA_CODE_MAX} 个字符` });
      }
      updates.push('data_code = ?');
      params.push(code);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    await getPool().query(`UPDATE org_units SET ${updates.join(', ')} WHERE id = ?`, [...params, id]);

    let syncedUsers = 0;
    let syncedDataSources = 0;
    if (renamedTo) {
      const [uRes] = await getPool().query<ResultSetHeader>('UPDATE users SET department = ? WHERE org_unit_id = ?', [renamedTo, id]);
      syncedUsers = uRes.affectedRows;
      syncedDataSources = await renameInDataSourceAcls(node.name, renamedTo);
    }

    audit(
      req,
      `更新组织节点「${node.name}」${renamedTo ? `→「${renamedTo}」（同步用户 ${syncedUsers} 个、数据源授权 ${syncedDataSources} 个）` : ''}${dataCode !== undefined ? ` 数据标识=${String(dataCode ?? '').trim() || '（空）'}` : ''}`
    );
    return res.json({ success: true, syncedUsers, syncedDataSources });
  } catch (err) {
    if (getErrorCode(err) === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: '同级下已存在同名节点' });
    }
    logger.error('[OrgUnits] update failed:', getErrorMessage(err));
    return res.status(500).json({ error: '组织节点更新失败' });
  }
});

// POST /api/admin/org-units/:id/move { direction: 'up' | 'down' } —— 同级上移/下移
router.post('/:id/move', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: '组织节点 ID 无效' });
  }
  const direction = String((req.body || {}).direction || '');
  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction 只能是 up 或 down' });
  }
  try {
    const node = await loadNode(id);
    if (!node) {
      return res.status(404).json({ error: '组织节点不存在' });
    }
    if (node.level === 'HQ') {
      return res.status(400).json({ error: '总部为根节点，无法调整顺序' });
    }
    const [siblings] = await getPool().query<OrgRow[]>(
      'SELECT id, parent_id, level, name, data_code, sort_order FROM org_units WHERE parent_id <=> ? ORDER BY sort_order ASC, id ASC',
      [node.parent_id]
    );
    const index = siblings.findIndex((s) => s.id === id);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= siblings.length) {
      return res.status(400).json({ error: direction === 'up' ? '已是同级首位' : '已是同级末位' });
    }
    // 交换后按位重排（步长 10），顺带修复历史遗留的重复 sort_order
    const reordered = [...siblings];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    for (let i = 0; i < reordered.length; i += 1) {
      const next = (i + 1) * STEP;
      if (reordered[i].sort_order !== next) {
        await getPool().query('UPDATE org_units SET sort_order = ? WHERE id = ?', [next, reordered[i].id]);
      }
    }
    audit(req, `调整组织节点「${node.name}」顺序（${direction === 'up' ? '上移' : '下移'}）`);
    return res.json({ success: true, order: reordered.map((s) => s.id) });
  } catch (err) {
    logger.error('[OrgUnits] move failed:', getErrorMessage(err));
    return res.status(500).json({ error: '组织节点排序失败' });
  }
});

// DELETE /api/admin/org-units/:id —— 总部不可删；有下级或仍有用户归属时拒绝
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: '组织节点 ID 无效' });
  }
  try {
    const node = await loadNode(id);
    if (!node) {
      return res.status(404).json({ error: '组织节点不存在' });
    }
    if (node.level === 'HQ') {
      return res.status(400).json({ error: '总部为根节点，不可删除' });
    }
    const children = await countChildren(id);
    if (children > 0) {
      return res.status(409).json({ error: `请先删除其下级节点（${children} 个）` });
    }
    const bound = await countBoundUsers(id);
    if (bound > 0) {
      return res.status(409).json({ error: `有 ${bound} 个用户归属该节点，请先调整其组织归属` });
    }
    await getPool().query('DELETE FROM org_units WHERE id = ?', [id]);
    audit(req, `删除组织节点 ${LEVEL_LABELS[node.level]}「${node.name}」`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('[OrgUnits] delete failed:', getErrorMessage(err));
    return res.status(500).json({ error: '组织节点删除失败' });
  }
});

export default router;
