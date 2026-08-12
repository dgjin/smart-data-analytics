/**
 * MySQL 持久化层：连接池、建库建表、初始种子。
 * 用户账号与数据源配置均落地 MySQL，服务启动时自动完成初始化。
 */
import mysql from 'mysql2/promise';
import { INITIAL_DATA_SOURCES } from '../src/data/sampleDatasets';
import { hashPassword, verifyPassword } from './passwords';
import { encryptSecret, isEncrypted } from './secretsCrypto';
import { BUILTIN_SKILLS } from './skills';

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

  // 存量库迁移：数据源级数据自省开关（Vanna intermediate_sql 借鉴；0=关闭，默认关）
  try {
    await pool.query("ALTER TABLE data_sources ADD COLUMN allow_introspection TINYINT(1) NOT NULL DEFAULT 0 AFTER status");
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

  // P1 反馈闭环：问数结果点赞/点踩；点赞样例作为 few-shot 注入后续 NL2SQL prompt
  await pool.query(`
    CREATE TABLE IF NOT EXISTS query_feedback (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      username VARCHAR(50) NOT NULL DEFAULT '',
      data_source_id VARCHAR(64) NOT NULL DEFAULT '',
      question VARCHAR(500) NOT NULL DEFAULT '',
      executed_sql VARCHAR(2000) NOT NULL DEFAULT '',
      verdict ENUM('UP','DOWN') NOT NULL,
      provenance VARCHAR(20) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_feedback_ds_verdict (data_source_id, verdict, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // P1-A 知识库 RAG：管理员登记的业务知识（指标口径/术语），切块后向量检索注入问数 prompt
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      doc_id VARCHAR(64) NOT NULL,
      data_source_id VARCHAR(64) NOT NULL,
      title VARCHAR(200) NOT NULL DEFAULT '',
      chunk_text MEDIUMTEXT,
      embedding_json MEDIUMTEXT NULL,
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_kb_ds (data_source_id),
      INDEX idx_kb_doc (doc_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // P2-A 技能库：用户维护个人技能并可分享至系统库（管理员审核）；系统默认库由管理员维护
  await pool.query(`
    CREATE TABLE IF NOT EXISTS skill_library (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      skill_id VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      prompt_template TEXT NOT NULL,
      placeholders VARCHAR(500) NOT NULL DEFAULT '[]',
      scope ENUM('USER','SYSTEM') NOT NULL DEFAULT 'USER',
      status ENUM('ACTIVE','PENDING_SHARE') NOT NULL DEFAULT 'ACTIVE',
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_skill_scope (scope),
      INDEX idx_skill_owner (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 内置技能种子：写入系统技能库（按 skill_id 幂等跳过，管理员可继续维护）
  for (const sk of BUILTIN_SKILLS) {
    await pool.query(
      `INSERT INTO skill_library (skill_id, name, description, prompt_template, placeholders, scope, status, created_by)
       SELECT ?, ?, ?, ?, ?, 'SYSTEM', 'ACTIVE', 'system-seed'
       FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM skill_library WHERE skill_id = ?)`,
      [sk.id, sk.name, sk.description, sk.promptTemplate, JSON.stringify(sk.placeholders), sk.id]
    );
  }

  // Vanna 借鉴：SQL 样例库（训练语料）。管理员手工登记 + 点赞反馈自动沉淀，
  // 问数时作为 few-shot 检索源（question-SQL 对），统一可维护可剔除
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sql_examples (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      data_source_id VARCHAR(64) NOT NULL,
      question VARCHAR(500) NOT NULL,
      sql_text VARCHAR(2000) NOT NULL,
      source ENUM('MANUAL','FEEDBACK_UP','IMPORT') NOT NULL DEFAULT 'MANUAL',
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_sqlx_ds (data_source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 存量迁移：历史点赞样例（query_feedback UP/live）一次性灌入样例库（幂等跳过）
  const [sqlxRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM sql_examples');
  if (Number(sqlxRows[0]?.cnt) === 0) {
    await pool.query(`
      INSERT INTO sql_examples (data_source_id, question, sql_text, source, created_by)
      SELECT data_source_id, question, executed_sql, 'FEEDBACK_UP', username FROM query_feedback
      WHERE verdict = 'UP' AND provenance = 'live' AND executed_sql <> ''
      ORDER BY id ASC
    `);
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

  // P0 安全告警：管理员仍在使用默认密码时每次启动强提示
  const [adminRows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT password_hash FROM users WHERE username = ? LIMIT 1',
    [defaultAdminUsername()]
  );
  if (adminRows[0] && verifyPassword(defaultAdminPassword(), String(adminRows[0].password_hash))) {
    console.warn('[Security] ⚠️ 管理员账号仍在使用默认密码，请立即登录后台修改！');
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

  // 6. P0 存量迁移：明文数据源密码就地加密（enc:v1: 前缀幂等跳过）
  const [dsAll] = await pool.query<mysql.RowDataPacket[]>('SELECT id, config_json FROM data_sources');
  for (const row of dsAll) {
    let config: any;
    try {
      config = typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json;
    } catch {
      continue;
    }
    if (!config?.password || isEncrypted(config.password)) continue;
    config.password = encryptSecret(String(config.password));
    await pool.query('UPDATE data_sources SET config_json = ? WHERE id = ?', [JSON.stringify(config), row.id]);
    console.log(`[DB] Encrypted stored credential for data source ${row.id}`);
  }

  console.log(`[DB] MySQL ready: ${base.host}:${base.port}/${database}`);
}
