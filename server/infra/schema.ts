/**
 * 持久化层 - 结构定义（质量优化 Stage 3.1 四拆分之 schema.ts）：
 * 全部建表（CREATE TABLE IF NOT EXISTS）与幂等结构变更（ALTER ... MODIFY）DDL。
 * 由 db.ts 的 initSchema 在连接池就绪后调用；初始种子见 seed.ts，存量结构迁移见 migration.ts。
 */
import mysql from 'mysql2/promise';
import { ensureTaskTable } from './taskQueue';

/** 建表与结构定义（全量幂等；存量库已存在的表为空操作） */
export async function createSchema(pool: mysql.Pool): Promise<void> {
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

  // 组织架构树：总部→机构→部门→团队四级单表自关联（层级合法性由服务端强校验，见 routes/orgUnits.ts）。
  // data_code 为该节点在业务数据中的取值（机构编号如 AH、团队名如「投资一部」），供与业务口径对齐。
  await pool.query(`
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

  // P2-11 权限申请审批流：用户申请数据源访问权 → ADMIN 审批 → 通过自动并入该数据源 acl_json.userIds
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // P2-12 DLP 下载审批：超阈值 CSV 导出需 ADMIN 审批（一次性授权，导出成功后转 CONSUMED）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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
      status ENUM('SUCCESS','FALLBACK','REFUSED') NOT NULL DEFAULT 'SUCCESS',
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

  // P3-1 业务知识库完整版：存储完整知识条目（标题、内容、标签、分类）供前端展示和导入导出
  await pool.query(`
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

  // v0.5.0 智能问数报告模式：报告模板表（预设模板 + 用户自定义模板）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // v0.5.0 智能问数报告模式：智能问数报告记录表（对话生成的报告）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // v0.9.23 可视化决策报表服务端持久化：历史报表从浏览器 localStorage 迁至 MySQL（跨设备/清理缓存不丢失）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // v0.9.24 决策数据看板固化图表服务端持久化（团队共享巡检屏，sort_order 支撑拖拽排序）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // v0.9.24 灵活查询固定报表服务端持久化（团队共享查询模板）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flex_queries (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      query_id VARCHAR(64) NOT NULL UNIQUE COMMENT '固定报表唯一标识（前端生成 flex-{timestamp}）',
      user_id INT NOT NULL,
      username VARCHAR(50) NOT NULL,
      data_source_id VARCHAR(64) NOT NULL DEFAULT '',
      query_data MEDIUMTEXT NOT NULL COMMENT '完整 SavedFlexQuery JSON（含 FlexQueryConfig 与图表类型）',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_fq_ds (data_source_id),
      INDEX idx_fq_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // v0.9.24 灵活查询最近历史服务端持久化（个人行为记录，一行 per 用户整组替换，上限 8 条）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flex_query_history (
      user_id INT PRIMARY KEY,
      history_data MEDIUMTEXT NOT NULL COMMENT 'FlexHistoryItem JSON 数组（按配置去重、上限 8 条）',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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

  // P1-8 指标版本历史：每次创建/审批生效/变更/回滚留快照，支撑版本回溯与审计
  await pool.query(`
    CREATE TABLE IF NOT EXISTS metric_versions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      metric_id BIGINT NOT NULL,
      version INT NOT NULL,
      snapshot_json TEXT NOT NULL,
      action VARCHAR(20) NOT NULL,
      actor VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_metric_versions_metric (metric_id, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 铁律规则库（v0.9.35）：管理员按数据源登记的问数强制规则（口径红线/禁区/固定约束），
  // 全部 ACTIVE 规则恒注入问数/报表阶段一 prompt（最高优先级逐条遵守）；仅 ADMIN 维护，创建即生效
  await pool.query(`
    CREATE TABLE IF NOT EXISTS iron_rules (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      data_source_id VARCHAR(64) NOT NULL,
      title VARCHAR(100) NOT NULL,
      content VARCHAR(2000) NOT NULL,
      status ENUM('ACTIVE','DISABLED') NOT NULL DEFAULT 'ACTIVE',
      created_by VARCHAR(50) NOT NULL DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_iron_ds_title (data_source_id, title),
      INDEX idx_iron_ds_status (data_source_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 问数专家角色库（v0.9.40）：阶段二解读的 persona 路由配置（角色标签/触发关键词/rolePrompt）。
  // 内置 5 角色（risk/customer/finance/npl/default）启动时播种，可编辑不可删除；
  // default 为路由兜底（不参与关键词匹配），禁禁用禁删。仅 ADMIN 维护。
  // v0.9.43：role_prompt 扩容至 2000（内置角色升级为完整分析框架提示词）；content_version 标记内置内容版本
  await pool.query(`
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

  // v0.9.2 长任务队列表（改进计划 2-1）：报告生成/问数报告/PDF 导出异步执行
  await ensureTaskTable(pool);

  // P2-15 Fallback 对抗训练：NL2SQL 失败样本自动收集与人工标注（adversarial_samples 表）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT 'NL2SQL 困难样本库，用于对抗训练'
  `);

  // P2-15 Fallback 对抗训练：fallback 审计日志表（记录策略使用统计、响应延迟等指标）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT 'Fallback 机制审计日志'
  `);

  // P0 对抗训练闭环（v0.9.47）：Few-Shot 示例库——管理员采纳的困难样本单独建表，
  // 不再写入 knowledge_base（v0.9.45 的 INSERT 与该表真实列结构不匹配，且会污染业务知识 RAG 检索）
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT 'Few-Shot 示例库（对抗训练闭环）'
  `);

  // v0.9.8 知识库漂移检测（改进计划 3-3）：低基数维度列取值快照 + 漂移事件
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_drift_watch (
      data_source_id VARCHAR(64) NOT NULL,
      table_name VARCHAR(128) NOT NULL,
      column_name VARCHAR(128) NOT NULL,
      values_json MEDIUMTEXT NULL,
      snapshot_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (data_source_id, table_name, column_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // v0.9.61 环境配置在线化：env_config 建表自动化（v0.5.0 起原为手工 SQL 创建，新部署无表导致面板 500）。
  // key/value 为 MySQL 保留字须加反引号（v0.5.0 经验：MySQL 9.x 裸列名报语法错误）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS env_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      \`key\` VARCHAR(100) NOT NULL,
      \`value\` TEXT NOT NULL,
      category VARCHAR(50) DEFAULT 'system',
      description TEXT,
      is_sensitive TINYINT(1) DEFAULT 0,
      updated_by INT DEFAULT NULL,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_key (\`key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

}
