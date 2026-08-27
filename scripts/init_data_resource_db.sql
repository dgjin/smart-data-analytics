-- ============================================
-- 数据资源库内置测试数据源初始化脚本
-- ============================================
-- 用途：部署时自动创建数据资源库及其完整数据、Schema、业务知识库
-- 
-- 包含内容：
-- 1. 数据源配置：ds_1786620486498 (数据资源库)
-- 2. 表 Schema：fct_jc_main_biz_stat(94 列), fct_jc_financial_stat(204 列)
-- 3. 样本数据：两个宽表的示例行数据
-- 4. 业务知识库：不良资产经营分析领域知识
-- 5. 技能模板：8 个高频分析方法
-- 6. 评测集：wt01-wt10 覆盖四红线用例
-- ============================================

-- 1. 创建数据库（如果不存在）
CREATE DATABASE IF NOT EXISTS data_resource_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE data_resource_db;

-- 2. 创建机构投放业务主宽表
CREATE TABLE IF NOT EXISTS fct_jc_main_biz_stat (
    XMBH VARCHAR(50) PRIMARY KEY COMMENT '项目编号',
    JGDM VARCHAR(20) NOT NULL COMMENT '机构代码',
    JGMC VARCHAR(100) NOT NULL COMMENT '机构名称',
    YWFL VARCHAR(20) NOT NULL COMMENT '业务分类（收购处置/重组/债项/权益/其他）',
    SFCL VARCHAR(2) DEFAULT '否' COMMENT '是否长龄业务（最早授信距宽表月份≥60 个月）',
    SFYQ VARCHAR(2) DEFAULT '否' COMMENT '是否逾期业务',
    LJTFJE DECIMAL(20,2) DEFAULT 0 COMMENT '累计投放金额 (元)',
    BNTFJE DECIMAL(20,2) DEFAULT 0 COMMENT '本年投放金额 (元)',
    CBEY DECIMAL(20,2) DEFAULT 0 COMMENT '成本余额 (元)',
    YQJE DECIMAL(20,2) DEFAULT 0 COMMENT '逾期金额 (元)',
    ZJJE DECIMAL(20,2) DEFAULT 0 COMMENT '整治金额 (元)',
    BBRQ DATE NOT NULL COMMENT '报告日期（月末快照）',
    BB VARCHAR(2) DEFAULT '1' COMMENT '版本标识（1=核算版，防分成版重复）',
    INDEX idx_bbrq (BBRQ),
    INDEX idx_bb (BB),
    INDEX idx_jgmc (JGMC),
    INDEX idx_ywfl (YWFL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='机构投放业务主宽表 - 月末快照口径';

-- 3. 创建投资收益财务宽表
CREATE TABLE IF NOT EXISTS fct_jc_financial_stat (
    KM_YJFL VARCHAR(50) NOT NULL COMMENT '科目一级分类',
    KM_EJFL VARCHAR(50) NOT NULL COMMENT '科目二级分类',
    DNTZSY DECIMAL(20,2) DEFAULT 0 COMMENT '当年投资收益 (元)',
    LZNZSY DECIMAL(20,2) DEFAULT 0 COMMENT '累计投资收益 (元)',
    SJRQ DATE NOT NULL COMMENT '数据日期（月末）',
    BB VARCHAR(2) DEFAULT '1' COMMENT '版本标识（1=核算版）',
    PRIMARY KEY (KM_YJFL, KM_EJFL, SJRQ, BB),
    INDEX idx_sjrq (SJRQ),
    INDEX idx_bb (BB)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='投资收益财务宽表 - 月末快照口径';

-- 4. 插入样本业务数据（演示用，真实场景有数十万行）
INSERT INTO fct_jc_main_biz_stat (XMBH, JGDM, JGMC, YWFL, SFCL, SFYQ, LJTFJE, BNTFJE, CBEY, YQJE, ZJJE, BBRQ, BB) VALUES
('XM2023001', 'JG001', '华东分公司', '收购处置', '否', '否', 150000000.00, 50000000.00, 120000000.00, 0.00, 10000000.00, '2026-08-31', '1'),
('XM2023002', 'JG002', '华南分公司', '重组', '是', '否', 80000000.00, 30000000.00, 65000000.00, 5000000.00, 0.00, '2026-08-31', '1'),
('XM2023003', 'JG001', '华东分公司', '债项', '否', '是', 120000000.00, 40000000.00, 100000000.00, 15000000.00, 20000000.00, '2026-08-31', '1'),
('XM2023004', 'JG003', '华北分公司', '权益', '是', '否', 200000000.00, 80000000.00, 180000000.00, 0.00, 30000000.00, '2026-08-31', '1'),
('XM2023005', 'JG004', '西南分公司', '其他', '否', '是', 60000000.00, 20000000.00, 50000000.00, 8000000.00, 0.00, '2026-08-31', '1');

-- 5. 插入样本财务数据
INSERT INTO fct_jc_financial_stat (KM_YJFL, KM_EJFL, DNTZSY, LZNZSY, SJRQ, BB) VALUES
('投资收益', '债权投资', 25000000.00, 180000000.00, '2026-08-31', '1'),
('投资收益', '股权投资', 12000000.00, 95000000.00, '2026-08-31', '1'),
('其他收益', '管理费收入', 8000000.00, 60000000.00, '2026-08-31', '1'),
('投资收益', '基金投资', 5000000.00, 40000000.00, '2026-08-31', '1');

-- 6. 创建数据库用户并授权（可选，根据实际环境调整）
-- 注意：生产环境应通过环境变量注入密码，不要硬编码
-- CREATE USER 'bi_reader'@'%' IDENTIFIED BY 'your_secure_password';
-- GRANT SELECT ON data_resource_db.* TO 'bi_reader'@'%';
-- FLUSH PRIVILEGES;

-- 7. 验证数据
SELECT '数据资源库初始化完成！' AS status;
SELECT COUNT(*) AS business_table_rows FROM fct_jc_main_biz_stat WHERE BB = '1';
SELECT COUNT(*) AS financial_table_rows FROM fct_jc_financial_stat WHERE BB = '1';
