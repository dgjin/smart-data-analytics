/**
 * 问数上下文摘要路由：单一事实源。
 * 前端「智能问数」页展示的表范围与实际问数链路共用 loadSchemaContext
 * （落库 schema → scope 白名单 → 敏感列过滤），消除"显示的表范围与实际参与问数不一致"。
 * 权限对齐：表名清单仅 ADMIN 可见（与 GET /api/datasources 剥离 tables 的约定一致）。
 */
import { Router } from 'express';
import { authMiddleware, requireRole } from '../auth';
import { loadSchemaContext } from '../schemaContext';
import { checkDataSourceAccess } from '../accessControl';
import { MAX_TABLES_IN_PROMPT } from '../schemaLinking';

const router = Router();
router.use(authMiddleware);

/** 由服务端 Schema 上下文构造前端展示摘要；表级明细仅管理员可见（纯函数，便于单测） */
export function buildContextSummary(
  ctx: { schema: any[]; sensitiveRemoved: string[]; status: string | null; dsType: string | null },
  isAdmin: boolean
) {
  return {
    ok: true,
    status: ctx.status,
    dsType: ctx.dsType,
    tableCount: Array.isArray(ctx.schema) ? ctx.schema.length : 0,
    // 表级明细仅管理员可见；非管理员只暴露数量
    tables: isAdmin
      ? (Array.isArray(ctx.schema) ? ctx.schema : []).map((t: any) => ({
          name: String(t?.name || ''),
          displayName: String(t?.displayName || t?.name || ''),
        }))
      : [],
    sensitiveFiltered: ctx.sensitiveRemoved.length,
    maxTablesInPrompt: MAX_TABLES_IN_PROMPT,
  };
}

// GET /api/query/context?dataSourceId=xxx（挂载于 /api/query 前缀下）
router.get('/context', requireRole('ADMIN', 'ANALYST'), async (req, res) => {
  const dataSourceId = String(req.query.dataSourceId || '');
  if (!dataSourceId) return res.status(400).json({ error: 'dataSourceId 必填' });
  try {
    // P2-11 数据源访问控制：无权限不暴露任何上下文信息
    if (!(await checkDataSourceAccess(req.user!, dataSourceId))) {
      return res.status(403).json({ code: 'DS_ACCESS_DENIED', error: '没有该数据源的访问权限，可向管理员申请开通' });
    }
    // 不传前端 schema：完全以服务端落库上下文为准（与问数执行链路同源）
    const ctx = await loadSchemaContext(dataSourceId, []);
    return res.json(buildContextSummary(ctx, req.user?.role === 'ADMIN'));
  } catch (err) {
    console.error('[QueryContext] failed:', err);
    return res.status(500).json({ error: '问数上下文获取失败' });
  }
});

export default router;
