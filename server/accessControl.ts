/**
 * P2-11 数据源访问控制（ACL）模块：组织/部门维度授权。
 *
 * 模型：data_sources.acl_json = { departments: string[], userIds: number[] }
 * - NULL 或两组皆空 → 不限制（全员可见，保持存量行为）
 * - 非空 → 仅 ADMIN / 清单内部门成员 / 清单内个人用户可访问
 * 与 DataScope（表/列/行级圈定）正交：ACL 决定「能否看到/使用该数据源」，scope 决定「可用哪些表列」。
 */
import type { AuthUser } from './auth';
import { getPool } from './db';

export interface DataSourceAcl {
  departments: string[];
  userIds: number[];
}

/** 解析 acl_json 原始值（string/object/null 均可）；两组皆空时归一为 null（=不限制） */
export function parseAcl(raw: unknown): DataSourceAcl | null {
  if (raw === null || raw === undefined) return null;
  let obj: any = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return null;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const departments: string[] = Array.isArray(obj.departments)
    ? obj.departments
        .filter((d: unknown): d is string => typeof d === 'string' && d.trim().length > 0)
        .map((d: string) => d.trim())
    : [];
  const userIds: number[] = Array.isArray(obj.userIds)
    ? obj.userIds.map((n: unknown) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0)
    : [];
  if (departments.length === 0 && userIds.length === 0) return null;
  return { departments, userIds };
}

/** 纯函数判定：用户是否可访问某 ACL 的数据源 */
export function canAccessDataSource(
  user: Pick<AuthUser, 'id' | 'role' | 'department'> | null | undefined,
  acl: DataSourceAcl | null
): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (!acl) return true; // 未配置 = 不限制
  if (acl.userIds.includes(user.id)) return true;
  const dept = String(user.department || '').trim();
  if (dept && acl.departments.includes(dept)) return true;
  return false;
}

/** 加载指定数据源的 ACL（数据源不存在时返回 null，由调用方按既有"不存在"链路处理） */
export async function loadDataSourceAcl(dataSourceId: string): Promise<DataSourceAcl | null> {
  const [rows] = await getPool().query('SELECT acl_json FROM data_sources WHERE id = ? LIMIT 1', [dataSourceId]);
  const row = (rows as any[])[0];
  if (!row) return null;
  return parseAcl(row.acl_json);
}

/** 服务端访问校验入口：问数/执行/报表等链路在鉴权后调用 */
export async function checkDataSourceAccess(
  user: Pick<AuthUser, 'id' | 'role' | 'department'>,
  dataSourceId: string
): Promise<boolean> {
  if (user.role === 'ADMIN') return true;
  const acl = await loadDataSourceAcl(dataSourceId);
  return canAccessDataSource(user, acl);
}

/**
 * 审批通过时并入个人授权：将 userId 加入 acl_json.userIds（保留既有部门清单）。
 * 注意：审批是低频管理操作，先读后写无事务保护可接受；重复并入幂等。
 */
export async function grantUserAccess(dataSourceId: string, userId: number): Promise<void> {
  const [rows] = await getPool().query('SELECT acl_json FROM data_sources WHERE id = ? LIMIT 1', [dataSourceId]);
  const row = (rows as any[])[0];
  if (!row) throw new Error('数据源不存在');
  const acl = parseAcl(row.acl_json) || { departments: [], userIds: [] };
  if (!acl.userIds.includes(userId)) acl.userIds.push(userId);
  await getPool().query('UPDATE data_sources SET acl_json = ? WHERE id = ?', [JSON.stringify(acl), dataSourceId]);
}

/** PUT /:id/acl 入参清洗：白名单结构 + 长度上限；返回可入库的规范结构（空 → null 解除限制） */
export function sanitizeAcl(body: unknown): DataSourceAcl | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const departments: string[] = Array.isArray(raw.departments)
    ? Array.from(
        new Set(
          raw.departments
            .filter((d): d is string => typeof d === 'string')
            .map((d) => d.trim().slice(0, 100))
            .filter((d) => d.length > 0)
        )
      ).slice(0, 50)
    : [];
  const userIds: number[] = Array.isArray(raw.userIds)
    ? Array.from(new Set(raw.userIds.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))).slice(0, 200)
    : [];
  if (departments.length === 0 && userIds.length === 0) return null;
  return { departments, userIds };
}
