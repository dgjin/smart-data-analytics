/**
 * v0.5.0 报告模板管理路由（挂载于 /api/report-templates 前缀下）：
 * - GET    /           获取模板列表（所有登录用户）
 * - POST   /           新增模板（仅 ADMIN）
 * - PUT    /:id        编辑模板（仅 ADMIN，预设模板不可编辑）
 * - DELETE /:id        删除模板（仅 ADMIN，预设模板不可删除）
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { getPool } from '../db';
import { writeAudit } from '../auditLog';
import { ERROR_CODES } from '../errorCodes';

const router = Router();

// 模板记录类型
export interface ReportTemplateRow {
  id: number;
  name: string;
  description: string;
  template_content: string;
  is_preset: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

// 转换为前端格式
export function toTemplateRecord(row: ReportTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    templateContent: row.template_content,
    isPreset: row.is_preset === 1,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// 校验模板内容：必须是合法 JSON 且含 sections 数组（每个章节需有 title 与 prompt）
export function validateTemplateContent(content: string): { ok: true } | { ok: false; reason: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, reason: '模板内容必须是合法的 JSON 格式' };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.sections)) {
    return { ok: false, reason: '模板内容必须包含 sections 数组' };
  }
  if (parsed.sections.length === 0) {
    return { ok: false, reason: '模板至少需要一个章节' };
  }
  for (const s of parsed.sections) {
    if (!s || typeof s.title !== 'string' || s.title.trim().length === 0) {
      return { ok: false, reason: '每个章节必须包含标题 title' };
    }
    if (typeof s.prompt !== 'string' || s.prompt.trim().length === 0) {
      return { ok: false, reason: '每个章节必须包含提示词 prompt' };
    }
  }
  return { ok: true };
}

// GET /api/report-templates - 获取模板列表（所有登录用户）
router.get('/', authMiddleware, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM report_templates ORDER BY is_preset DESC, id ASC'
    );
    const templates = (rows as ReportTemplateRow[]).map(toTemplateRecord);
    res.json({ ok: true, templates });
  } catch (err: any) {
    console.error('GET /api/report-templates error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '获取模板列表失败' });
  }
});

// POST /api/report-templates - 新增模板（仅 ADMIN）
router.post('/', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const user = req.user!;
  const { name, description, templateContent } = req.body;

  // 输入校验
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '模板名称不能为空' });
  }
  if (!templateContent || typeof templateContent !== 'string') {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '模板内容不能为空' });
  }

  // 校验模板内容结构
  const contentCheck = validateTemplateContent(templateContent);
  if (contentCheck.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: contentCheck.reason });
  }

  try {
    const pool = getPool();
    // 检查名称唯一性
    const [existing] = await pool.query('SELECT id FROM report_templates WHERE name = ?', [name.trim()]);
    if ((existing as any[]).length > 0) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '模板名称已存在' });
    }

    const [result] = await pool.query(
      'INSERT INTO report_templates (name, description, template_content, is_preset, created_by) VALUES (?, ?, ?, 0, ?)',
      [name.trim(), String(description || '').trim(), templateContent, user.username]
    );
    const insertId = (result as any).insertId;

    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'report_template',
      status: 'SUCCESS',
      detail: `新增报告模板：${name.trim()}`,
    });

    const [rows] = await pool.query('SELECT * FROM report_templates WHERE id = ?', [insertId]);
    const template = toTemplateRecord((rows as ReportTemplateRow[])[0]);
    res.json({ ok: true, template });
  } catch (err: any) {
    console.error('POST /api/report-templates error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '新增模板失败' });
  }
});

// PUT /api/report-templates/:id - 编辑模板（仅 ADMIN，预设模板不可编辑）
router.put('/:id', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id, 10);
  const { name, description, templateContent } = req.body;

  if (isNaN(id)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '无效的模板 ID' });
  }

  // 输入校验
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '模板名称不能为空' });
  }
  if (!templateContent || typeof templateContent !== 'string') {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '模板内容不能为空' });
  }

  // 校验模板内容结构
  const contentCheck = validateTemplateContent(templateContent);
  if (contentCheck.ok === false) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: contentCheck.reason });
  }

  try {
    const pool = getPool();
    // 检查模板是否存在
    const [existing] = await pool.query('SELECT * FROM report_templates WHERE id = ?', [id]);
    const template = (existing as ReportTemplateRow[])[0];
    if (!template) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '模板不存在' });
    }

    // 预设模板不可编辑
    if (template.is_preset === 1) {
      writeAudit({
        userId: user.id,
        username: user.username,
        endpoint: 'report_template',
        status: 'DENIED_AUTH',
        detail: `尝试编辑预设模板：${template.name}`,
      });
      return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '预设模板不可编辑' });
    }

    // 检查名称唯一性（排除自身）
    const [duplicates] = await pool.query('SELECT id FROM report_templates WHERE name = ? AND id != ?', [name.trim(), id]);
    if ((duplicates as any[]).length > 0) {
      return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '模板名称已存在' });
    }

    await pool.query(
      'UPDATE report_templates SET name = ?, description = ?, template_content = ? WHERE id = ?',
      [name.trim(), String(description || '').trim(), templateContent, id]
    );

    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'report_template',
      status: 'SUCCESS',
      detail: `编辑报告模板：${name.trim()}`,
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error('PUT /api/report-templates/:id error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '编辑模板失败' });
  }
});

// DELETE /api/report-templates/:id - 删除模板（仅 ADMIN，预设模板不可删除）
router.delete('/:id', authMiddleware, requireRole('ADMIN'), async (req, res) => {
  const user = req.user!;
  const id = parseInt(req.params.id, 10);

  if (isNaN(id)) {
    return res.status(400).json({ code: ERROR_CODES.INVALID_INPUT, error: '无效的模板 ID' });
  }

  try {
    const pool = getPool();
    // 检查模板是否存在
    const [existing] = await pool.query('SELECT * FROM report_templates WHERE id = ?', [id]);
    const template = (existing as ReportTemplateRow[])[0];
    if (!template) {
      return res.status(404).json({ code: ERROR_CODES.NOT_FOUND, error: '模板不存在' });
    }

    // 预设模板不可删除
    if (template.is_preset === 1) {
      writeAudit({
        userId: user.id,
        username: user.username,
        endpoint: 'report_template',
        status: 'DENIED_AUTH',
        detail: `尝试删除预设模板：${template.name}`,
      });
      return res.status(403).json({ code: ERROR_CODES.FORBIDDEN, error: '预设模板不可删除' });
    }

    await pool.query('DELETE FROM report_templates WHERE id = ?', [id]);

    writeAudit({
      userId: user.id,
      username: user.username,
      endpoint: 'report_template',
      status: 'SUCCESS',
      detail: `删除报告模板：${template.name}`,
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error('DELETE /api/report-templates/:id error:', err);
    res.status(500).json({ code: ERROR_CODES.INTERNAL_ERROR, error: '删除模板失败' });
  }
});

export default router;
