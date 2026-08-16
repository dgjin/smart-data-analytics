/**
 * MySQL 持久化层：连接池、建库建表、初始种子。
 * 用户账号与数据源配置均落地 MySQL，服务启动时自动完成初始化。
 */
import mysql from 'mysql2/promise';
import { INITIAL_DATA_SOURCES } from './seedData';
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
      must_change_password TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL DEFAULT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 存量库迁移：P0-1 首登强制改密标记（种子账号/被重置密码后置 1，改密成功清零）
  try {
    await pool.query(
      'ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER status'
    );
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }

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

  // M1 推导过程留痕：问数全链路每步记录（环节类型/输入输出摘要/SQL/行数/耗时），支持事后回放
  await pool.query(`
    CREATE TABLE IF NOT EXISTS query_trace (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      trace_id VARCHAR(40) NOT NULL,
      user_id INT NOT NULL,
      username VARCHAR(50) NOT NULL DEFAULT '',
      data_source_id VARCHAR(64) NOT NULL DEFAULT '',
      question VARCHAR(500) NOT NULL DEFAULT '',
      step_type VARCHAR(20) NOT NULL,
      title VARCHAR(100) NOT NULL DEFAULT '',
      input_summary VARCHAR(1000) NOT NULL DEFAULT '',
      output_summary VARCHAR(2000) NOT NULL DEFAULT '',
      sql_text VARCHAR(2000) NOT NULL DEFAULT '',
      row_count INT NOT NULL DEFAULT -1,
      duration_ms INT NOT NULL DEFAULT 0,
      status VARCHAR(10) NOT NULL DEFAULT 'ok',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_trace_id (trace_id),
      INDEX idx_trace_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // M3 中间表清洗链注册表：记录落库应用库的物理中间表（ait_*）归属与 TTL，
  // 启动时 + 每小时定时清理过期注册与物理表
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analysis_intermediate_tables (
      id VARCHAR(32) PRIMARY KEY,
      table_name VARCHAR(64) NOT NULL,
      data_source_id VARCHAR(64) NOT NULL DEFAULT '',
      user_id INT NOT NULL,
      trace_id VARCHAR(40) NOT NULL DEFAULT '',
      purpose VARCHAR(300) NOT NULL DEFAULT '',
      columns_json TEXT,
      row_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      INDEX idx_ait_user (user_id, created_at),
      INDEX idx_ait_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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

  // 对话历史服务端落库：问数问答/状态落库，支撑历史面板（搜索/重问/删除/导出）
  // 与个人对话沉淀 few-shot 自学习（仅真实执行成功的 live 记录参与检索）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_history (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      username VARCHAR(50) NOT NULL DEFAULT '',
      data_source_id VARCHAR(64) NOT NULL DEFAULT '',
      question VARCHAR(500) NOT NULL DEFAULT '',
      executed_sql VARCHAR(2000) NOT NULL DEFAULT '',
      answer_summary VARCHAR(800) NOT NULL DEFAULT '',
      status ENUM('SUCCESS','FALLBACK') NOT NULL DEFAULT 'SUCCESS',
      provenance VARCHAR(20) NOT NULL DEFAULT '',
      row_count INT NOT NULL DEFAULT 0,
      duration_ms INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conv_user_ds (user_id, data_source_id, id)
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

  // 存量迁移：P1-3 few-shot 语义检索——样例问题向量（JSON 文本；NULL 时检索降级 bigram 词法）
  try {
    await pool.query('ALTER TABLE sql_examples ADD COLUMN embedding TEXT NULL AFTER created_by');
  } catch (err: any) {
    if (err?.code !== 'ER_DUP_FIELDNAME') throw err;
  }

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

  // P1-1 语义指标层：管理员登记的业务指标权威口径（名称/同义词/聚合表达式/归属表/固定过滤），
  // 问数命中后模板化注入阶段一 prompt，保证同指标全系统口径一致
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metric_definitions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      data_source_id VARCHAR(64) NOT NULL,
      name VARCHAR(50) NOT NULL,
      aliases_json VARCHAR(600) NOT NULL DEFAULT '[]',
      description VARCHAR(300) NOT NULL DEFAULT '',
      expr VARCHAR(200) NOT NULL,
      table_name VARCHAR(64) NOT NULL,
      filters VARCHAR(300) NOT NULL DEFAULT '',
      status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_metric_ds_name (data_source_id, name),
      INDEX idx_metric_ds_status (data_source_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // P2-4 LLM 用量埋点：按引擎/模型/通道记录 token 与耗时，支撑多引擎成本对比；
  // fire-and-forget 写入，失败不阻断主链路
  await pool.query(`
    CREATE TABLE IF NOT EXISTS llm_usage (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      engine VARCHAR(16) NOT NULL,
      model VARCHAR(128) NOT NULL,
      channel VARCHAR(12) NOT NULL,
      prompt_tokens INT NOT NULL DEFAULT 0,
      completion_tokens INT NOT NULL DEFAULT 0,
      total_tokens INT NOT NULL DEFAULT 0,
      duration_ms INT NOT NULL DEFAULT 0,
      ok TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_llm_usage_created (created_at),
      INDEX idx_llm_usage_engine_model (engine, model)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 外部知识库接入：管理员配置企业级外部 RAG/知识服务检索接口，
  // 问数时与本地知识库一并检索注入（智能问数自主学习的又一来源）；
  // api_key 用 AES-256-GCM 加密落库（复用数据源凭据加密链路）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_kb_sources (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      endpoint VARCHAR(500) NOT NULL,
      auth_type VARCHAR(20) NOT NULL DEFAULT 'none',
      api_key TEXT NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      timeout_ms INT NOT NULL DEFAULT 5000,
      data_source_id VARCHAR(64) NOT NULL DEFAULT '*',
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_ekb_ds (data_source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 4. Seed default admin when users table is empty（首登强制改密）
  const [userRows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) AS cnt FROM users');
  if (Number(userRows[0]?.cnt) === 0) {
    await pool.query(
      'INSERT INTO users (username, password_hash, display_name, role, must_change_password) VALUES (?, ?, ?, ?, 1)',
      [defaultAdminUsername(), hashPassword(defaultAdminPassword()), '系统管理员', 'ADMIN']
    );
    console.log(`[DB] Seeded default admin account: ${defaultAdminUsername()} (首次登录将强制修改初始密码)`);
  }

  // P0 安全告警：管理员仍在使用默认密码时每次启动提醒；仅对从未登录过的账号置强制改密标记
  // （首登前置位无副作用；已登录过的账号不反复锁死，避免打断开发/评测等程序化流程）
  const [adminRows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT id, password_hash, last_login_at FROM users WHERE username = ? LIMIT 1',
    [defaultAdminUsername()]
  );
  if (adminRows[0] && verifyPassword(defaultAdminPassword(), String(adminRows[0].password_hash))) {
    if (adminRows[0].last_login_at == null) {
      await pool.query('UPDATE users SET must_change_password = 1 WHERE id = ?', [adminRows[0].id]);
      console.warn('[Security] ⚠️ 管理员账号使用默认密码且从未登录，首次登录将强制修改密码！');
    } else {
      console.warn('[Security] ⚠️ 管理员账号仍在使用默认密码，请尽快修改！');
    }
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
