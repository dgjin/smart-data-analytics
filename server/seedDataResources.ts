/**
 * 数据资源库内置测试数据源初始化脚本
 * 用途：部署时自动创建数据资源库及其完整数据、Schema、业务知识库
 * 
 * 包含内容：
 * 1. 数据源配置：ds_1786620486498 (数据资源库)
 * 2. 表 Schema：fct_jc_main_biz_stat(94 列), fct_jc_financial_stat(204 列)
 * 3. 样本数据：两个宽表的示例行数据
 * 4. 业务知识库：不良资产经营分析领域知识
 * 5. 技能模板：8 个高频分析方法
 * 6. 评测集：wt01-wt10 覆盖四红线用例
 */

import { DataSource, TableSchema } from '../src/types/analytics';

// ============ 数据源配置 ============
export const DATA_RESOURCE_DS_ID = 'ds_1786620486498';

export const DATA_RESOURCE_DS: DataSource = {
  id: DATA_RESOURCE_DS_ID,
  name: '数据资源库',
  type: 'mysql',
  status: 'connected',
  config: {
    host: process.env.DATA_RESOURCE_HOST || '10.10.60.105',
    port: parseInt(process.env.DATA_RESOURCE_PORT || '3306'),
    database: process.env.DATA_RESOURCE_DB || 'data_resource_db',
    username: process.env.DATA_RESOURCE_USER || 'bi_reader',
    password: process.env.DATA_RESOURCE_PASS || '', // 实际部署时需通过环境变量注入
  },
  tables: [FCT_JC_MAIN_BIZ_STAT_SCHEMA, FCT_JC_FINANCIAL_STAT_SCHEMA],
  lastSyncedAt: new Date().toISOString(),
};

// ============ 表 Schema 定义 ============

/**
 * fct_jc_main_biz_stat - 机构投放业务主宽表
 * 94 列，BBRQ 报告日期月末快照，BB='1'核算版防分成版重复
 */
export const FCT_JC_MAIN_BIZ_STAT_SCHEMA: TableSchema = {
  id: 'fct_jc_main_biz_stat',
  name: 'fct_jc_main_biz_stat',
  displayName: '机构投放业务主宽表',
  description: '不良资产业务投放主宽表，月末快照口径，包含项目全量经营信息（核算版 BB=1）',
  rowCount: 28500,
  columns: [
    { name: 'XMBH', type: 'string', description: '项目编号', isPrimaryKey: true, isDimension: true },
    { name: 'JGDM', type: 'string', description: '机构代码', isDimension: true },
    { name: 'JGMC', type: 'string', description: '机构名称', isDimension: true },
    { name: 'YWFL', type: 'category', description: '业务分类（收购处置/重组/债项/权益/其他）', isDimension: true },
    { name: 'SFCL', type: 'boolean', description: '是否长龄业务（最早授信距宽表月份≥60 个月）', isDimension: true },
    { name: 'SFYQ', type: 'boolean', description: '是否逾期业务', isDimension: true },
    { name: 'LJTFJE', type: 'number', description: '累计投放金额 (元)', isMetric: true },
    { name: 'BNTFJE', type: 'number', description: '本年投放金额 (元)', isMetric: true },
    { name: 'CBEY', type: 'number', description: '成本余额 (元)', isMetric: true },
    { name: 'YQJE', type: 'number', description: '逾期金额 (元)', isMetric: true },
    { name: 'ZJJE', type: 'number', description: '整治金额 (元)', isMetric: true },
    { name: 'XMBH_COUNT', type: 'number', description: '项目数（去重计数）', isMetric: true },
    { name: 'BBRQ', type: 'date', description: '报告日期（月末快照）', isDimension: true, isPartition: true },
    { name: 'SJRQ', type: 'date', description: '数据日期（财务表专用）', isDimension: true, isPartition: true },
    { name: 'BB', type: 'category', description: "版本标识（'1'=核算版，防重复）", isDimension: true, isFilter: true },
  ],
};

/**
 * fct_jc_financial_stat - 投资收益财务宽表
 * 204 列，SJRQ 数据日期月末快照，BB='1'核算版
 */
export const FCT_JC_FINANCIAL_STAT_SCHEMA: TableSchema = {
  id: 'fct_jc_financial_stat',
  name: 'fct_jc_financial_stat',
  displayName: '投资收益财务宽表',
  description: '投资收益财务宽表，月末快照口径，按科目一级分类统计当年/累计收益（核算版 BB=1）',
  rowCount: 12600,
  columns: [
    { name: 'KM_YJFL', type: 'category', description: '科目一级分类', isDimension: true },
    { name: 'KM_EJFL', type: 'category', description: '科目二级分类', isDimension: true },
    { name: 'DNTZSY', type: 'number', description: '当年投资收益 (元)', isMetric: true },
    { name: 'LZNZSY', type: 'number', description: '累计投资收益 (元)', isMetric: true },
    { name: 'SJRQ', type: 'date', description: '数据日期（月末）', isDimension: true, isPartition: true },
    { name: 'BB', type: 'category', description: "版本标识（'1'=核算版）", isDimension: true, isFilter: true },
  ],
};

// ============ 样本数据（用于 Schema 发现演示） ============

export const SAMPLE_FCT_JC_MAIN_BIZ_DATA = [
  {
    XMBH: 'XM2023001',
    JGDM: 'JG001',
    JGMC: '华东分公司',
    YWFL: '收购处置',
    SFCL: false,
    SFYQ: false,
    LJTFJE: 150000000,
    BNTFJE: 50000000,
    CBEY: 120000000,
    YQJE: 0,
    ZJJE: 10000000,
    XMBH_COUNT: 1,
    BBRQ: '2026-08-31',
    BB: '1',
  },
  {
    XMBH: 'XM2023002',
    JGDM: 'JG002',
    JGMC: '华南分公司',
    YWFL: '重组',
    SFCL: true,
    SFYQ: false,
    LJTFJE: 80000000,
    BNTFJE: 30000000,
    CBEY: 65000000,
    YQJE: 5000000,
    ZJJE: 0,
    XMBH_COUNT: 1,
    BBRQ: '2026-08-31',
    BB: '1',
  },
  {
    XMBH: 'XM2023003',
    JGDM: 'JG001',
    JGMC: '华东分公司',
    YWFL: '债项',
    SFCL: false,
    SFYQ: true,
    LJTFJE: 120000000,
    BNTFJE: 40000000,
    CBEY: 100000000,
    YQJE: 15000000,
    ZJJE: 20000000,
    XMBH_COUNT: 1,
    BBRQ: '2026-08-31',
    BB: '1',
  },
];

export const SAMPLE_FCT_JC_FINANCIAL_DATA = [
  {
    KM_YJFL: '投资收益',
    KM_EJFL: '债权投资',
    DNTZSY: 25000000,
    LZNZSY: 180000000,
    SJRQ: '2026-08-31',
    BB: '1',
  },
  {
    KM_YJFL: '投资收益',
    KM_EJFL: '股权投资',
    DNTZSY: 12000000,
    LZNZSY: 95000000,
    SJRQ: '2026-08-31',
    BB: '1',
  },
  {
    KM_YJFL: '其他收益',
    KM_EJFL: '管理费收入',
    DNTZSY: 8000000,
    LZNZSY: 60000000,
    SJRQ: '2026-08-31',
    BB: '1',
  },
];

// ============ 业务知识库（完整版） ============

export const DATA_RESOURCE_KNOWLEDGE_BASE = [
  {
    id: 'kb_001',
    title: '数据资源库核心概念与口径',
    content: `## 一、数据资源库概述
  
数据资源库是资产管理公司不良资产经营的核心业务数据库，采用宽表模型设计，包含：
- **机构投放业务主宽表** (fct_jc_main_biz_stat)：94 列，覆盖项目全量经营信息
- **投资收益财务宽表** (fct_jc_financial_stat)：204 列，科目级财务收益明细

**数据特点：**
- 月度快照口径：每个月末时点的静态快照
- 核算版优先：BB='1'为经过财务核算确认的最终数据
- 月末封闭性：不跨月累加，每月独立统计

---

## 二、版本标识 BB 字段深度解析

### BB 字段的业务含义
```sql
BB = '1'  -- 核算版（正式数据，唯一可信源）
BB = '2'  -- 分成版（中间版本，仅用于机构维度分析，不可汇总）
BB = '0'  -- 草稿版（未审核，禁止参与任何统计）
```

### 为什么必须过滤 BB='1'？
分成版数据的分摊逻辑：
- 一个项目在不同机构间分摊记录
- 各机构版本的金额之和 > 实际总额
- 示例：某项目总投放 1 亿，分成版在华东/华南分别记 6000 万 +5000 万=1.1 亿（虚增 10%）

**四红线 R2：所有查询强制添加 WHERE BB = '1'**

---

## 三、月末快照口径详解

### BBRQ vs SJRQ 的区别
| 字段 | 表名 | 含义 | 用途 | 注意事项 |
|------|------|------|------|----------|
| BBRQ | fct_jc_main_biz_stat | 报告日期 | 业务投放统计 | 月末最后交易日 |
| SJRQ | fct_jc_financial_stat | 数据日期 | 财务收益统计 | 月末最后一个工作日 |

### 月末快照的核心特性
1. **静态性**：反映某一时点的状态，非期间累计值
2. **独立性**：当月数据不包含上月余额，需自行计算环比/同比
3. **完整性**：包含截至该月末的所有历史沉淀信息

### 正确获取最新数据的方法
```sql
-- ✅ 推荐：子查询锁定 MAX 快照期
SELECT * FROM fct_jc_main_biz_stat 
WHERE BB = '1' 
  AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')

-- ❌ 错误：直接用日期范围
SELECT * FROM fct_jc_main_biz_stat 
WHERE BB = '1' AND BBRQ >= '2026-07-01'

-- 原因：月度间可能存在空档期（如节假日导致报告延迟），会漏掉真实最新月份或包含非月末数据
```

---

## 四、关键指标口径规范

### 1. 项目数统计（五红线 R3）
```sql
-- ✅ 正确：去重计数
SELECT COUNT(DISTINCT XMBH) AS project_count FROM fct_jc_main_biz_stat WHERE BB = '1'

-- ❌ 错误：直接计数
SELECT COUNT(XMBH) FROM fct_jc_main_biz_stat WHERE BB = '1'

-- 原因：同一项目编号可能在多张明细表中有对应记录（如多次投放），直接计数会重复
```

### 2. 长龄业务判定（SFCL 字段）
**定义**：最早授信日期距当前宽表月份 ≥ 60 个月（5 年）

**业务意义**：
- 衡量资产老化程度
- 长龄化比例越高，清收难度越大
- 通常作为绩效考核关键指标

**查询示例**：
```sql
SELECT 
  JGMC,
  COUNT(*) AS long_age_count,
  ROUND(COUNT(*) * 1.0 / SUM(COUNT(*)) OVER(), 4) AS ratio
FROM fct_jc_main_biz_stat
WHERE SFCL = '是' AND BB = '1'
GROUP BY JGMC
ORDER BY ratio DESC
```

### 3. 逾期业务判定（SFYQ 字段）
**定义**：超过合同约定还款期限未收回

**重点关注维度**：
- 逾期金额占比：YQJE / SUM(LJTFJE)
- 逾期笔数占比：COUNT(SFYQ='是') / TOTAL_COUNT
- 逾期集中度：前 10 机构逾期金额占比

---

## 五、时间序列查询陷阱

### 常见错误场景
```sql
-- ❌ 陷阱 1：混用两个日期字段
SELECT SUM(b.BNTFJE), SUM(f.DNTZSY)
FROM fct_jc_main_biz_stat b
JOIN fct_jc_financial_stat f ON b.BBRQ = f.SJRQ
-- 结果：错误的关联匹配（两个表日期口径不一致）

-- ❌ 陷阱 2：跨月累加投放金额
SELECT SUM(BNTFJE) FROM fct_jc_main_biz_stat WHERE BBRQ IN ('2026-07-31', '2026-08-31')
-- 结果：重复计算（每月快照包含上月全部余额）

-- ✅ 正确：按月独立统计
SELECT BBRQ, SUM(BNTFJE)
FROM fct_jc_main_biz_stat 
WHERE BB = '1'
GROUP BY BBRQ
```

---

## 六、数据库 Schema 速查

### fct_jc_main_biz_stat（业务主宽表）
- **行数**：约 28,500 条项目记录
- **列数**：94 列
- **主键**：XMBH（项目编号）
- **分区键**：BBRQ（报告日期）
- **核心字段**：XMBH, JGMC, YWFL, SFCL, SFYQ, LJTFJE, BNTFJE, CBEY, YQJE, ZJJE, BBRQ, BB

### fct_jc_financial_stat（财务宽表）
- **行数**：约 12,600 条记录
- **列数**：204 列
- **主键**：KM_YJFL + KM_EJFL + SJRQ + BB
- **分区键**：SJRQ（数据日期）
- **核心字段**：KM_YJFL, KM_EJFL, DNTZSY, LZNZSY, SJRQ, BB

`,
    tags: ['口径', '核算版', '月末快照', '四红线', '宽表模型'],
    category: '基础概念',
  },
  
  {
    id: 'kb_002',
    title: '四红线规则与最佳实践',
    content: `## 四红线强制约束

数据资源库 NL2SQL 生成时必须严格遵守以下四红线规则，否则会导致结果严重错误。

---

### 🔴 R1: 最新快照期锁定

**典型场景**：用户提问"数据资源库的累计投放金额是多少？"（隐含最新一期）

#### 错误写法
```sql
-- ❌ 遗漏子查询
SELECT SUM(LJTFJE) FROM fct_jc_main_biz_stat WHERE BB = '1'
-- 结果：跨月累加，金额虚高（把过去 12 个月的数据都加了）

-- ❌ 错误使用日期范围
SELECT SUM(LJTFJE) FROM fct_jc_main_biz_stat 
WHERE BB = '1' AND BBRQ > '2026-01-01'
-- 结果：包含多个非月末时点数据，统计口径混乱
```

#### 正确写法
```sql
-- ✅ 标准模板
SELECT SUM(LJTFJE) AS total_amount
FROM fct_jc_main_biz_stat 
WHERE BB = '1' 
  AND BBRQ = (
    SELECT MAX(BBRQ) 
    FROM fct_jc_main_biz_stat 
    WHERE BB = '1'
  )
```

**技术原理**：
- 子查询先确定最新月末 BBRQ（如 '2026-08-31'）
- 外层查询只取该时点的快照数据
- 确保单月统计，避免跨月累加

---

### 🔴 R2: 核算版过滤

#### 为什么分成版不能汇总？
```
项目 XM2023001：实际投放 1 亿元

分成版记录：
- 华东分公司：6000 万
- 华南分公司：5000 万
- 华北分公司：3000 万
合计：1.4 亿元（虚增 40%）
```

#### 错误示例
```sql
-- ❌ 遗漏 BB 过滤
SELECT JGMC, SUM(BNTFJE)
FROM fct_jc_main_biz_stat
GROUP BY JGMC
-- 结果：各机构金额之和 > 实际总额，机构排名失真

-- ❌ 错误过滤条件
SELECT SUM(LJTFJE) FROM fct_jc_main_biz_stat WHERE BB != '1'
-- 结果：统计的是分成版数据，金额虚高
```

#### 正确做法
```sql
-- ✅ 所有查询必带 BB='1'
SELECT JGMC, SUM(BNTFJE) AS annual_put
FROM fct_jc_main_biz_stat
WHERE BB = '1'
GROUP BY JGMC
ORDER BY annual_put DESC
```

---

### 🔴 R3: 项目数去重计数

#### 为什么要 COUNT DISTINCT？
一个项目编号可能在以下情况出现多次：
1. 同一项目的多笔投放记录
2. 跨机构的联合投放
3. 历史沿革中的调整记录

#### 错误写法
```sql
-- ❌ 直接计数
SELECT COUNT(XMBH) AS project_count
FROM fct_jc_main_biz_stat WHERE BB = '1'
-- 结果：可能达到实际项目数的 1.5-2 倍

-- ❌ 忽略 DISTINCT
SELECT COUNT(*) FROM fct_jc_main_biz_stat WHERE BB = '1'
-- 结果：完全错误的统计口径
```

#### 正确写法
```sql
-- ✅ 去重计数
SELECT COUNT(DISTINCT XMBH) AS unique_project_count
FROM fct_jc_main_biz_stat WHERE BB = '1'

-- ✅ 结合分组统计
SELECT JGMC, COUNT(DISTINCT XMBH) AS proj_count
FROM fct_jc_main_biz_stat
WHERE BB = '1'
GROUP BY JGMC
```

---

### 🔴 R4: 财务指标走财务表

#### 业务表 vs 财务表的分工
| 表名 | 主要用途 | 财务相关字段 | 精确度 |
|------|---------|-------------|--------|
| fct_jc_main_biz_stat | 业务投放统计 | LJTFJE/BNTFJE/CBEY | 业务口径估算值 |
| fct_jc_financial_stat | 财务收益核算 | DNTZSY/LZNZSY | 财务核算精确值 |

#### 错误用法
```sql
-- ❌ 从业务表查询投资收益
SELECT SUM(LJTFJE) FROM fct_jc_main_biz_stat
-- 这是投放金额，不是投资收益！

-- ❌ 混淆概念
SELECT LJTFJE AS investment_income FROM fct_jc_main_biz_stat
-- 字段含义错误
```

#### 正确做法
```sql
-- ✅ 投资收益必须查财务表
SELECT 
  KM_YJFL,
  SUM(DNTZSY) AS current_year_income,
  SUM(LZNZSY) AS cumulative_income
FROM fct_jc_financial_stat
WHERE BB = '1'
  AND SJRQ = (SELECT MAX(SJRQ) FROM fct_jc_financial_stat WHERE BB = '1')
GROUP BY KM_YJFL
```

---

## 📋 查询最佳实践清单

### ✅ 必做项
- [ ] 所有查询添加 `WHERE BB = '1'`
- [ ] 最新数据用 `MAX()` 子查询锁定快照期
- [ ] 项目数用 `COUNT(DISTINCT XMBH)`
- [ ] 财务指标查询财务宽表
- [ ] 不要混用 BBRQ 和 SJRQ 字段

### ❌ 禁止项
- [ ] 不使用 `COUNT(*)` 或 `COUNT(列名)` 统计项目数
- [ ] 不忽略 `BB` 过滤条件
- [ ] 不从业务表查询投资收益
- [ ] 不使用日期范围查询代替 MAX 子查询
- [ ] 不进行跨表 BBRQ/SJRQ 直接 JOIN

---

## 💡 常见问题解答

**Q1: 什么时候可以使用分成版数据？**
A: 仅限机构维度对比分析（如"华东 vs 华南哪个机构长龄化比例更高"），绝对不能用于汇总统计。

**Q2: 如何判断是否漏掉了最新月份？**
A: 检查 MAX(BBRQ) 与实际查询结果的日期是否一致，如有差异说明有月份空档。

**Q3: 为什么不能用 SUM(LJTFJE) 代替投资收益？**
A: LJTFJE 是"累计投放金额"（成本投入），投资收益是"DNTZSY"（回报收益），两者性质完全不同。

`,
    tags: ['红线', '校验', '最佳实践', '四红线'],
    category: '技术规范',
  },
  
  {
    id: 'kb_003',
    title: '不良资产经营分析术语词典',
    content: `## 核心术语解释

### 投放类指标

#### 累计投放金额 (LJTFJE)
- **定义**：从项目启动至今全部投放资金总和
- **单位**：元
- **业务意义**：反映累计投入规模，衡量资金占用总量
- **查询注意**：月末快照口径，需用 MAX 子查询锁定最新时点
- **示例**：某项目累计投放 1.5 亿元（含已回收 + 未回收）

#### 本年投放金额 (BNTFJE)
- **定义**：当年内的新增投放金额
- **单位**：元
- **业务意义**：反映年度投放力度，考核当年业务拓展能力
- **时间范围**：自然年（1 月 1 日 -12 月 31 日）
- **示例**：2026 年华东分公司本年投放 5000 万元

#### 成本余额 (CBEY)
- **定义**：当前账面上尚未收回的成本本金
- **单位**：元
- **业务意义**：反映风险敞口，待回收的资金存量
- **计算公式**：累计投放 - 累计回收 = 成本余额
- **示例**：某项目成本余额 8000 万，表示还有 8000 万未收回

---

### 余额类指标

#### 逾期金额 (YQJE)
- **定义**：超过合同约定还款期限未收回的金额
- **单位**：元
- **业务意义**：直接风险暴露，需立即关注并制定清收计划
- **分级管理**：
  - YQJE < 100 万：一般逾期
  - 100 万 ≤ YQJE < 500 万：较大逾期
  - YQJE ≥ 500 万：重大逾期
- **示例**：华东分公司逾期金额 1500 万元

#### 整治金额 (ZJJE)
- **定义**：正在通过重组、转让、核销等方式处置的金额
- **单位**：元
- **业务意义**：反映清收处置进度，已启动但未完结的项目规模
- **处置方式**：债务重组、资产转让、诉讼清收、核销
- **示例**：某项目正处于债务重组阶段，涉及金额 3000 万元

---

### 业务属性字段

#### 长龄业务 (SFCL)
- **定义**：最早授信日期距当前宽表月份 ≥ 60 个月（5 年）
- **类型**：布尔值（是/否）
- **业务意义**：
  - 衡量资产老化程度
  - 长龄化比例越高，清收难度越大
  - 通常作为绩效考核关键指标
- **行业经验**：
  - 长龄化率 < 20%：健康水平
  - 20%-40%：需加强清收
  - > 40%：严重老化，需专项处置
- **示例**：某项目最早授信 2020 年 1 月，当前 2026 年 8 月，跨度 85 个月 > 60 个月，标记为长龄业务

#### 逾期业务 (SFYQ)
- **定义**：超过合同约定还款期限未收回
- **类型**：布尔值（是/否）
- **业务意义**：
  - 直接风险信号
  - 触发预警机制
  - 影响机构评级
- **处理流程**：识别→上报→制定清收方案→执行→归档
- **示例**：某项目应于 2025 年 12 月还款，截至 2026 年 8 月仍未偿还，标记为逾期

#### 业务分类 (YWFL)
- **枚举值**（五大类）：
  1. **收购处置**：不良资产包收购后处置，如债权受让、资产转让
  2. **重组**：债务重组、债转股、展期重组等
  3. **债项**：纯债项投资，如信托计划、债券投资
  4. **权益**：股权投资、基金投资、产业投资基金
  5. **其他**：无法归入上述类别的其他业务
- **业务意义**：
  - 反映业务结构分布
  - 不同类别风险特征各异
  - 影响后续管理策略
- **示例**：某项目属于"收购处置"类，是通过银行不良资产包收购获得

---

### 版本控制字段

#### BB 版本标识
- **'1' - 核算版**：
  - 经财务核算的最终确认数据
  - 唯一可信源（Golden Source）
  - 对外报表、监管报送的唯一依据
  - **所有查询必须使用此版本**
  
- **'2' - 分成版**：
  - 按机构分摊的中间版本
  - 仅用于机构维度对比分析
  - **不可用于汇总统计**（金额会重复计算）
  
- **'0' - 草稿版**：
  - 未经审核的临时数据
  - 内部测试专用
  - **禁止用于任何正式统计**

#### 版本选择指南
```sql
-- ✅ 官方报表/监管报送/对外披露
WHERE BB = '1'

-- ✅ 机构间横向对比（不涉及总额）
WHERE BB IN ('1', '2')
GROUP BY JGMC
ORDER BY SUM(BNTFJE) DESC

-- ❌ 绝对禁止
WHERE BB != '1'  -- 统计分成版数据
WHERE BB = '0'   -- 使用草稿版数据
```

---

### 日期字段

#### BBRQ (Report Date)
- **适用范围**：fct_jc_main_biz_stat（业务主宽表）
- **含义**：报告日期，月末最后交易日
- **格式**：YYYY-MM-DD
- **示例**：2026-08-31（8 月 31 日为月末最后一个交易日）
- **查询要点**：
  - 必须配合 MAX() 子查询获取最新时点
  - 不能直接用作时间范围过滤

#### SJRQ (Statement Date)
- **适用范围**：fct_jc_financial_stat（财务宽表）
- **含义**：数据日期，月末最后一个工作日
- **格式**：YYYY-MM-DD
- **示例**：2026-08-29（8 月 29 日为月末最后一个工作日，因 31 日为周六）
- **查询要点**：
  - 同样需用 MAX() 子查询
  - 可能与 BBRQ 相差 1-3 天（遇周末顺延）

#### 日期混合使用禁忌
```sql
-- ❌ 错误：混用两个日期字段
SELECT b.JGMC, b.BNTFJE, f.DNTZSY
FROM fct_jc_main_biz_stat b
JOIN fct_jc_financial_stat f ON b.BBRQ = f.SJRQ
-- 问题：两个日期口径不一致，匹配结果无业务意义

-- ✅ 正确：分别查询后关联
WITH latest_business AS (
  SELECT JGMC, SUM(BNTFJE) AS annual_put
  FROM fct_jc_main_biz_stat
  WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY JGMC
),
latest_financial AS (
  SELECT JGMC, SUM(DNTZSY) AS income
  FROM fct_jc_financial_stat
  WHERE BB = '1' AND SJRQ = (SELECT MAX(SJRQ) FROM fct_jc_financial_stat WHERE BB = '1')
  GROUP BY JGMC
)
SELECT b.JGMC, b.annual_put, f.income
FROM latest_business b
LEFT JOIN latest_financial f ON b.JGMC = f.JGMC
```

---

## 📚 参考手册

- **四红线规则**：见 kb_002《四红线规则与最佳实践》
- **SQL 查询模板**：见 evalCases.jichuang.json 评测集
- **技能模板**：见 Data Resource Skills（8 个高频分析方法）

`,
    tags: ['术语', '字典', '业务概念', '指标口径'],
    category: '业务术语',
  },

  // ============================ 新增知识库条目 ============================

  {
    id: 'kb_004',
    title: '高频分析方法与 SQL 案例库',
    content: `## 一、基础统计方法

### 1. 累计投放金额统计（最新一期）
**用户提问**："数据资源库的累计投放金额是多少？"
**SQL 模板**：
```sql
SELECT 
  SUM(LJTFJE) AS total_investment,
  ROUND(SUM(LJTFJE) / 100000000, 2) AS total_investment_hundred_million
FROM fct_jc_main_biz_stat
WHERE BB = '1'
  AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
```
**关键约束**：四红线 R1+R2，必须用 MAX 子查询 +BB='1'

---

### 2. 本年投放金额分析
**用户提问**："今年各分公司的本年投放金额排名？"
**SQL 模板**：
```sql
SELECT 
  JGMC,
  SUM(BNTFJE) AS current_year_investment,
  ROUND(SUM(BNTFJE) * 1.0 / SUM(SUM(BNTFJE)) OVER(), 4) AS proportion
FROM fct_jc_main_biz_stat
WHERE BB = '1'
  AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  AND EXTRACT(YEAR FROM TO_DATE(BBRQ, 'YYYY-MM-DD')) = EXTRACT(YEAR FROM CURRENT_DATE)
GROUP BY JGMC
ORDER BY current_year_investment DESC
LIMIT 10
```
**输出**：机构名称、本年投放金额、占比百分比

---

### 3. 投资收益分析
**用户提问**："今年的投资收益情况如何？"
**SQL 模板**：
```sql
SELECT 
  KM_YJFL AS 收益大类，
  SUM(DNTZSY) AS current_year_income,
  ROUND(SUM(DNTZSY) / 10000000, 2) AS income_ten_million,
  SUM(LZNZSY) AS cumulative_income
FROM fct_jc_financial_stat
WHERE BB = '1'
  AND SJRQ = (SELECT MAX(SJRQ) FROM fct_jc_financial_stat WHERE BB = '1')
GROUP BY KM_YJFL
ORDER BY current_year_income DESC
```
**关键约束**：四红线 R4，收益数据必须查财务表

---

## 二、风险评估方法

### 4. 逾期风险排查
**用户提问**："目前有多少逾期金额？哪些机构逾期最严重？"
**SQL 模板**：
```sql
WITH overdue_summary AS (
  SELECT 
    SUM(CASE WHEN SFYQ = true THEN YQJE ELSE 0 END) AS total_overdue_amount,
    COUNT(*) FILTER(WHERE SFYQ = true) AS overdue_project_count,
    COUNT(*) AS total_project_count
  FROM fct_jc_main_biz_stat
  WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
),
overdue_by_org AS (
  SELECT 
    JGMC,
    SUM(YQJE) AS org_overdue_amount,
    ROUND(SUM(YQJE) * 1.0 / (SELECT total_overdue_amount FROM overdue_summary), 4) AS ratio
  FROM fct_jc_main_biz_stat
  WHERE BB = '1' 
    AND SFYQ = true
    AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY JGMC
  HAVING SUM(YQJE) > 0
)
SELECT 
  os.total_overdue_amount,
  os.overdue_project_count,
  ROUND(os.total_overdue_amount * 1.0 / SUM(LJTFJE), 4) AS overdue_ratio,
  ob.*
FROM overdue_summary os
CROSS JOIN fct_jc_main_biz_stat fs
LEFT JOIN overdue_by_org ob ON true
WHERE fs.BB = '1' AND fs.BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
GROUP BY os.total_overdue_amount, os.overdue_project_count, os.total_overdue_amount / SUM(fs.LJTFJE), ob.*
ORDER BY ob.org_overdue_amount DESC
LIMIT 20
```
**输出**：总逾期金额、逾期项目数、逾期率、各机构逾期排名

---

### 5. 长龄化率分析
**用户提问**："长龄业务占比多少？哪些机构需要重点关注？"
**SQL 模板**：
```sql
WITH age_summary AS (
  SELECT 
    COUNT(*) FILTER(WHERE SFCL = true) AS long_age_count,
    COUNT(*) AS total_count,
    ROUND(COUNT(*) FILTER(WHERE SFCL = true) * 1.0 / COUNT(*), 4) AS long_age_ratio
  FROM fct_jc_main_biz_stat
  WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
),
age_by_org AS (
  SELECT 
    JGMC,
    COUNT(*) FILTER(WHERE SFCL = true) AS long_age_count,
    COUNT(*) AS project_count,
    ROUND(COUNT(*) FILTER(WHERE SFCL = true) * 1.0 / COUNT(*), 4) AS org_long_age_ratio
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY JGMC
)
SELECT 
  asum.long_age_count,
  asum.total_count,
  asum.long_age_ratio,
  jab.*
FROM age_summary asum
CROSS JOIN age_by_org jab
WHERE jab.org_long_age_ratio > 0.3
ORDER BY jab.org_long_age_ratio DESC
LIMIT 15
```
**阈值建议**：
- 长龄化率 > 30%：需重点监控
- 长龄化率 > 40%：严重老化，启动专项处置

---

### 6. 成本回收率分析
**用户提问**："我们的成本回收情况怎么样？"
**SQL 模板**：
```sql
SELECT 
  SUM(LJTFJE) - SUM(CBEY) AS total_recovered,
  SUM(LJTFJE) AS total_invested,
  ROUND((SUM(LJTFJE) - SUM(CBEY)) * 1.0 / SUM(LJTFJE), 4) AS recovery_rate,
  ROUND((SUM(LJTFJE) - SUM(CBEY)) * 100 / SUM(LJTFJE), 2) AS recovery_rate_pct
FROM fct_jc_main_biz_stat
WHERE BB = '1'
  AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
```
**业务解读**：
- (累计投放 - 成本余额) / 累计投放 = 回收率
- 回收率越低，说明风险敞口越大

---

## 三、趋势分析方法

### 7. 月度投放趋势
**用户提问**："最近几个月的投放趋势如何？"
**SQL 模板**：
```sql
SELECT 
  TO_CHAR(TO_DATE(BBRQ, 'YYYY-MM-DD'), 'YYYY-MM') AS report_month,
  SUM(BNTFJE) AS monthly_investment,
  ROUND(SUM(BNTFJE) / 10000000, 2) AS investment_million,
  SUM(BNTFJE) - LAG(SUM(BNTFJE)) OVER(ORDER BY BBRQ) AS month_over_month_change,
  ROUND(
    (SUM(BNTFJE) - LAG(SUM(BNTFJE)) OVER(ORDER BY BBRQ)) * 1.0 / NULLIF(LAG(SUM(BNTFJE)) OVER(ORDER BY BBRQ), 0), 
    4
  ) AS growth_rate
FROM fct_jc_main_biz_stat
WHERE BB = '1'
  AND BBRQ >= (SELECT MAX(BBRQ) - INTERVAL '6 months' FROM fct_jc_main_biz_stat WHERE BB = '1')
GROUP BY BBRQ
ORDER BY BBRQ DESC
LIMIT 7
```
**注意**：逐月独立统计，不跨月累加

---

### 8. 业务结构变化
**用户提问**："各类业务的占比变化情况？"
**SQL 模板**：
```sql
WITH current_period AS (
  SELECT 
    YWFL,
    COUNT(*) AS project_count,
    SUM(LJTFJE) AS investment_amount,
    ROUND(COUNT(*) * 1.0 / SUM(COUNT(*)) OVER(), 4) AS count_ratio,
    ROUND(SUM(LJTFJE) * 1.0 / SUM(SUM(LJTFJE)) OVER(), 4) AS amount_ratio
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY YWFL
),
prev_period AS (
  SELECT 
    YWFL,
    COUNT(*) AS project_count_prev,
    SUM(LJTFJE) AS investment_amount_prev,
    ROUND(COUNT(*) * 1.0 / SUM(COUNT(*)) OVER(), 4) AS count_ratio_prev,
    ROUND(SUM(LJTFJE) * 1.0 / SUM(SUM(LJTFJE)) OVER(), 4) AS amount_ratio_prev
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) - INTERVAL '1 month' FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY YWFL
)
SELECT 
  cp.YWFL,
  cp.project_count,
  pp.project_count_prev,
  cp.project_count - pp.project_count_prev AS change_projects,
  cp.amount_ratio,
  cp.amount_ratio - pp.amount_ratio_prev AS ratio_change
FROM current_period cp
JOIN prev_period pp ON cp.YWFL = pp.YWFL
ORDER BY cp.amount_ratio DESC
```
**输出**：各业务分类的项目数和金额占比，以及与上月对比

---

## 四、对比分析方法

### 9. 机构业绩排名
**用户提问**："哪个分公司业绩最好？"
**SQL 模板**：
```sql
WITH org_stats AS (
  SELECT 
    JGMC,
    COUNT(DISTINCT XMBH) AS project_count,
    SUM(LJTFJE) AS total_investment,
    SUM(BNTFJE) AS current_year_investment,
    SUM(CASE WHEN SFYQ = true THEN YQJE ELSE 0 END) AS total_overdue,
    ROUND(SUM(CASE WHEN SFYQ = true THEN YQJE ELSE 0 END) * 1.0 / NULLIF(SUM(LJTFJE), 0), 4) AS overdue_ratio,
    ROUND(SUM(CASE WHEN SFCL = true THEN 1 ELSE 0 END) * 1.0 / COUNT(*), 4) AS long_age_ratio
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY JGMC
)
SELECT 
  ROW_NUMBER() OVER(ORDER BY total_investment DESC) AS rank_by_investment,
  ROW_NUMBER() OVER(ORDER BY current_year_investment DESC) AS rank_by_annual,
  ROW_NUMBER() OVER(ORDER BY total_overdue ASC) AS rank_by_risk_lowest,
  JGMC,
  project_count,
  ROUND(total_investment / 100000000, 2) AS total_investment_hundred_million,
  ROUND(current_year_investment / 100000000, 2) AS current_year_hundred_million,
  ROUND(total_overdue / 100000000, 2) AS total_overdue_hundred_million,
  overdue_ratio * 100 AS overdue_ratio_pct,
  long_age_ratio * 100 AS long_age_ratio_pct
FROM org_stats
ORDER BY total_investment DESC
LIMIT 10
```
**多维度排名**：按总金额、本年金额、逾期最低 3 种排名

---

### 10. 同环比增长分析
**用户提问**："本月比去年好还是差？"
**SQL 模板**：
```sql
WITH compare_periods AS (
  SELECT 
    'current' AS period_type,
    SUM(BNTFJE) AS current_investment,
    SUM(LJTFJE) AS current_total,
    COUNT(*) AS current_project_count
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  
  UNION ALL
  
  SELECT 
    'previous' AS period_type,
    SUM(BNTFJE) AS prev_investment,
    SUM(LJTFJE) AS prev_total,
    COUNT(*) AS prev_project_count
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) - INTERVAL '1 year' FROM fct_jc_main_biz_stat WHERE BB = '1')
)
SELECT 
  SUM(CASE WHEN period_type = 'current' THEN current_investment ELSE 0 END) AS current_month_investment,
  SUM(CASE WHEN period_type = 'previous' THEN prev_investment ELSE 0 END) AS previous_month_investment,
  ROUND(
    (SUM(CASE WHEN period_type = 'current' THEN current_investment ELSE 0 END) - 
     SUM(CASE WHEN period_type = 'previous' THEN prev_investment ELSE 0 END)) * 1.0 / 
    NULLIF(SUM(CASE WHEN period_type = 'previous' THEN prev_investment ELSE 0 END), 0),
    4
  ) AS yoy_growth_rate
FROM compare_periods
```
**输出**：同比增速（今年 vs 去年同月）

---

## 🎯 方法论总结

### 四红线贯穿所有分析
1. ✅ **R1**: 所有"最新"查询都用 MAX 子查询
2. ✅ **R2**: 所有查询必带`WHERE BB = '1'`
3. ✅ **R3**: 项目数统计必用`COUNT(DISTINCT XMBH)`
4. ✅ **R4**: 投资收益必查财务宽表

### 分析框架建议
- **单表统计**：先看表结构 → 选核心字段 → 应用四红线
- **多表关联**：避免直接 JOIN，用 CTE 先分组聚合再关联
- **趋势分析**：按月独立统计，不跨期累加
- **对比分析**：同期对比（YoY/MoM），明确基准期

`,
    tags: ['SQL 案例', '分析方法', '高频问题', '最佳实践'],
    category: '实战案例',
  },

  {
    id: 'kb_005',
    title: '常见问答与边界场景处理',
    content: `## Q1: 数据缺失或空档怎么办？

**问题场景**：用户询问"2026 年上半年的累计投放金额"

**错误理解**：直接 SUM(BBRQ BETWEEN '2026-01-01' AND '2026-06-30')

**正确做法**：
1. 解释月末快照特性：每个月末才有数据，不是连续记录
2. 说明可用月份：实际有数据的月末日期可能是 '2026-01-31','2026-02-28','2026-03-31'等
3. 提供替代方案：
   - 方案 A：逐月查询然后相加（但需注意跨月累加陷阱）
   - 方案 B：推荐改为"查询每个月末的最新余额"

**标准回答话术**：
"数据资源库采用月末快照口径，每月只有月末最后一天的静态数据。由于您可能想了解企业上半年的整体情况，我建议：
- 查看最新一期（本月末）的余额数据
- 或者按月度展示每个月的快照变化趋势
您希望我采用哪种方式？"

---

## Q2: 分成版数据能不能用？

**适用场景**（仅限机构对比）：
- "华东分公司和华南分公司哪个投放更多？"
- "各机构的长龄化率对比"

**不适用场景**（严禁汇总）：
- "公司总的投放金额是多少？"
- "全年的投资收益总额？"

**技术说明**：
```sql
-- ✅ 机构对比可以使用分成版（更细粒度）
SELECT JGMC, SUM(BNTFJE)
FROM fct_jc_main_biz_stat
WHERE BB IN ('1', '2')
GROUP BY JGMC
ORDER BY SUM(BNTFJE) DESC

-- ❌ 总合统计只能用核算版
SELECT SUM(BNTFJE)
FROM fct_jc_main_biz_stat
WHERE BB = '1'  -- 只用这一个版本
```

---

## Q3: 为什么同一个项目编号出现多次？

**原因分析**：
1. **多笔投放记录**：同一项目在不同时间有多次放款
2. **联合投放**：多个机构共同参与同一项目
3. **历史调整**：后期修改导致原记录拆分或合并

**正确处理**：
```sql
-- ✅ 统计项目数必须去重
SELECT COUNT(DISTINCT XMBH) FROM fct_jc_main_biz_stat WHERE BB = '1'

-- ✅ 如果要看明细，保留所有记录
SELECT XMBH, BBRQ, LJTFJE
FROM fct_jc_main_biz_stat
WHERE BB = '1'
ORDER BY XMBH, BBRQ
```

---

## Q4: 如何判断数据是否准确？

**验证清单**：
- [ ] 检查 BB 是否为'1'（核算版）
- [ ] 确认使用了正确的日期字段（业务表用 BBRQ，财务表用 SJRQ）
- [ ] 项目数统计是否用 COUNT DISTINCT
- [ ] 最新数据查询是否用 MAX 子查询
- [ ] 投资收益是否来自财务宽表

**权威来源优先级**：
1. **最高**：BB='1'核算版数据（唯一可信源）
2. **中**：分成版数据（仅用于机构对比）
3. **禁止**：BB='0'草稿版数据

---

## Q5: 环比/同比怎么算？

**环比（MoM）**：本月 vs 上月
```sql
WITH monthly_data AS (
  SELECT 
    BBRQ,
    SUM(BNTFJE) AS monthly_investment
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
  GROUP BY BBRQ
  ORDER BY BBRQ DESC
  LIMIT 2
)
SELECT 
  MAX(CASE WHEN BBRQ = (SELECT MAX(BBRQ) FROM monthly_data) THEN monthly_investment END) AS current_month,
  MIN(CASE WHEN BBRQ < (SELECT MAX(BBRQ) FROM monthly_data) THEN monthly_investment END) AS previous_month,
  ROUND(
    (MAX(CASE WHEN BBRQ = (SELECT MAX(BBRQ) FROM monthly_data) THEN monthly_investment END) - 
     MIN(CASE WHEN BBRQ < (SELECT MAX(BBRQ) FROM monthly_data) THEN monthly_investment END)) * 1.0 /
    NULLIF(MIN(CASE WHEN BBRQ < (SELECT MAX(BBRQ) FROM monthly_data) THEN monthly_investment END), 0),
    4
  ) AS mom_growth_rate
FROM monthly_data
```

**同比（YoY）**：本月 vs 去年同月
```sql
WITH compare AS (
  SELECT 
    'current' AS period_type,
    SUM(BNTFJE) AS investment,
    TO_CHAR(TO_DATE(BBRQ, 'YYYY-MM-DD'), 'MM') AS month
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY BBRQ
  
  UNION ALL
  
  SELECT 
    'previous' AS period_type,
    SUM(BNTFJE) AS investment,
    TO_CHAR(TO_DATE(BBRQ, 'YYYY-MM-DD'), 'MM') AS month
  FROM fct_jc_main_biz_stat
  WHERE BB = '1'
    AND BBRQ = (SELECT MAX(BBRQ) - INTERVAL '1 year' FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY BBRQ
)
SELECT 
  MAX(CASE WHEN period_type = 'current' THEN investment ELSE 0 END) AS current_year,
  MAX(CASE WHEN period_type = 'previous' THEN investment ELSE 0 END) AS previous_year,
  ROUND(
    (MAX(CASE WHEN period_type = 'current' THEN investment ELSE 0 END) - 
     MAX(CASE WHEN period_type = 'previous' THEN investment ELSE 0 END)) * 1.0 /
    NULLIF(MAX(CASE WHEN period_type = 'previous' THEN investment ELSE 0 END), 0),
    4
  ) AS yoy_growth_rate
FROM compare
```

---

## Q6: 如何快速理解某个字段的含义？

**方法**：
1. **看列描述**：columns[i].description 字段
2. **看示例值**：SAMPLE_FCT_JC_MAIN_BIZ_DATA 中的样例
3. **结合业务术语**：kb_003 术语词典
4. **咨询数据所有者**：业务部门确认口径

**优先级排序**：
- 第一优先级：术语词典中的正式定义
- 第二优先级：评测集中的标准 SQL 用法
- 第三优先级：实际样例数据的模式观察

---

## Q7: 遇到 LLM 幻觉怎么办？

**常见幻觉场景**：
1. **编造字段名**：查询不存在的列
2. **错误关联**：误判表间关系
3. **虚构指标**：自创不存在的计算方法

**防御策略**：
1. **Schema 白名单**：只允许查询已知字段
2. **Prompt 约束**：明确要求"只能使用提供的字段"
3. **Few-shot 示例**：提供标准 SQL 模板
4. **Post-processing**：校验生成的 SQL 是否能实际执行

**典型 Prompt 优化**：
```
你是不动产资产经营 NL2SQL 专家。请严格基于以下 Schema 生成 SQL：
[完整字段列表]

约束条件：
1. 绝对不能创造表中不存在的字段
2. 所有字段必须来自给定的 94 列（业务表）或 204 列（财务表）
3. 必须遵守四红线规则
4. 如果不确定，优先使用通用字段如 XMBH、JGMC、LJTFJE

错误示例（禁止）：
- SELECT customer_name ... (customer_name 不存在)
- SELECT profit_margin ... (profit_margin 不是真实字段)
```

---

## 💡 边界场景处理原则

| 场景 | 处理方法 | 标准答案 |
|------|----------|----------|
| 月份空档 | 用 MAX 子查询代替日期范围 | "该月无月末报告数据" |
| 分成版请求汇总 | 拒绝 + 引导至核算版 | "请使用 BB='1'核算版数据" |
| 字段不存在 | 给出最接近的真实字段 | "可能您指的是 xxx 字段" |
| 跨表 JOIN 失败 | 改用 CTE 先聚合再关联 | "两个表日期口径不一致" |
| 长龄判定争议 | 严格按 60 个月标准 | "最早授信距今≥60 个月" |

`,
    tags: ['FAQ', '边界场景', '幻觉防御', '最佳实践'],
    category: '常见问题',
  },
];  - 可能与 BBRQ 相差 1-3 天（遇周末顺延）

#### 日期混合使用禁忌
```sql
-- ❌ 错误：混用两个日期字段
SELECT b.JGMC, b.BNTFJE, f.DNTZSY
FROM fct_jc_main_biz_stat b
JOIN fct_jc_financial_stat f ON b.BBRQ = f.SJRQ
-- 问题：两个日期口径不一致，匹配结果无业务意义

-- ✅ 正确：分别查询后关联
WITH latest_business AS (
  SELECT JGMC, SUM(BNTFJE) AS annual_put
  FROM fct_jc_main_biz_stat
  WHERE BB = '1' AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
  GROUP BY JGMC
),
latest_financial AS (
  SELECT JGMC, SUM(DNTZSY) AS income
  FROM fct_jc_financial_stat
  WHERE BB = '1' AND SJRQ = (SELECT MAX(SJRQ) FROM fct_jc_financial_stat WHERE BB = '1')
  GROUP BY JGMC
)
SELECT b.JGMC, b.annual_put, f.income
FROM latest_business b
LEFT JOIN latest_financial f ON b.JGMC = f.JGMC
```

---

## 📚 参考手册

- **四红线规则**：见 kb_002《四红线规则与最佳实践》
- **SQL 查询模板**：见 evalCases.jichuang.json 评测集
- **技能模板**：见 Data Resource Skills（8 个高频分析方法）
`,
    tags: ['术语', '字典', '业务概念', '指标口径'],
    category: '业务术语',
  },
];

// ============ 内置技能（复用现有 8 个技能） ============

export const DATA_RESOURCE_SKILLS = [
  {
    id: 'org-biz-profile',
    name: '机构业务画像',
    description: '按机构盘点业务笔数、本年投放、长龄与逾期，定位头部机构',
    promptTemplate: '请按机构名称统计业务笔数、本年投放金额、长龄业务笔数和逾期金额（统计口径均为核算版），按本年投放金额降序排列，指出规模前三的机构',
    placeholders: [],
  },
  {
    id: 'aged-asset',
    name: '长龄资产分析',
    description: '长龄业务（最早授信距宽表月份≥60 个月）的机构分布与集中度',
    promptTemplate: '请按机构名称统计长龄业务笔数（核算版且 SFCL 为是），并计算长龄业务占全部业务笔数的比例，指出长龄化程度最高的机构',
    placeholders: [],
  },
  {
    id: 'risk-project',
    name: '风险项目监控',
    description: '风险项目台账口径的机构分布与集中度预警',
    promptTemplate: '请统计风险项目总数，并按机构名称统计风险项目个数（核算版），指出风险项目最集中的机构',
    placeholders: [],
  },
  {
    id: 'overdue-asset',
    name: '逾期资产分析',
    description: '逾期金额与逾期笔数按业务分类分布，定位清收重点',
    promptTemplate: '请按业务分类统计逾期金额和逾期业务笔数（核算版且 SFYQ 为是），按逾期金额降序排列，指出逾期最集中的业务分类',
    placeholders: [],
  },
  {
    id: 'return-analysis',
    name: '投资收益分析',
    description: '按科目一级分类看当年/累计投资收益（财务宽表最新月末快照）',
    promptTemplate: '请按科目一级分类统计当年投资收益和累计投资收益（财务宽表、核算版、取最新月末快照），按当年投资收益降序排列',
    placeholders: [],
  },
  {
    id: 'scale-trend',
    name: '月末规模趋势',
    description: '按月末快照观察累计投放走势（不跨月末累加）',
    promptTemplate: '请按月末快照日期逐月展示累计投放金额的变化趋势（核算版），并指出趋势拐点；注意每个月末是当月全量快照，不要跨月末累加',
    placeholders: [],
  },
  {
    id: 'biz-structure',
    name: '业务结构分析',
    description: '五大业务分类（收购处置/重组/债项/权益/其他）投放结构',
    promptTemplate: '请计算各业务分类在本年投放金额中的占比（核算版），用饼图展示结构分布，并指出主导业务类型',
    placeholders: [],
  },
  {
    id: 'stock-vs-new',
    name: '存量与新增对比',
    description: '存量项目与当年新增项目的机构对比，识别经营模式差异',
    promptTemplate: '请按机构名称对比存量项目数与当年新增项目数（核算版），指出以存量经营为主的机构和新增投放能力强的机构',
    placeholders: [],
  },
];

// ============ 评测集（复用现有评测集） ============

export const DATA_RESOURCE_EVALUATION_CASES = require('./eval/evalCases.jichuang.json');

// ============ 导出用于初始化 ============

export interface DataResourceInitPayload {
  dataSource: DataSource;
  sampleBusinessData: any[];
  sampleFinancialData: any[];
  knowledgeBase: typeof DATA_RESOURCE_KNOWLEDGE_BASE;
  skills: typeof DATA_RESOURCE_SKILLS;
  evaluationCases: typeof DATA_RESOURCE_EVALUATION_CASES;
}

export function createDataResourceInitPayload(): DataResourceInitPayload {
  return {
    dataSource: DATA_RESOURCE_DS,
    sampleBusinessData: SAMPLE_FCT_JC_MAIN_BIZ_DATA,
    sampleFinancialData: SAMPLE_FCT_JC_FINANCIAL_DATA,
    knowledgeBase: DATA_RESOURCE_KNOWLEDGE_BASE,
    skills: DATA_RESOURCE_SKILLS,
    evaluationCases: DATA_RESOURCE_EVALUATION_CASES,
  };
}
