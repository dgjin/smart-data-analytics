# kb_004/kb_005知识库 - 独立任务实施计划

## 📋 任务背景

在 v0.9.0 P1-2 Token 级流式输出实现过程中，因 TypeScript 模板字符串中的 Markdown 代码块转义问题复杂，决定将 kb_004/kb_005作为独立任务后续完善。

**原计划内容：**
- **kb_004**: 高频分析方法与 SQL 案例库 (+380 行)
- **kb_005**: 常见问答与边界场景处理 (+230 行)

**遇到的问题：**
1. TypeScript 模板字符串（反引号``）内包含 Markdown 代码块（` ```sql `）导致编译错误
2. sed/Node.js脚本替换时引号嵌套复杂，易破坏文件结构
3. 多次尝试后部分代码块被错误修改

---

## ✅ 推荐解决方案

### 方案一：使用纯文本标记替代 Markdown（✅ 推荐）

将所有的 Markdown 代码块标记替换为简单的文本标记：

```typescript
// ❌ 原始格式（TypeScript 无法解析）
content: `## SQL 示例
\`\`\`sql
SELECT * FROM table WHERE BB = '1'
\`\`\``

// ✅ 替代方案 A: [SQL]...[/SQL] 标记
content: `## SQL 示例
[SQL]
SELECT * FROM table WHERE BB = '1'
[/SQL]`

// ✅ 替代方案 B: 【SQL】...【/SQL】中文标记
content: `## SQL 示例
【SQL】
SELECT * FROM table WHERE BB = '1'
【/SQL】`

// ✅ 替代方案 C: 普通加粗/斜体
content: `## SQL 示例
*SELECT * FROM table WHERE BB = '1'*`
```

### 方案二：拆分内容到独立文件（备选）

```bash
server/
├── seedDataResources.ts         # 仅保存核心配置
├── knowledgeBase/
│   ├── kb_004_sql_cases.md      # SQL 案例库
│   ├── kb_005_faqs.md           # FAQ
│   └── index.ts                 # 加载器
```

```typescript
// server/knowledgeBase/index.ts
import { readFileSync } from 'fs';
import { join } from 'path';

export const KB_004_SQL_CASES = readFileSync(
  join(__dirname, 'kb_004_sql_cases.md'), 
  'utf-8'
);

export const KB_005_FAQS = readFileSync(
  join(__dirname, 'kb_005_faqs.md'), 
  'utf-8'
);
```

---

## 🎯 kb_004: 高频分析方法与 SQL 案例库

### 目标容量
- **行数**: ~380 行
- **条目数**: 10 个完整 SQL 案例
- **覆盖场景**: 基础统计、风险评估、趋势分析、对比分析

### 建议 SQL 案例清单

#### 模块 1: 基础统计方法（3 个案例）
1. **累计投放金额统计（最新一期）**
   - 用户提问："数据资源库的累计投放金额是多少？"
   - 四红线 R1+R2 应用
   - MAX 子查询 +BB='1'过滤

2. **本年投放金额分析（机构排名）**
   - 用户提问："今年各分公司的本年投放金额排名？"
   - EXTRACT(YEAR FROM ...)时间范围过滤
   - GROUP BY + ORDER BY DESC

3. **投资收益分析（财务表查询）**
   - 用户提问："今年的投资收益情况如何？"
   - 四红线 R4 典型用例
   - 财务宽表 vs 业务宽表区分

#### 模块 2: 风险评估方法（3 个案例）
4. **逾期风险排查（多维度聚合）**
   - 用户提问："目前有多少逾期金额？哪些机构逾期最严重？"
   - CTE 复杂查询示范
   - WITH + CASE WHEN 组合

5. **长龄化率分析（阈值判定）**
   - 用户提问："长龄业务占比多少？哪些机构需要重点关注？"
   - 业务规则编码实现（SFCL='是'）
   - 行业经验阈值（>30% 需监控）

6. **成本回收率分析（比率计算）**
   - 用户提问："我们的成本回收情况怎么样？"
   - 投资回报评估模型
   - (累计投放 - 成本余额)/累计投放

#### 模块 3: 趋势分析方法（2 个案例）
7. **月度投放趋势（同比环比）**
   - 用户提问："最近几个月的投放趋势如何？"
   - 窗口函数 LAG()用法
   - 按月独立统计，不跨期累加

8. **业务结构变化（占比对比）**
   - 用户提问："各类业务的占比变化情况？"
   - YoY/MoM差异分析
   - CURRENT vs PREV_PERIODCTE 对比

#### 模块 4: 对比分析方法（2 个案例）
9. **机构业绩排名（多目标排序）**
   - 用户提问："哪个分公司业绩最好？"
   - ROW_NUMBER()实战
   - 按总金额/本年金额/逾期最低 3 种排名

10. **同环比增长分析（基准期对比）**
    - 用户提问："本月比去年好还是差？"
    - YoY 算法实现
    - UNION ALL + CASE WHEN pivot

---

## 📚 kb_005: 常见问答与边界场景处理

### 目标容量
- **行数**: ~230 行
- **Q&A 数**: 7 个高频问题
- **场景覆盖**: 数据缺失、版本选择、字段歧义、LLM 幻觉

### 建议 Q&A 清单

#### Q1: 数据缺失或空档怎么办？
**场景**: 用户询问"2026 年上半年的累计投放金额"

**正确回答**:
1. 解释月末快照特性：每月只有月末最后一天有数据
2. 说明可用月份：可能是 '2026-01-31','2026-02-28'等
3. 提供替代方案：
   - 方案 A：逐月查询然后相加（但需注意跨月累加陷阱）
   - 方案 B：推荐改为"查询每个月末的最新余额"

**标准话术**: "数据资源库采用月末快照口径，每月只有月末最后一天的静态数据。由于您可能想了解企业上半年的整体情况，我建议..."

---

#### Q2: 分成版数据能不能用？
**适用场景**（仅限机构对比）：
- "华东分公司和华南分公司哪个投放更多？"
- "各机构的长龄化率对比"

**不适用场景**（严禁汇总）：
- "公司总的投放金额是多少？"
- "全年的投资收益总额？"

**技术说明**:
```sql
-- ✅ 机构对比可以使用分成版
SELECT JGMC, SUM(BNTFJE)
FROM fct_jc_main_biz_stat
WHERE BB IN ('1', '2')
GROUP BY JGMC

-- ❌ 总合统计只能用核算版
SELECT SUM(BNTFJE)
FROM fct_jc_main_biz_stat
WHERE BB = '1'
```

---

#### Q3: 为什么同一个项目编号出现多次？
**原因分析**:
1. 多笔投放记录：同一项目在不同时间有多次放款
2. 联合投放：多个机构共同参与同一项目
3. 历史调整：后期修改导致原记录拆分或合并

**正确处理**:
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

#### Q4: 如何判断数据是否准确？
**验证清单**:
- [ ] 检查 BB 是否为'1'（核算版）
- [ ] 确认使用了正确的日期字段（业务表用 BBRQ，财务表用 SJRQ）
- [ ] 项目数统计是否用 COUNT DISTINCT
- [ ] 最新数据查询是否用 MAX 子查询
- [ ] 投资收益是否来自财务宽表

**权威来源优先级**:
1. **最高**: BB='1'核算版数据（唯一可信源）
2. **中**: 分成版数据（仅用于机构对比）
3. **禁止**: BB='0'草稿版数据

---

#### Q5: 环比/同比怎么算？
**环比（MoM）**: 本月 vs 上月
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
-- ...计算增长率逻辑
```

**同比（YoY）**: 本月 vs 去年同月
```sql
WITH compare_periods AS (
  SELECT 'current' AS period_type, ..., BBRQ
  FROM fct_jc_main_biz_stat
  WHERE BB = '1' AND BBRQ = MAX_BBRQ
  
  UNION ALL
  
  SELECT 'previous' AS period_type, ..., BBRQ
  FROM fct_jc_main_biz_stat
  WHERE BB = '1' AND BBRQ = MAX_BBRQ - INTERVAL '1 year'
)
-- ...计算同比逻辑
```

---

#### Q6: 如何快速理解某个字段的含义？
**四级信息源优先级**:
1. 术语词典中的正式定义（kb_003）
2. 评测集中的标准 SQL 用法（evalCases.jichuang.json）
3. 实际样例数据的模式观察（SAMPLE_FCT_JC_MAIN_BIZ_DATA）
4. 咨询数据所有者（业务部门确认口径）

**实用技巧**:
- 看列描述：columns[i].description 字段
- 看示例值：SAMPLE 数组中的样例
- 结合业务术语：kb_003 术语词典
- 咨询业务专家：最终确认

---

#### Q7: 遇到 LLM 幻觉怎么办？
**常见幻觉场景**:
1. **编造字段名**: 查询不存在的列
2. **错误关联**: 误判表间关系
3. **虚构指标**: 自创不存在的计算方法

**防御策略**:
1. **Schema 白名单**: 只允许查询已知字段
2. **Prompt 约束**: "只能使用提供的字段"
3. **Few-shot 示例**: 提供标准 SQL 模板
4. **Post-processing**: 校验生成的 SQL 是否能实际执行

**典型 Prompt 优化**:
```
你是不动产资产经营 NL2SQL 专家。请严格基于以下 Schema 生成 SQL：
[完整字段列表]

约束条件：
1. 绝对不能创造表中不存在的字段
2. 所有字段必须来自给定的 94 列（业务表）或 204 列（财务表）
3. 必须遵守四红线规则
4. 如果不确定，优先使用通用字段如 XMBH、JGMC、LJTFJE
```

---

#### Q8-Q10: 边界场景处理原则表
| 场景 | 处理方法 | 标准答案 |
|------|----------|----------|
| 月份空档 | 用 MAX 子查询代替日期范围 | "该月无月末报告数据" |
| 分成版请求汇总 | 拒绝 + 引导至核算版 | "请使用 BB='1'核算版数据" |
| 字段不存在 | 给出最接近的真实字段 | "可能您指的是 xxx 字段" |
| 跨表 JOIN 失败 | 改用 CTE 先聚合再关联 | "两个表日期口径不一致" |
| 长龄判定争议 | 严格按 60 个月标准 | "最早授信距今≥60 个月" |

---

## 🛠️ 实施步骤

### Step 1: 确定标记方案（30 分钟）
- 选择 `[SQL]...[/SQL]` 或 `~~~sql~~~` 或纯文本
- 全局搜索现有文件，统一风格

### Step 2: 编写 kb_004 内容（2 小时）
- 按上述 10 个 SQL 案例清单逐一编写
- 每段都包含：用户提问→SQL 模板→关键约束→业务解读
- 注意：不使用 Markdown 代码块，用选定标记替代

### Step 3: 编写 kb_005 内容（1.5 小时）
- 按上述 7 个 Q&A 清单逐一编写
- 每段都包含：问题场景→正确回答→SQL 示例→标准话术

### Step 4: 语法验证（30 分钟）
```bash
cd /Users/dgjin/dgjinapp/智能问数据分析系统
npm run lint  # 确保 tsc 零错误
```

### Step 5: 集成测试（1 小时）
```bash
npm run dev
# 访问 http://localhost:3000
# 提问各种边界问题，验证 LLM 能否引用知识库内容
```

### Step 6: Git 提交（15 分钟）
```bash
git add -A
git commit -m "feat(knowledge-base): 补充 kb_004/kb_005知识库 - SQL案例库+FAQ"
git push origin main
git push gitee main
npm version patch  # v0.9.1
```

---

## ⏱️ 预计耗时

| 步骤 | 预估时间 |
|------|---------|
| Step 1: 确定标记方案 | 30 分钟 |
| Step 2: 编写 kb_004 | 2 小时 |
| Step 3: 编写 kb_005 | 1.5 小时 |
| Step 4: 语法验证 | 30 分钟 |
| Step 5: 集成测试 | 1 小时 |
| Step 6: Git 提交 | 15 分钟 |
| **总计** | **约 6 小时** |

---

## ✅ 验收标准

- ✅ npm run lint 零错误
- ✅ 知识库总行数 ≥ 610 行（kb_004+kb_005）
- ✅ 10 个完整 SQL 案例可独立运行
- ✅ 7 个高频 Q&A 覆盖真实业务场景
- ✅ 边界场景处理原则表完整
- ✅ LLM 能准确引用知识库回答问题
- ✅ Git 双远程仓库同步成功

---

## 💡 注意事项

1. **不要使用 Markdown 代码块**: 避免 ```sql 导致 TypeScript 编译错误
2. **保持引号一致性**: description 字段用双引号包裹，内部单引号不需转义
3. **段落清晰**: 每个案例/Q&A 之间用 `---`分隔
4. **注释规范**: 代码行尾注释用`--`,Markdown 注释用`<!-- -->`
5. **版本管理**: 完成后立即更新 package.json 版本号并打 tag

---

## 🔄 与 P1-2 的关系

**独立性**:
- kb_004/kb_005不影响 P1-2 流式功能运行
- 可作为独立迭代持续推进

**互补性**:
- P1-2 提供"打字机效果"用户体验
- kb_004/kb_005 提供"精准回答"知识支撑
- 两者结合 = 完美 NL2SQL 体验

**后续整合**:
- 建议在 v0.9.1 版本统一发布
- 或在 v1.0.0大版本作为"知识库增强"特性发布

---

**🎯 kb_004/kb_005已标记为独立任务，可在有空闲时间时按照本计划逐步完善！**

当前 v0.9.0P1-2 流式输出功能已完整实现并稳定运行，知识库问题不影响核心功能。
