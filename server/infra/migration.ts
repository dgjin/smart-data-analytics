/**
 * 持久化层 - 存量迁移（质量优化 Stage 3.1 四拆分之 migration.ts）：
 * migrateSchema：幂等结构迁移（ADD COLUMN / MODIFY 类 DDL），须先于种子执行——
 *   存量库须先补齐种子 INSERT 依赖的列；
 * migrateData：数据类迁移（历史点赞样例回填、明文凭据就地加密），须后于种子执行——
 *   种子新插入的行同样要过迁移。
 * 由 db.ts 的 initSchema 调用；结构定义见 schema.ts。
 */
import mysql from 'mysql2/promise';
import { encryptSecret, isEncrypted } from './secretsCrypto';
import { logger } from './logger';
import { getErrorMessage, getErrorCode } from './errorUtils';

/** 存量库结构迁移：全部幂等（重复执行捕获 ER_DUP_FIELDNAME / MODIFY 天然幂等） */
export async function migrateSchema(pool: mysql.Pool): Promise<void> {
  // 存量库迁移：P0-1 首登强制改密标记（种子账号/被重置密码后置 1，改密成功清零）
  try {
    await pool.query(
      'ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0 AFTER status'
    );
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // P2-11 组织维度：用户所属部门（数据源授权按部门匹配；OIDC JIT 建号时从 IdP claim 同步）
  try {
    await pool.query("ALTER TABLE users ADD COLUMN department VARCHAR(100) NOT NULL DEFAULT '' AFTER display_name");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 存量库迁移：补充 scope_json 列（问数范围配置；NULL = 不限制）
  try {
    await pool.query('ALTER TABLE data_sources ADD COLUMN scope_json TEXT NULL AFTER schema_json');
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 存量库迁移：数据源级数据自省开关（Vanna intermediate_sql 借鉴；0=关闭，默认关）
  try {
    await pool.query("ALTER TABLE data_sources ADD COLUMN allow_introspection TINYINT(1) NOT NULL DEFAULT 0 AFTER status");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // P2-11 数据源访问控制清单（ACL）：{ departments: string[], userIds: number[] }；
  // NULL 或两组皆空 = 不限制（全员可见），非空 = 仅 ADMIN/清单内部门成员/清单内用户可访问
  try {
    await pool.query('ALTER TABLE data_sources ADD COLUMN acl_json TEXT NULL AFTER scope_json');
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 存量库迁移：审计表补充真实执行留痕列（P1）
  try {
    await pool.query('ALTER TABLE query_audit_log ADD COLUMN executed_sql VARCHAR(2000) NOT NULL DEFAULT \'\' AFTER detail');
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query('ALTER TABLE query_audit_log ADD COLUMN row_count INT NOT NULL DEFAULT -1 AFTER executed_sql');
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 存量库迁移：status ENUM 扩展 REFUSED（拒答留痕；MODIFY 幂等，重复执行无副作用）
  try {
    await pool.query(
      "ALTER TABLE conversation_history MODIFY COLUMN status ENUM('SUCCESS','FALLBACK','REFUSED') NOT NULL DEFAULT 'SUCCESS'"
    );
  } catch (err) {
    logger.warn('[DB] conversation_history status migration skipped:', getErrorMessage(err));
  }

  // 存量迁移：P1-3 few-shot 语义检索——样例问题向量（JSON 文本；NULL 时检索降级 bigram 词法）
  try {
    await pool.query('ALTER TABLE sql_examples ADD COLUMN embedding TEXT NULL AFTER created_by');
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // P1-8 指标层治理：状态机扩展为 PENDING/ACTIVE/REJECTED/DISABLED（提议→审批→生效），
  // 并加版本号与审批人字段；ENUM MODIFY 与加列均幂等（重复执行无害）
  await pool.query(
    "ALTER TABLE metric_definitions MODIFY COLUMN status ENUM('ACTIVE','DISABLED','PENDING','REJECTED') NOT NULL DEFAULT 'PENDING'"
  );
  try {
    await pool.query("ALTER TABLE metric_definitions ADD COLUMN version INT NOT NULL DEFAULT 1 AFTER status");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query("ALTER TABLE metric_definitions ADD COLUMN approved_by VARCHAR(50) NOT NULL DEFAULT '' AFTER version");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query("ALTER TABLE metric_definitions ADD COLUMN approved_at TIMESTAMP NULL DEFAULT NULL AFTER approved_by");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // P2-14 语义层升级：可切分维度白名单（对齐 dbt Semantic Layer 的 dimensions 概念）——
  // 登记该指标允许按哪些列分组切分，统一指标查询端点据此生成 GROUP BY，报表/看板/问数三端共享
  try {
    await pool.query("ALTER TABLE metric_definitions ADD COLUMN dimensions_json VARCHAR(600) NOT NULL DEFAULT '[]' AFTER filters");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 存量库迁移（v0.9.43）：role_prompt 500→2000（MODIFY 幂等）；content_version 加列（重复执行捕获 ER_DUP_FIELDNAME）
  await pool.query('ALTER TABLE expert_personas MODIFY COLUMN role_prompt VARCHAR(2000) NOT NULL');
  try {
    await pool.query("ALTER TABLE expert_personas ADD COLUMN content_version INT NOT NULL DEFAULT 1 AFTER created_by");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 存量库迁移：LLM 用量按用户维度统计（user_id/username 冗余存快照，改名不影响历史）
  for (const ddl of [
    'ALTER TABLE llm_usage ADD COLUMN user_id INT NULL AFTER channel',
    'ALTER TABLE llm_usage ADD COLUMN username VARCHAR(64) NULL AFTER user_id',
    'ALTER TABLE llm_usage ADD INDEX idx_llm_usage_user (user_id)',
  ]) {
    try {
      await pool.query(ddl);
    } catch (err) {
      if (getErrorCode(err) !== 'ER_DUP_FIELDNAME' && getErrorCode(err) !== 'ER_DUP_KEYNAME') throw err;
    }
  }

  // P2-15 Fallback 对抗训练：存量迁移 - 在 query_audit_log 中增加 fallback 相关字段
  try {
    await pool.query("ALTER TABLE query_audit_log ADD COLUMN fallback_latency_ms INT NULL AFTER duration_ms");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }
  try {
    await pool.query("ALTER TABLE query_audit_log ADD COLUMN fallback_strategy VARCHAR(30) NULL AFTER fallback_latency_ms");
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 组织权限模型：用户数据范围 { level: ALL|ORG|TEAM|SELF, orgs[], teams[], selfCode }
  // NULL/ALL = 不限制（存量用户行为不变）；ORG=仅本机构（JGBH 类），TEAM=仅本项目团队（SSTD 类），SELF=仅本人经办
  try {
    await pool.query('ALTER TABLE users ADD COLUMN org_scope_json TEXT NULL AFTER department');
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

  // 组织权限模型：数据源侧的组织列映射 { org, team, owner }（列名逐字取自该数据源 schema）
  // NULL/全空 = 该数据源不做组织隔离（存量数据源默认不隔离）
  try {
    await pool.query('ALTER TABLE data_sources ADD COLUMN org_columns_json TEXT NULL AFTER acl_json');
  } catch (err) {
    if (getErrorCode(err) !== 'ER_DUP_FIELDNAME') throw err;
  }

}

/** 存量库数据迁移：依赖既有数据与种子结果，须在种子之后执行 */
export async function migrateData(pool: mysql.Pool): Promise<void> {
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

  // 6. P0 存量迁移：明文数据源密码就地加密（enc:v1: 前缀幂等跳过）
  const [dsAll] = await pool.query<mysql.RowDataPacket[]>('SELECT id, config_json FROM data_sources');
  for (const row of dsAll) {
    let config: { password?: string } & Record<string, unknown>;
    try {
      config = typeof row.config_json === 'string' ? JSON.parse(row.config_json) : row.config_json;
    } catch {
      continue;
    }
    if (!config?.password || isEncrypted(config.password)) continue;
    config.password = encryptSecret(String(config.password));
    await pool.query('UPDATE data_sources SET config_json = ? WHERE id = ?', [JSON.stringify(config), row.id]);
    logger.info(`[DB] Encrypted stored credential for data source ${row.id}`);
  }

}
