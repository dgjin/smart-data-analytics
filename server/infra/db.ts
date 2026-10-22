/**
 * MySQL 持久化层 - 连接与初始化编排（质量优化 Stage 3.1 四拆分）：
 * 本文件仅保留连接池（getPool/closePool/appPoolMax）与 initSchema 编排；
 * 结构定义见 schema.ts、初始种子见 seed.ts、存量迁移见 migration.ts。
 * 用户账号与数据源配置均落地 MySQL，服务启动时自动完成初始化。
 */
import mysql from 'mysql2/promise';
import { createSchema } from './schema';
import { seedInitialData } from './seed';
import { migrateSchema, migrateData } from './migration';
import { logger } from './logger';
import { getErrorMessage } from './errorUtils';

// 注意：ESM import 提升会使模块级 process.env 读取早于 dotenv.config()，
// 因此所有环境变量必须在使用时惰性读取。
function mysqlBase() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
  };
}
const dbName = () => process.env.MYSQL_DATABASE || 'smart_analytics';

/**
 * P1-9 应用库连接池容量公式化（原硬编码 connectionLimit=10）。
 * 应用库承载鉴权/审计/缓存/知识库等随请求发生的短查询（每问数次，毫秒级），
 * 容量 ≈ 并发用户数 / 2。APP_POOL_MAX 显式配置优先；否则按 EXPECTED_CONCURRENT_USERS
 * 推导，clamp 到 [10, 50]（下限不逊于原水位）。
 */
export function appPoolMax(): number {
  const raw = process.env.APP_POOL_MAX;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.min(200, Math.floor(n));
  }
  const users = Number(process.env.EXPECTED_CONCURRENT_USERS) || 20;
  return Math.min(50, Math.max(10, Math.ceil(users / 2)));
}

let pool: mysql.Pool;
let poolClosed = false;

export function getPool(): mysql.Pool {
  if (!pool) throw new Error('Database pool not initialized. Call initSchema() first.');
  return pool;
}

/** 事务内连接（与 Pool 的 query 签名一致，可直接替换使用） */
export type TxConn = mysql.PoolConnection;

/**
 * 事务中止信号：携带业务返回值，withTransaction 捕获后回滚并把该值原样返回。
 * 用途——多表写在中途发现业务失败（如目标行已被并发删除）时，
 * 需要撤销此前已执行的写操作并返回 { ok: false }，而非抛出 500。
 */
class TxAbort {
  constructor(readonly value: unknown) {}
}

/** 在事务内标记回滚并返回业务结果（类型与 withTransaction 的返回值保持一致） */
export function abortTransaction<T>(value: T): never {
  throw new TxAbort(value);
}

/**
 * v0.9.114 P1-1 通用事务封装（多表写的原子性保障）。
 *
 * 语义：回调正常返回 → COMMIT；回调抛错 → ROLLBACK 后继续抛（交由路由映射 500）；
 * 回调调用 abortTransaction(值) → ROLLBACK 并返回该值（业务失败路径，如并发删除）。
 * 连接必定 release；rollback 自身失败只记日志，不掩盖原始错误。
 *
 * 注意：回调内必须使用传入的 conn 执行所有 SQL，用 getPool() 会绕过事务。
 */
export async function withTransaction<T>(fn: (conn: TxConn) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (rbErr) {
      logger.warn('[DB] 事务回滚失败（忽略，保留原始错误）：', getErrorMessage(rbErr));
    }
    if (err instanceof TxAbort) return err.value as T;
    throw err;
  } finally {
    conn.release();
  }
}

/** P1-2 优雅停机：关闭连接池（幂等；未初始化时静默返回，供 shutdown 的 closeResources 步骤调用） */
export async function closePool(): Promise<void> {
  if (!pool || poolClosed) return;
  poolClosed = true;
  try {
    await pool.end();
  } catch (err) {
    logger.warn('[DB] 连接池关闭异常（忽略）：', getErrorMessage(err));
  }
}

/**
 * 初始化（对外签名与调用方 server.ts / eval/runEval.ts 保持不变）：
 * 建库建池（本文件）→ 结构定义（schema.ts）→ 存量结构迁移（migration.ts）
 * → 初始种子（seed.ts）→ 数据迁移（migration.ts）。
 * 顺序约束：结构迁移先于种子（存量库须先补齐种子 INSERT 依赖的列）；
 * 数据迁移后于种子（种子新插入的行同样要过回填/加密等迁移）。
 */
export async function initSchema(): Promise<void> {
  const base = mysqlBase();
  const database = dbName();

  // 1. Ensure database exists (connect without database selected)
  const conn = await mysql.createConnection(base);
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();

  // 2. Create pool bound to the database
  pool = mysql.createPool({
    ...base,
    database,
    waitForConnections: true,
    connectionLimit: appPoolMax(),
    charset: 'utf8mb4',
  });
  poolClosed = false;

  // 3. 结构定义：全部建表与幂等 MODIFY DDL（schema.ts）
  await createSchema(pool);

  // 4. 存量结构迁移：幂等 ADD COLUMN；先于种子，补齐种子 INSERT 依赖的列（migration.ts）
  await migrateSchema(pool);

  // 5. 初始种子：默认管理员/内置技能/预设模板/出厂看板/示例数据源/env 键位（seed.ts）
  await seedInitialData(pool);

  // 6. 数据迁移：历史点赞样例回填、明文凭据就地加密（migration.ts）
  await migrateData(pool);

  logger.info(`[DB] MySQL ready: ${base.host}:${base.port}/${database}`);
}
