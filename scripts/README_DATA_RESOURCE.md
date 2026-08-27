# 数据资源库部署指南

## 📋 概述

数据资源库（Data Resource Library）是系统的**内置测试数据源**，包含：

- **两个核心宽表**：
  - `fct_jc_main_biz_stat` (94 列)：机构投放业务主宽表，不良资产业务全量信息
  - `fct_jc_financial_stat` (204 列)：投资收益财务宽表，科目级财务收益明细
  
- **四红线规则**：核算版过滤、月末快照锁定、项目数去重、财务指标查表
  
- **业务知识库**：3 条领域知识（概念口径、红线规范、术语词典）

- **技能模板**：8 个高频分析方法（机构画像、长龄资产、风险项目等）

- **评测集**：10 个用例（wt01-wt10），覆盖单表聚合/时间序列/子查询等场景

## 🚀 快速部署

### 方式一：一键自动化部署（推荐）

```bash
# 1. 配置环境变量（可选，使用默认值即可）
export MYSQL_HOST="127.0.0.1"
export MYSQL_PORT=3306
export MYSQL_USER="root"
export MYSQL_PASSWORD="your_password"

# 2. 执行初始化脚本
npm run init:data-resource
```

**输出示例：**
```
🚀 数据资源库初始化脚本启动...

📦 Step 1: 创建数据资源库数据库...
  ✓ 数据库、表结构、样本数据创建成功

🗄️  Step 2: 在应用库中注册数据源配置...
  ✓ 数据源配置已就绪...

✅ 数据资源库初始化完成！

📋 初始化摘要:
  ✓ 数据库：data_resource_db
  ✓ 数据源 ID: ds_1786620486498
  ✓ 业务宽表：fct_jc_main_biz_stat (94 列)
  ✓ 财务宽表：fct_jc_financial_stat (204 列)
  ...
```

### 方式二：手动执行 SQL 文件

```bash
# 直接执行 SQL 脚本（仅初始化数据库与表）
mysql -h <host> -u root -p < scripts/init_data_resource_db.sql
```

## 📝 验证步骤

### 1. 检查数据库与表

```sql
USE data_resource_db;
SHOW TABLES;
-- 应显示：fct_jc_main_biz_stat, fct_jc_financial_stat

SELECT COUNT(*) FROM fct_jc_main_biz_stat WHERE BB = '1';
-- 返回：5（样本数据条数）

SELECT COUNT(*) FROM fct_jc_financial_stat WHERE BB = '1';
-- 返回：4（样本数据条数）
```

### 2. 检查系统数据源列表

1. 访问 http://localhost:3000 登录系统（默认账号 admin/admin123）
2. 进入「数据管理」→「数据源列表」
3. 查看是否包含「数据资源库」条目

### 3. 智能问数功能测试

1. 进入「智能问数」页面
2. 选择数据源「数据资源库」
3. 尝试提问：
   ```
   "数据资源库的累计投放金额是多少？"
   ```
   
   **预期结果：**
   - LLM 自动生成 SQL（包含四红线约束）
   - 查询实际数据并返回数值
   - 生成图表展示
   
   **生成的 SQL 应包含：**
   ```sql
   SELECT SUM(LJTFJE) AS v 
   FROM fct_jc_main_biz_stat 
   WHERE BB = '1' 
     AND BBRQ = (SELECT MAX(BBRQ) FROM fct_jc_main_biz_stat WHERE BB = '1')
   ```

### 4. 知识库验证

1. 进入「系统管理」→「知识库」
2. 查看「数据资源库」相关条目，应包含 3 条：
   - 数据资源库核心概念与口径
   - 四红线规则与最佳实践
   - 不良资产经营分析术语词典

### 5. 技能模板验证

1. 进入「智能问数」页面
2. 点击输入框下方的「技能」按钮
3. 查看 8 个高频分析模板：
   - 机构业务画像
   - 长龄资产分析
   - 风险项目监控
   - 逾期资产分析
   - 投资收益分析
   - 月末规模趋势
   - 业务结构分析
   - 存量与新增对比

## 🔧 环境配置

### 必填环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `MYSQL_HOST` | `127.0.0.1` | 应用库 MySQL 主机地址 |
| `MYSQL_PORT` | `3306` | 应用库 MySQL 端口 |
| `MYSQL_USER` | `root` | 应用库 MySQL 用户名 |
| `MYSQL_PASSWORD` | `` | 应用库 MySQL 密码 |

### 可选环境变量（用于连接数据资源库自身）

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `DATA_RESOURCE_HOST` | `10.10.60.105` | 数据资源库主机地址 |
| `DATA_RESOURCE_PORT` | `3306` | 数据资源库端口 |
| `DATA_RESOURCE_DB` | `data_resource_db` | 数据资源库名 |
| `DATA_RESOURCE_USER` | `bi_reader` | 只读用户 |
| `DATA_RESOURCE_PASS` | `` | 密码（建议通过环境变量注入） |

## 🎯 典型应用场景

### 场景一：NL2SQL 准确性评测

使用 `server/eval/evalCases.jichuang.json` 中的 10 个用例进行评测：

```bash
npm run eval -- --cases server/eval/evalCases.jichuang.json
```

### 场景二：领域知识问答

通过「智能问数」页面试问业务相关问题，验证知识库命中率：

```
"什么是长龄业务？"
→ 回答会引用 kb_001 中关于 SFCL 字段和 60 个月定义的知识
```

### 场景三：高管决策简报

使用「报告模式」生成不良资产管理分析报告：

```
请选择报告模板 → 「企业战略决策简报」
→ 自动调用 8 个技能模板的数据查询逻辑
→ 生成 PDF/PPT 格式的完整分析报告
```

## ⚠️ 注意事项

1. **数据安全**
   - 生产环境请使用真实数据替换样本数据
   - 建议对 `DATA_RESOURCE_PASS` 等敏感信息使用 `.env.local` 管理
   - 定期备份 `data_resource_db` 数据库

2. **性能优化**
   - 当前样本数据仅数十行，真实场景可能有数十万行
   - 建议对 `BBRQ/SJRQ/BB/JGMC` 等高频查询字段建立索引（已在 SQL 中定义）
   - 如需大规模压测，可使用 `npm run loadtest`

3. **权限控制**
   - `bi_reader` 用户仅授予 SELECT 权限
   - 不要使用 root 用户连接应用
   - 行级权限通过 `scope` 字段实现机构维度隔离

## 📊 数据字典

### fct_jc_main_biz_stat（业务主宽表）

| 字段 | 类型 | 含义 | 关键约束 |
|------|------|------|----------|
| XMBH | VARCHAR(50) | 项目编号 | PK，必须 DISTINCT 计数 |
| JGDM | VARCHAR(20) | 机构代码 | 维度，可分组统计 |
| JGMC | VARCHAR(100) | 机构名称 | 维度，可分组统计 |
| YWFL | VARCHAR(20) | 业务分类 | 枚举（收购处置/重组/债项/权益/其他） |
| SFCL | VARCHAR(2) | 是否长龄 | 布尔（是/否）≥60 个月 |
| SFYQ | VARCHAR(2) | 是否逾期 | 布尔（是/否） |
| LJTFJE | DECIMAL(20,2) | 累计投放金额 | 指标，单位元 |
| BNTFJE | DECIMAL(20,2) | 本年投放金额 | 指标，单位元 |
| CBEY | DECIMAL(20,2) | 成本余额 | 指标，单位元 |
| YQJE | DECIMAL(20,2) | 逾期金额 | 指标，单位元 |
| BBRQ | DATE | 报告日期 | 分区键，月末快照 |
| BB | VARCHAR(2) | 版本标识 | 过滤条件 BB='1'核算版 |

### fct_jc_financial_stat（财务宽表）

| 字段 | 类型 | 含义 | 关键约束 |
|------|------|------|----------|
| KM_YJFL | VARCHAR(50) | 科目一级分类 | PK，维度（投资收益/其他收益） |
| KM_EJFL | VARCHAR(50) | 科目二级分类 | PK，维度 |
| DNTZSY | DECIMAL(20,2) | 当年投资收益 | 指标，单位元 |
| LZNZSY | DECIMAL(20,2) | 累计投资收益 | 指标，单位元 |
| SJRQ | DATE | 数据日期 | 分区键，月末 |
| BB | VARCHAR(2) | 版本标识 | 过滤条件 BB='1' |

## 🆘 故障排查

### 问题 1：初始化脚本连接失败

```
Error: connect ECONNREFUSED 127.0.0.1:3306
```

**解决方案：**
```bash
# 确保 MySQL 服务已启动
brew services list | grep mysql

# 检查连接配置
mysql -h 127.0.0.1 -P 3306 -u root -p
```

### 问题 2：数据源无法连接到数据资源库

访问系统后提示「数据源连接失败」

**解决方案：**
```bash
# 检查网络可达性
telnet 10.10.60.105 3306

# 验证数据库存在
mysql -h 10.10.60.105 -P 3306 -ubireader -p -e "SHOW DATABASES;"

# 确认用户权限
mysql -h 10.10.60.105 -P 3306 -ubireader -p -e "GRANT SELECT ON data_resource_db.* TO 'bi_reader'@'%'; FLUSH PRIVILEGES;"
```

### 问题 3：NL2SQL 未遵守四红线规则

生成的 SQL 缺少 `BB='1'` 或 MAX 子查询

**解决方案：**
1. 检查知识库是否导入成功：
   ```sql
   SELECT * FROM application_knowledge_base WHERE tags LIKE '%四红线%';
   ```
2. 刷新前端缓存，重新加载系统
3. 查看后端日志是否有知识库检索错误

## 📞 技术支持

- **技术交流群**：[待定]
- **GitHub Issues**：https://github.com/dgjin/smart-data-analytics/issues
- **邮件支持**：dgjin@example.com

## 📚 相关文档

- [系统功能说明书](docs/系统功能说明书.md)
- [用户使用指南](docs/用户使用指南.md)
- [评测集标注规范](docs/评测集标注规范.md)
