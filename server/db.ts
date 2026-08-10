/**
 * MySQL 持久化层：连接池、建库建表、初始种子。
 * 用户账号与数据源配置均落地 MySQL，服务启动时自动完成初始化。
 */
import mysql from 'mysql2/promise';
import { INITIAL_DATA_SOURCES } from '../src/data/sampleDatasets';
import { hashPassword } from './passwords';

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

const defaultAdminUsername = () => process.env.ADMIN_USERNAME || 'admin';
const defaultAdminPassword = () => process.env.ADMIN_PASSWORD || 'admin123';

let pool: mysql.Pool;

export function getPool(): mysql.Pool {
  if (!pool) throw new Error('Database pool not initialized. Call initSchema() first.');
  return pool;
}

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
    connectionLimit: 10,
    charset: 'utf8mb4',
  });

  // 3. Tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name VARCHAR(50) NOT NULL DEFAULT '',
      role ENUM('ADMIN','ANALYST','VIEWER') NOT NULL DEFAULT 'VIEWER',
      status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS data_sources (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(128) NOT NULL,
      type VARCHAR(20) NOT NULL,
      config_json TEXT,
      schema_json MEDIUMTEXT,
      scope_json TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'connected',
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 存量库迁移：补充 scope_json 列（问数范围配置；NULL = 不限制）
  try {
    await pool.query('ALTER TABLE data_sources ADD COLUMN scope_json TEXT NULL AFTER schema_json');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // L6 审计层：智能问数全链路审计（含被拒绝的请求）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS query_audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      username VARCHAR(50) NOT NULL DEFAULT '',
      endpoint VARCHAR(32) NOT NULL DEFAULT 'query',
      data_source_id VARCHAR(64) NOT NULL DEFAULT '',
      question VARCHAR(500) NOT NULL DEFAULT '',
      status VARCHAR(20) NOT NULL,
      detail VARCHAR(255) NOT NULL DEFAULT '',
      executed_sql VARCHAR(2000) NOT NULL DEFAULT '',
      row_count INT NOT NULL DEFAULT -1,
      duration_ms INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_user_created (user_id, created_at),
      INDEX idx_audit_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 存量库迁移：审计表补充真实执行留痕列（P1）
  try {
    await pool.query('ALTER TABLE query_audit_log ADD COLUMN executed_sql VARCHAR(2000) NOT NULL DEFAULT \'\' AFTER detail');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query('ALTER TABLE query_audit_log ADD COLUMN row_count INT NOT NULL DEFAULT -1 AFTER executed_sql');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 4. Seed default admin when users table is empty
  const [userRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM users');
  if (Number(userRows[0]?.cnt) === 0) {
    await pool.query(
      'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
      [defaultAdminUsername(), hashPassword(defaultAdminPassword()), '系统管理员', 'ADMIN']
    );
    console.log(`[DB] Seeded default admin account: ${defaultAdminUsername()} (please change password after first login)`);
  }

  // 5. Seed demo data sources when table is empty
  const [dsRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM data_sources');
  if (Number(dsRows[0]?.cnt) === 0) {
    for (const ds of INITIAL_DATA_SOURCES) {
      await pool.query(
        'INSERT INTO data_sources (id, name, type, config_json, schema_json, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          ds.id,
          ds.name,
          ds.type,
          JSON.stringify(ds.config || {}),
          JSON.stringify(ds.tables || []),
          ds.status,
          'system-seed',
        ]
      );
    }
    console.log(`[DB] Seeded ${INITIAL_DATA_SOURCES.length} demo data sources`);
  }

  console.log(`[DB] MySQL ready: ${base.host}:${base.port}/${database}`);
}
