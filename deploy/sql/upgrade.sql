-- ============================================================================
-- 智能问数据分析系统 · 数据库升级脚本（累计式 / 幂等 / 生成产物）
-- ============================================================================
-- 适用版本：v0.9.119
-- 生成来源：server/infra/schema.ts、server/infra/taskQueue.ts、server/anomalyPatrol.ts、
--           server/infra/createAbTestTable.ts（建表）
--           server/infra/migration.ts、server/infra/taskQueue.ts（存量列/索引迁移）
-- 生成命令：npm run db:sql（校验：npm run db:sql:check）；请勿手工修改本文件
--
-- 用法（先确认目标库，再执行；可对同一库重复执行）：
--   mysql -h <host> -P <port> -u <user> -p <库名> < deploy/sql/upgrade.sql
--
-- 说明：
--   1. 等价于应用启动时的 initSchema()：建表 + 存量结构迁移；不写种子数据（默认管理员、
--      内置技能等由应用启动时的 seedInitialData 写入），也不做明文凭据加密等数据迁移；
--   2. 全部语句幂等：建表用 CREATE TABLE IF NOT EXISTS；加列/加索引用 information_schema
--      判重后动态执行；MODIFY 天然幂等；可在任意 ≤ 当前版本的存量库上重复执行；
--   3. 执行账号需具备目标库的 CREATE / ALTER / INDEX 权限；本脚本使用 PREPARE 动态执行，
--      不创建存储过程，无需 CREATE ROUTINE；
--   4. 文件上传表（upl_*）与清洗中间表（ait_*）由应用运行时创建，不在本脚本范围内；
--   5. 首选仍是启动应用自动迁移；本脚本供受限权限、离线交付或审计留档场景使用。
-- ============================================================================

SET NAMES utf8mb4;

-- 建表合计：58 张（含按需表）

-- ────────────────────────────────────────────────────────────────────────────
-- 基础表（应用启动 initSchema 自动创建）
-- ────────────────────────────────────────────────────────────────────────────

-- 表：users（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：org_units（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS org_units (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_id INT NULL,
  level ENUM('HQ','BRANCH','DEPT','TEAM') NOT NULL,
  name VARCHAR(100) NOT NULL,
  data_code VARCHAR(100) NOT NULL DEFAULT '',
  sort_order INT NOT NULL DEFAULT 0,
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_org_parent_name (parent_id, name),
  INDEX idx_org_parent (parent_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：data_sources（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS data_sources (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(20) NOT NULL,
  config_json TEXT,
  schema_json MEDIUMTEXT,
  scope_json TEXT,
  acl_json TEXT NULL,
  anomaly_capabilities_json TEXT NULL,
  anomaly_thresholds_json TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'connected',
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：permission_requests（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS permission_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL DEFAULT '',
  department VARCHAR(100) NOT NULL DEFAULT '',
  data_source_id VARCHAR(64) NOT NULL,
  reason VARCHAR(500) NOT NULL DEFAULT '',
  status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  approver VARCHAR(50) NOT NULL DEFAULT '',
  decide_note VARCHAR(300) NOT NULL DEFAULT '',
  decided_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_perm_req_status (status, created_at),
  INDEX idx_perm_req_user (user_id, data_source_id),
  INDEX idx_perm_req_ds (data_source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：download_requests（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS download_requests (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL DEFAULT '',
  department VARCHAR(100) NOT NULL DEFAULT '',
  data_source_id VARCHAR(64) NOT NULL DEFAULT '',
  title VARCHAR(200) NOT NULL DEFAULT '',
  row_count INT NOT NULL DEFAULT 0,
  status ENUM('PENDING','APPROVED','REJECTED','CONSUMED') NOT NULL DEFAULT 'PENDING',
  approver VARCHAR(50) NOT NULL DEFAULT '',
  decide_note VARCHAR(300) NOT NULL DEFAULT '',
  decided_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_dl_req_status (status, created_at),
  INDEX idx_dl_req_user (user_id, data_source_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：query_audit_log（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：query_trace（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：analysis_intermediate_tables（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：query_feedback（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：conversation_history（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS conversation_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL DEFAULT '',
  data_source_id VARCHAR(64) NOT NULL DEFAULT '',
  question VARCHAR(500) NOT NULL DEFAULT '',
  executed_sql VARCHAR(2000) NOT NULL DEFAULT '',
  answer_summary VARCHAR(800) NOT NULL DEFAULT '',
  status ENUM('SUCCESS','FALLBACK','REFUSED') NOT NULL DEFAULT 'SUCCESS',
  provenance VARCHAR(20) NOT NULL DEFAULT '',
  row_count INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conv_user_ds (user_id, data_source_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：knowledge_base（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：knowledge_base_entries（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS knowledge_base_entries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entry_id VARCHAR(64) NOT NULL UNIQUE,          -- 唯一标识符（如 kb_001）
  data_source_id VARCHAR(64) NOT NULL,           -- 关联数据源 ID
  title VARCHAR(500) NOT NULL DEFAULT '',        -- 标题
  content MEDIUMTEXT NOT NULL,                   -- Markdown 格式的完整内容
  tags JSON NOT NULL,                            -- 标签数组
  category VARCHAR(100) NOT NULL DEFAULT '',     -- 分类名称
  version VARCHAR(20) NOT NULL DEFAULT '1.0',    -- 版本号
  is_preset TINYINT(1) NOT NULL DEFAULT 0,       -- 是否为预置条目（不可编辑）
  created_by VARCHAR(50) NOT NULL DEFAULT '',    -- 创建者
  updated_by VARCHAR(50) NOT NULL DEFAULT '',    -- 更新者
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_entries_ds (data_source_id),
  INDEX idx_entries_id (entry_id),
  INDEX idx_entries_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：skill_library（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：sql_examples（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：report_templates（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS report_templates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL COMMENT '模板名称',
  description VARCHAR(500) DEFAULT '' COMMENT '模板描述',
  template_content TEXT NOT NULL COMMENT '模板内容（JSON 格式：{sections: [{title, prompt, chartType}]}）',
  is_preset TINYINT(1) DEFAULT 0 COMMENT '是否预设模板（1=系统预设不可删除）',
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_rt_preset (is_preset)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：query_reports（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS query_reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  report_id VARCHAR(64) NOT NULL UNIQUE COMMENT '报告唯一标识（前端生成 report-{timestamp}）',
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL,
  data_source_id VARCHAR(64) NOT NULL,
  question TEXT NOT NULL COMMENT '用户提问',
  template_id BIGINT NULL COMMENT '使用的模板ID（NULL=智能推断）',
  template_name VARCHAR(100) DEFAULT '' COMMENT '模板名称快照',
  report_data MEDIUMTEXT NOT NULL COMMENT '报告完整数据（JSON：title/summary/kpiList/charts/insights）',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_qr_user (user_id, data_source_id),
  INDEX idx_qr_report_id (report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：saved_reports（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS saved_reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  report_id VARCHAR(64) NOT NULL UNIQUE COMMENT '报表唯一标识（前端生成 report-{timestamp}）',
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL,
  data_source_id VARCHAR(64) NOT NULL DEFAULT '',
  template_type VARCHAR(200) DEFAULT '' COMMENT '报表主题快照（genParams.templateType）',
  data_provenance VARCHAR(20) NOT NULL DEFAULT 'live' COMMENT 'live=真实数据源 / simulated=降级演示',
  report_data MEDIUMTEXT NOT NULL COMMENT '完整 SavedReport JSON（含 genParams 条件快照与批注）',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sr_ds (data_source_id),
  INDEX idx_sr_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：dashboard_widgets（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  widget_id VARCHAR(64) NOT NULL UNIQUE COMMENT '图表唯一标识（前端生成 widget-{timestamp}；出厂内置 widget-1..5）',
  user_id INT NOT NULL COMMENT '固化人用户 ID（出厂内置为 0/system）',
  username VARCHAR(50) NOT NULL,
  widget_data MEDIUMTEXT NOT NULL COMMENT '完整 DashboardWidget JSON（chartConfig/data/colSpan 等）',
  sort_order INT NOT NULL DEFAULT 0 COMMENT '看板排列顺序（拖拽排序批量回写）',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_dw_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：flex_queries（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS flex_queries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL UNIQUE COMMENT '固定报表唯一标识（前端生成 flex-{timestamp}）',
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL,
  data_source_id VARCHAR(64) NOT NULL DEFAULT '',
  query_data MEDIUMTEXT NOT NULL COMMENT '完整 SavedFlexQuery JSON（含 FlexQueryConfig 与图表类型）',
  version INT NOT NULL DEFAULT 1 COMMENT '当前版本号（与 flex_query_versions.version 对应）',
  use_count INT NOT NULL DEFAULT 0 COMMENT '使用次数（载入/执行打点累计）',
  last_used_at TIMESTAMP NULL COMMENT '最近使用时间',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fq_ds (data_source_id),
  INDEX idx_fq_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：flex_query_versions（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS flex_query_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  query_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  snapshot_json MEDIUMTEXT NOT NULL COMMENT '完整 SavedFlexQuery JSON 快照',
  action VARCHAR(16) NOT NULL DEFAULT 'UPDATE' COMMENT 'CREATE/UPDATE/RESTORE',
  actor VARCHAR(50) NOT NULL DEFAULT '' COMMENT '操作人用户名',
  remark VARCHAR(200) NOT NULL DEFAULT '' COMMENT '备注（回滚时记录来源版本）',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fqv_query (query_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：flex_query_subscriptions（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS flex_query_subscriptions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subscription_id VARCHAR(64) NOT NULL UNIQUE COMMENT '订阅唯一标识（sub-{timestamp}-{rand}）',
  query_id VARCHAR(64) NOT NULL COMMENT '关联固定报表',
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL,
  frequency_minutes INT NOT NULL DEFAULT 1440 COMMENT '执行周期（分钟）',
  alert_metric VARCHAR(64) NOT NULL DEFAULT '' COMMENT '告警指标结果列名（空=仅重跑不告警）',
  alert_op VARCHAR(4) NOT NULL DEFAULT '>' COMMENT '告警比较符 > >= < <= =',
  alert_threshold DECIMAL(20,4) NOT NULL DEFAULT 0 COMMENT '告警阈值',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/PAUSED',
  last_run_at TIMESTAMP NULL,
  next_run_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fqs_query (query_id),
  INDEX idx_fqs_user (user_id),
  INDEX idx_fqs_due (status, next_run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：flex_query_subscription_runs（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS flex_query_subscription_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  subscription_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL COMMENT 'SUCCESS/ALERT/FAILED',
  row_count INT NOT NULL DEFAULT 0,
  alert_value VARCHAR(64) NOT NULL DEFAULT '' COMMENT '命中告警时的指标值',
  message VARCHAR(500) NOT NULL DEFAULT '' COMMENT '错误信息或告警文案',
  duration_ms INT NOT NULL DEFAULT 0,
  run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fqsr_sub (subscription_id, run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：flex_query_history（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS flex_query_history (
  user_id INT PRIMARY KEY,
  history_data MEDIUMTEXT NOT NULL COMMENT 'FlexHistoryItem JSON 数组（按配置去重、上限 8 条）',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：metric_definitions（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：metric_versions（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS metric_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  metric_id BIGINT NOT NULL,
  version INT NOT NULL,
  snapshot_json TEXT NOT NULL,
  action VARCHAR(20) NOT NULL,
  actor VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_metric_versions_metric (metric_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：iron_rules（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS iron_rules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  data_source_id VARCHAR(64) NOT NULL,
  title VARCHAR(100) NOT NULL,
  content VARCHAR(2000) NOT NULL,
  status ENUM('ACTIVE','DISABLED','PENDING') NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_iron_ds_title (data_source_id, title),
  INDEX idx_iron_ds_status (data_source_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：ontology_entities（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS ontology_entities (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  data_source_id VARCHAR(64) NOT NULL,
  name VARCHAR(50) NOT NULL COMMENT '业务实体名（如 机构/项目）',
  entity_type VARCHAR(20) NOT NULL DEFAULT 'SUBJECT' COMMENT 'SUBJECT/OBJECT/TIME/GEO',
  aliases_json VARCHAR(600) NOT NULL DEFAULT '[]' COMMENT '业务别名 JSON 数组（如 机构名称/JGMC）',
  description VARCHAR(300) NOT NULL DEFAULT '',
  status ENUM('ACTIVE','DISABLED','PENDING','REJECTED') NOT NULL DEFAULT 'ACTIVE',
  version INT NOT NULL DEFAULT 1,
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_ontology_entity_ds_name (data_source_id, name),
  INDEX idx_ontology_entity_ds_status (data_source_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：ontology_bindings（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS ontology_bindings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_id BIGINT NOT NULL,
  data_source_id VARCHAR(64) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  column_name VARCHAR(64) NOT NULL DEFAULT '' COMMENT '空=表级绑定',
  role ENUM('IDENTITY','ATTRIBUTE','RELATION_KEY') NOT NULL DEFAULT 'IDENTITY',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_ontology_binding (entity_id, table_name, column_name),
  INDEX idx_ontology_binding_ds_table (data_source_id, table_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：ontology_value_notes（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS ontology_value_notes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  data_source_id VARCHAR(64) NOT NULL,
  table_name VARCHAR(64) NOT NULL,
  column_name VARCHAR(64) NOT NULL,
  value_code VARCHAR(100) NOT NULL,
  meaning VARCHAR(200) NOT NULL,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_ontology_value_note (data_source_id, table_name, column_name, value_code),
  INDEX idx_ontology_value_note_ds_table (data_source_id, table_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：ontology_relations（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS ontology_relations (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  data_source_id VARCHAR(64) NOT NULL,
  from_table VARCHAR(64) NOT NULL,
  from_columns VARCHAR(300) NOT NULL COMMENT '逗号分隔的关联列',
  to_table VARCHAR(64) NOT NULL,
  to_columns VARCHAR(300) NOT NULL,
  join_type ENUM('INNER','LEFT','RIGHT') NOT NULL DEFAULT 'LEFT',
  cardinality ENUM('1:1','1:N','N:1','N:N') NOT NULL DEFAULT 'N:1',
  purpose VARCHAR(300) NOT NULL DEFAULT '',
  status ENUM('ACTIVE','DISABLED','PENDING','REJECTED') NOT NULL DEFAULT 'ACTIVE',
  version INT NOT NULL DEFAULT 1,
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- 唯一键列长按 utf8mb4 4 字节折算：64+64+191+64+191=574 字符（2296 字节）< 3072 上限；
  -- 关联列最长 300 字符，取前 191 作前缀足以区分（超长时由应用层 sanitize 拦截）
  UNIQUE KEY uniq_ontology_relation (data_source_id, from_table, from_columns(191), to_table, to_columns(191)),
  INDEX idx_ontology_relation_ds_status (data_source_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：ontology_hierarchies（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS ontology_hierarchies (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  data_source_id VARCHAR(64) NOT NULL,
  name VARCHAR(50) NOT NULL,
  levels_json VARCHAR(600) NOT NULL DEFAULT '[]' COMMENT '层级列序 JSON 数组，由粗到细',
  status ENUM('ACTIVE','DISABLED','PENDING','REJECTED') NOT NULL DEFAULT 'ACTIVE',
  version INT NOT NULL DEFAULT 1,
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_ontology_hierarchy_ds_name (data_source_id, name),
  INDEX idx_ontology_hierarchy_ds_status (data_source_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：ontology_versions（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS ontology_versions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  asset_type ENUM('entity','relation','hierarchy') NOT NULL,
  asset_id BIGINT NOT NULL,
  version INT NOT NULL,
  snapshot_json TEXT NOT NULL,
  action VARCHAR(20) NOT NULL COMMENT 'CREATE/UPDATE/DELETE/RESTORE',
  actor VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ontology_versions_asset (asset_type, asset_id, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：expert_personas（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS expert_personas (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  persona_key VARCHAR(40) NOT NULL,
  label VARCHAR(50) NOT NULL,
  keywords TEXT NOT NULL,
  role_prompt VARCHAR(2000) NOT NULL,
  sort_order INT NOT NULL DEFAULT 100,
  status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
  is_builtin TINYINT(1) NOT NULL DEFAULT 0,
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  content_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_persona_key (persona_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：llm_usage（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS llm_usage (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  engine VARCHAR(16) NOT NULL,
  model VARCHAR(128) NOT NULL,
  channel VARCHAR(12) NOT NULL,
  user_id INT NULL,
  username VARCHAR(64) NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  duration_ms INT NOT NULL DEFAULT 0,
  ok TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_llm_usage_created (created_at),
  INDEX idx_llm_usage_engine_model (engine, model),
  INDEX idx_llm_usage_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：external_kb_sources（server/infra/schema.ts）
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：adversarial_samples（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS adversarial_samples (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  original_query VARCHAR(500) NOT NULL COMMENT '原始用户查询',
  original_sql VARCHAR(2000) NOT NULL COMMENT '失败的 SQL',
  error_message VARCHAR(500) NOT NULL DEFAULT '' COMMENT '错误原因',
  data_source_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '关联数据源 ID',
  user_id INT NOT NULL COMMENT '提问用户 ID',
  username VARCHAR(50) NOT NULL DEFAULT '' COMMENT '提问用户名',
  annotation_status ENUM('PENDING','IN_REVIEW','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING' COMMENT '标注状态',
  expected_sql TEXT NULL COMMENT '期望的正确 SQL（管理员填写）',
  resolved_strategy VARCHAR(30) NULL DEFAULT NULL COMMENT 'Resolved strategy (rule_based/simpler_prompt/human_approval)',
  resolved_at TIMESTAMP NULL DEFAULT NULL COMMENT 'Resolution timestamp',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '采集时间',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  INDEX idx_adv_ds_created (data_source_id, created_at),
  INDEX idx_adv_status (annotation_status),
  INDEX idx_adv_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT 'NL2SQL 困难样本库，用于对抗训练';

-- 表：fallback_audit_log（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS fallback_audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  trace_id VARCHAR(40) NOT NULL DEFAULT '' COMMENT '查询追踪 ID',
  query VARCHAR(500) NOT NULL DEFAULT '' COMMENT '原始用户查询',
  failed_sql VARCHAR(2000) NOT NULL DEFAULT '' COMMENT '失败的 SQL',
  used_strategy VARCHAR(30) NOT NULL DEFAULT 'none' COMMENT '使用的 fallback 策略',
  latency_ms INT NOT NULL DEFAULT 0 COMMENT 'Fallback 决策耗时（ms）',
  success TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否成功解决',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '记录时间',
  INDEX idx_fault_strategy (used_strategy),
  INDEX idx_fault_latency (latency_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT 'Fallback 机制审计日志';

-- 表：few_shot_examples（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS few_shot_examples (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  data_source_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '关联数据源 ID',
  question VARCHAR(500) NOT NULL COMMENT '原始用户查询',
  expected_sql TEXT NOT NULL COMMENT '人工审核通过的正确 SQL',
  sample_source VARCHAR(30) NOT NULL DEFAULT 'fallback_approval' COMMENT '来源（fallback_approval=对抗训练审批采纳）',
  sample_id BIGINT NULL COMMENT '来源 adversarial_samples.id',
  hit_count INT NOT NULL DEFAULT 0 COMMENT '被 fallback 复用次数',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '注入时间',
  INDEX idx_fse_ds (data_source_id),
  INDEX idx_fse_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT 'Few-Shot 示例库（对抗训练闭环）';

-- 表：kb_drift_watch（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS kb_drift_watch (
  data_source_id VARCHAR(64) NOT NULL,
  table_name VARCHAR(128) NOT NULL,
  column_name VARCHAR(128) NOT NULL,
  values_json MEDIUMTEXT NULL,
  snapshot_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (data_source_id, table_name, column_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：kb_drift_events（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS kb_drift_events (
  id VARCHAR(48) PRIMARY KEY,
  data_source_id VARCHAR(64) NOT NULL,
  table_name VARCHAR(128) NOT NULL,
  column_name VARCHAR(128) NOT NULL,
  added_json MEDIUMTEXT NULL,
  removed_json MEDIUMTEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_drift_ds_status (data_source_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：env_config（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS env_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  `key` VARCHAR(100) NOT NULL,
  `value` TEXT NOT NULL,
  category VARCHAR(50) DEFAULT 'system',
  description TEXT,
  is_sensitive TINYINT(1) DEFAULT 0,
  updated_by INT DEFAULT NULL,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_key (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：setup_wizard_state（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS setup_wizard_state (
  id TINYINT PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  current_step TINYINT NOT NULL DEFAULT 0,
  step_results JSON NULL,
  pipeline_task_id VARCHAR(64) NULL,
  skipped_until TIMESTAMP NULL,
  started_by VARCHAR(50) NOT NULL DEFAULT '',
  completed_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：ops_events（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS ops_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_key VARCHAR(160) NOT NULL DEFAULT '',
  severity VARCHAR(10) NOT NULL,
  source VARCHAR(16) NOT NULL,
  category VARCHAR(24) NOT NULL DEFAULT 'SYSTEM',
  entity_type VARCHAR(32) NOT NULL DEFAULT '',
  entity_id VARCHAR(128) NOT NULL DEFAULT '',
  message VARCHAR(500) NOT NULL DEFAULT '',
  detail JSON NULL,
  trace_id VARCHAR(64) NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'NEW',
  dedup_count INT NOT NULL DEFAULT 1,
  handled_by VARCHAR(64) NOT NULL DEFAULT '',
  handled_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ops_events_status_created (status, created_at),
  INDEX idx_ops_events_dedup (event_key, status, last_seen_at),
  INDEX idx_ops_events_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：feedback_entries（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS feedback_entries (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL DEFAULT 'REQUIREMENT',
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  priority VARCHAR(10) NOT NULL DEFAULT '',
  baseline_version VARCHAR(50) NOT NULL DEFAULT '',
  assessment TEXT,
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL,
  department VARCHAR(100) NOT NULL DEFAULT '',
  reviewer VARCHAR(50) NOT NULL DEFAULT '',
  reviewed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_feedback_status (status),
  INDEX idx_feedback_user (user_id),
  INDEX idx_feedback_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：feedback_entry_revisions（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS feedback_entry_revisions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entry_id BIGINT NOT NULL,
  action VARCHAR(20) NOT NULL,
  priority VARCHAR(10) NOT NULL DEFAULT '',
  baseline_version VARCHAR(50) NOT NULL DEFAULT '',
  assessment TEXT,
  reviewer VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_feedback_rev_entry (entry_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：user_personal_info（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS user_personal_info (
  user_id INT PRIMARY KEY,
  nickname VARCHAR(30) NOT NULL DEFAULT '',
  avatar MEDIUMTEXT,
  signature VARCHAR(100) NOT NULL DEFAULT '',
  preferences_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：memory_items（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS memory_items (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL DEFAULT 'CORRECTION',
  data_source_id VARCHAR(64) NOT NULL,
  user_id INT NULL,
  question VARCHAR(500) NOT NULL,
  content VARCHAR(4000) NOT NULL DEFAULT '',
  error_type VARCHAR(20) NOT NULL DEFAULT 'OTHER',
  expected_sql TEXT,
  embedding_json MEDIUMTEXT,
  source VARCHAR(20) NOT NULL DEFAULT 'USER',
  confidence DECIMAL(3,2) NOT NULL DEFAULT 0.90,
  hits INT NOT NULL DEFAULT 0,
  last_used_at DATETIME NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(50) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_mem_item_ds (data_source_id, status),
  INDEX idx_mem_item_user (user_id),
  INDEX idx_mem_item_kind (kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：memory_candidates（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS memory_candidates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL DEFAULT 'CORRECTION',
  data_source_id VARCHAR(64) NOT NULL,
  user_id INT NULL,
  question VARCHAR(500) NOT NULL,
  wrong_sql TEXT,
  error_type VARCHAR(20) NOT NULL DEFAULT 'OTHER',
  payload TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  reviewed_by VARCHAR(50) NOT NULL DEFAULT '',
  reviewed_at DATETIME NULL,
  memory_id BIGINT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mem_cand_status (status),
  INDEX idx_mem_cand_ds (data_source_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：memory_usage（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS memory_usage (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  trace_id VARCHAR(40) NOT NULL,
  user_id INT NOT NULL,
  data_source_id VARCHAR(64) NOT NULL,
  memory_ref VARCHAR(80) NOT NULL,
  channel VARCHAR(24) NOT NULL,
  rank_no INT NOT NULL DEFAULT 0,
  score DECIMAL(6,4) NOT NULL DEFAULT 0,
  tokens INT NOT NULL DEFAULT 0,
  injected TINYINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_mem_usage_trace (trace_id),
  INDEX idx_mem_usage_ds_time (data_source_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：access_sessions（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS access_sessions (
  session_hash CHAR(64) PRIMARY KEY,
  is_authed TINYINT(1) NOT NULL DEFAULT 0,
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_access_sessions_seen (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：access_daily（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS access_daily (
  stat_date DATE PRIMARY KEY,
  visits INT NOT NULL DEFAULT 0,
  authed_visits INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：access_module_daily（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS access_module_daily (
  stat_date DATE NOT NULL,
  module VARCHAR(32) NOT NULL,
  hits INT NOT NULL DEFAULT 0,
  PRIMARY KEY (stat_date, module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：query_ratings（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS query_ratings (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  dedupe_key CHAR(64) NOT NULL,
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL DEFAULT '',
  data_source_id VARCHAR(64) NOT NULL DEFAULT '',
  question VARCHAR(500) NOT NULL DEFAULT '',
  executed_sql VARCHAR(2000) NOT NULL DEFAULT '',
  trace_id VARCHAR(40) NOT NULL DEFAULT '',
  rating TINYINT NOT NULL,
  tags VARCHAR(200) NOT NULL DEFAULT '',
  comment VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_query_rating_dedupe (dedupe_key),
  INDEX idx_query_rating_created (created_at),
  INDEX idx_query_rating_score (rating, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：app_satisfaction（server/infra/schema.ts）
CREATE TABLE IF NOT EXISTS app_satisfaction (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL DEFAULT '',
  page VARCHAR(32) NOT NULL DEFAULT '',
  rating TINYINT NOT NULL,
  tags VARCHAR(200) NOT NULL DEFAULT '',
  comment VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_app_sat_user (user_id, created_at),
  INDEX idx_app_sat_created (created_at),
  INDEX idx_app_sat_score (rating, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：async_tasks（server/infra/taskQueue.ts）
CREATE TABLE IF NOT EXISTS async_tasks (
  id VARCHAR(48) PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  status ENUM('PENDING','RUNNING','SUCCESS','FAILED') NOT NULL DEFAULT 'PENDING',
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL DEFAULT '',
  payload_json MEDIUMTEXT,
  result_json MEDIUMTEXT NULL,
  error VARCHAR(500) NOT NULL DEFAULT '',
  progress VARCHAR(100) NOT NULL DEFAULT '',
  attempts INT NOT NULL DEFAULT 0,
  worker_id VARCHAR(64) NOT NULL DEFAULT '',
  heartbeat_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP NULL DEFAULT NULL,
  finished_at TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_tasks_status (status, created_at),
  INDEX idx_tasks_user (user_id, created_at),
  INDEX idx_tasks_heartbeat (status, heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ────────────────────────────────────────────────────────────────────────────
-- 按需表（巡检由启动时 ensurePatrolTables 创建；A/B 实验表按需手工创建）
-- ────────────────────────────────────────────────────────────────────────────

-- 表：anomaly_patrols（server/anomalyPatrol.ts）
CREATE TABLE IF NOT EXISTS anomaly_patrols (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  patrol_id VARCHAR(64) NOT NULL UNIQUE COMMENT '巡检计划唯一标识（patrol-{uuid}）',
  user_id INT NOT NULL,
  username VARCHAR(50) NOT NULL DEFAULT '',
  data_source_id VARCHAR(64) NOT NULL,
  name VARCHAR(100) NOT NULL DEFAULT '',
  interval_minutes INT NOT NULL DEFAULT 1440 COMMENT '巡检间隔（分钟）',
  status ENUM('ACTIVE','PAUSED') NOT NULL DEFAULT 'ACTIVE',
  next_run_at TIMESTAMP NULL DEFAULT NULL COMMENT '下次到期时间（NULL=立即到期）',
  last_run_at TIMESTAMP NULL DEFAULT NULL,
  last_run_status VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'ANOMALY/CLEAN/NO_DATA/ERROR',
  last_anomaly_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ap_due (status, next_run_at),
  INDEX idx_ap_ds (data_source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：anomaly_patrol_runs（server/anomalyPatrol.ts）
CREATE TABLE IF NOT EXISTS anomaly_patrol_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  patrol_id VARCHAR(64) NOT NULL,
  run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) NOT NULL,
  report_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '被扫描报表 ID',
  report_title VARCHAR(500) NOT NULL DEFAULT '',
  anomaly_count INT NOT NULL DEFAULT 0,
  high_count INT NOT NULL DEFAULT 0,
  anomalies_json MEDIUMTEXT NULL COMMENT '异常明细 Top10（AnomalyItem JSON）',
  error VARCHAR(500) NOT NULL DEFAULT '',
  INDEX idx_apr_patrol (patrol_id, run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 表：fallback_ab_tests（server/infra/createAbTestTable.ts）
CREATE TABLE IF NOT EXISTS fallback_ab_tests (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  experiment_id VARCHAR(64) NOT NULL UNIQUE COMMENT '实验 ID (UUID)',
  query TEXT NOT NULL COMMENT '原始用户查询',
  failed_sql VARCHAR(1024) NOT NULL COMMENT '失败的初始 SQL',
  assigned_group ENUM('A', 'B') NOT NULL COMMENT '分配组别：A=Rule-Based, B=Human Approval',
  selected_strategy VARCHAR(50) NOT NULL COMMENT '实际使用的策略',
  success TINYINT(1) DEFAULT 0 COMMENT '是否成功 (0/1)',
  latency_ms INT UNSIGNED DEFAULT 0 COMMENT '延迟 (毫秒)',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  
  INDEX idx_created_at (created_at),
  INDEX idx_assigned_group (assigned_group),
  INDEX idx_success (success),
  INDEX idx_experiment_id (experiment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='A/B Test 实验记录表 - 对比不同 fallback 策略的效果';

-- ────────────────────────────────────────────────────────────────────────────
-- 存量结构迁移（与 initSchema 的 migrateSchema 同步；判重后执行，可重复运行）
-- ────────────────────────────────────────────────────────────────────────────

-- users.must_change_password
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `users` ADD COLUMN `must_change_password` TINYINT(1) NOT NULL DEFAULT 0 AFTER status', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'must_change_password');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- users.department
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `users` ADD COLUMN `department` VARCHAR(100) NOT NULL DEFAULT '''' AFTER display_name', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'department');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- users.org_unit_id
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `users` ADD COLUMN `org_unit_id` INT NULL AFTER department', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'org_unit_id');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- data_sources.scope_json
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `data_sources` ADD COLUMN `scope_json` TEXT NULL AFTER schema_json', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'data_sources' AND COLUMN_NAME = 'scope_json');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- data_sources.allow_introspection
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `data_sources` ADD COLUMN `allow_introspection` TINYINT(1) NOT NULL DEFAULT 0 AFTER status', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'data_sources' AND COLUMN_NAME = 'allow_introspection');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- data_sources.acl_json
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `data_sources` ADD COLUMN `acl_json` TEXT NULL AFTER scope_json', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'data_sources' AND COLUMN_NAME = 'acl_json');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- query_audit_log.executed_sql
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `query_audit_log` ADD COLUMN `executed_sql` VARCHAR(2000) NOT NULL DEFAULT '''' AFTER detail', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'query_audit_log' AND COLUMN_NAME = 'executed_sql');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- query_audit_log.row_count
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `query_audit_log` ADD COLUMN `row_count` INT NOT NULL DEFAULT -1 AFTER executed_sql', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'query_audit_log' AND COLUMN_NAME = 'row_count');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- sql_examples.embedding
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `sql_examples` ADD COLUMN `embedding` TEXT NULL AFTER created_by', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sql_examples' AND COLUMN_NAME = 'embedding');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- metric_definitions.version
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `metric_definitions` ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER status', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'version');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- metric_definitions.approved_by
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `metric_definitions` ADD COLUMN `approved_by` VARCHAR(50) NOT NULL DEFAULT '''' AFTER version', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'approved_by');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- metric_definitions.approved_at
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `metric_definitions` ADD COLUMN `approved_at` TIMESTAMP NULL DEFAULT NULL AFTER approved_by', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'approved_at');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- metric_definitions.dimensions_json
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `metric_definitions` ADD COLUMN `dimensions_json` VARCHAR(600) NOT NULL DEFAULT ''[]'' AFTER filters', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'metric_definitions' AND COLUMN_NAME = 'dimensions_json');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- expert_personas.content_version
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `expert_personas` ADD COLUMN `content_version` INT NOT NULL DEFAULT 1 AFTER created_by', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'expert_personas' AND COLUMN_NAME = 'content_version');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- llm_usage.user_id
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `llm_usage` ADD COLUMN `user_id` INT NULL AFTER channel', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_usage' AND COLUMN_NAME = 'user_id');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- llm_usage.username
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `llm_usage` ADD COLUMN `username` VARCHAR(64) NULL AFTER user_id', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_usage' AND COLUMN_NAME = 'username');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- query_audit_log.fallback_latency_ms
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `query_audit_log` ADD COLUMN `fallback_latency_ms` INT NULL AFTER duration_ms', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'query_audit_log' AND COLUMN_NAME = 'fallback_latency_ms');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- query_audit_log.fallback_strategy
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `query_audit_log` ADD COLUMN `fallback_strategy` VARCHAR(30) NULL AFTER fallback_latency_ms', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'query_audit_log' AND COLUMN_NAME = 'fallback_strategy');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- data_sources.anomaly_capabilities_json
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `data_sources` ADD COLUMN `anomaly_capabilities_json` TEXT NULL AFTER acl_json', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'data_sources' AND COLUMN_NAME = 'anomaly_capabilities_json');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- data_sources.anomaly_thresholds_json
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `data_sources` ADD COLUMN `anomaly_thresholds_json` TEXT NULL AFTER anomaly_capabilities_json', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'data_sources' AND COLUMN_NAME = 'anomaly_thresholds_json');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- flex_queries.version
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `flex_queries` ADD COLUMN `version` INT NOT NULL DEFAULT 1 AFTER query_data', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flex_queries' AND COLUMN_NAME = 'version');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- flex_queries.use_count
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `flex_queries` ADD COLUMN `use_count` INT NOT NULL DEFAULT 0 AFTER version', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flex_queries' AND COLUMN_NAME = 'use_count');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- flex_queries.last_used_at
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `flex_queries` ADD COLUMN `last_used_at` TIMESTAMP NULL AFTER use_count', 'DO 0') FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'flex_queries' AND COLUMN_NAME = 'last_used_at');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- llm_usage.idx_llm_usage_user
SET @schema_sql = (SELECT IF(COUNT(*) = 0, 'ALTER TABLE `llm_usage` ADD INDEX `idx_llm_usage_user` (user_id)', 'DO 0') FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_usage' AND INDEX_NAME = 'idx_llm_usage_user');
PREPARE schema_stmt FROM @schema_sql; EXECUTE schema_stmt; DEALLOCATE PREPARE schema_stmt;

-- MODIFY（天然幂等）：conversation_history
ALTER TABLE conversation_history MODIFY COLUMN status ENUM('SUCCESS','FALLBACK','REFUSED') NOT NULL DEFAULT 'SUCCESS';

-- MODIFY（天然幂等）：metric_definitions
ALTER TABLE metric_definitions MODIFY COLUMN status ENUM('ACTIVE','DISABLED','PENDING','REJECTED') NOT NULL DEFAULT 'PENDING';

-- MODIFY（天然幂等）：expert_personas
ALTER TABLE expert_personas MODIFY COLUMN role_prompt VARCHAR(2000) NOT NULL;

-- MODIFY（天然幂等）：iron_rules
ALTER TABLE iron_rules MODIFY COLUMN status ENUM('ACTIVE','DISABLED','PENDING') NOT NULL DEFAULT 'ACTIVE';

-- MODIFY（天然幂等）：async_tasks
ALTER TABLE async_tasks MODIFY COLUMN id VARCHAR(48) NOT NULL;

-- 结束：结构应与 initSchema() 启动后的 information_schema 保持一致。
-- 提示：执行后重启应用，确认日志出现「[DB] MySQL ready」且无迁移告警。
