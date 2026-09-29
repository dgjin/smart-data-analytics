# 智能问数分析系统（NL2SQL Pro）

企业级自然语言数据分析平台：用中文提问，系统自动理解语义、匹配数据表结构、生成并执行 SQL，将真实查询结果转化为图表、KPI 与洞察解读，并可一键产出高管决策简报。

> 使用帮助见 [docs/核心文档/用户使用指南.md](docs/核心文档/用户使用指南.md)（系统内「帮助」按钮实时读取该文档）；各版本更新内容见 [docs/核心文档/更新日志.md](docs/核心文档/更新日志.md)（帮助面板「更新日志」页签实时读取）；完整功能规格见 [docs/核心文档/系统功能说明书.md](docs/核心文档/系统功能说明书.md)。
>
> **新项目部署后**：数据源接入与数据配置（含问数质量保障）见 [docs/数据源配置与问数质量保障指导手册.md](docs/数据源配置与问数质量保障指导手册.md)——按数据源类型逐类讲解配置项与质量影响；质量运营（样例库/指标库/知识库/评测集/铁律等）见 [docs/数据资源库智能问数质量提升实操手册.md](docs/数据资源库智能问数质量提升实操手册.md)。

## 核心特性

### 智能问数（NL2SQL）
- **双阶段生成**：阶段一生成 SQL，阶段二基于真实查询结果生成解读与图表配置
- **SSE 流式进度**：`understanding → introspecting → executed → analyzing` 实时阶段反馈
- **歧义澄清交互**：问题存在多种理解时返回澄清选项，用户确认后重新提交
- **数据自省**（数据源级开关，默认关）：先执行探查 SQL 确认真实取值，再生成最终 SQL
- **语义缓存**：等价问题归一化后 10 分钟内命中缓存，秒级返回
- **few-shot 样例注入**：团队 SQL 样例库 + 本人历史成功问答对（个人沉淀）双通道挑选最相似的「问题-SQL」消息对注入上下文
- **embedding 圈表**：关键词粗排 + embedding 精排自动圈选相关表（不可用时降级纯关键词）
- **自学习闭环**：点赞自动沉淀为训练样例（auto_train）；点踩问答对以反面教材注入，避免重复同类错误
- **外部知识库注入**：接入企业级 RAG / 知识服务（Dify、RAGFlow、自建网关均可适配），与本地知识库并行检索注入（独立 token 预算，单源失败降级不阻断）
- **对话历史**：问数留痕服务端落库（跨设备共享），支持关键词搜索、一键重问、单条删除与 Markdown 导出
- **模型自选**：问数输入框旁下拉选择 AI 模型（Ollama 已安装模型实时列出，云端引擎百炼/Gemini/DeepSeek 按配置列入），选择随提问生效并持久化
- **推导过程回放**：全程步骤埋点（query_trace），完成后可展开时间线查看每环节 SQL/行数/耗时
- **结果文档导出**（v0.9.82）：问数结果区一键导出 PDF / Word / MD 文档（含提问原文、数据来源、AI 解读、核心指标、归因洞察、SQL、图表截图与明细前 100 行 / 前 12 列），服务端统一注入导出人水印并写入审计
- **计划模式**（开关）：先由 LLM 生成分析计划供批准，再携带 planId 执行
- **Agent 编排**（开关，P1-7）：提问先规划多能力步骤（取数 → 时序预测 → 多维归因），批准后逐步执行并汇总结果；计划 10 分钟有效、一次性消费（与计划模式互斥）
- **报告模式**（开关）：提问直接生成完整分析报告（摘要+KPI+图表+洞察），支持选择报告模板或智能推断；报告落库并可在「问数报告中心」集中管理
- **深度分析（中间表清洗链）**：复杂问题多步清洗并物化应用库中间表 `ait_*`（TTL 24h，失败不阻断）
- **降级兜底**：LLM/数据库不可用时返回带明确标识的示例数据

### 数据治理
- **多源接入**：MySQL / PostgreSQL / Greenplum / CSV / API / JSON；**接入自动化配置**（v0.9.73）——新数据源保存后自动完成 Schema 深度分析（时间列/分类维度/指标列识别 + 快照/版本/业务编号探查）并生成异常扫描能力配置（时序重算/维度检测/口径校验自动启用），前端展示「自动化配置报告」（已完成项/待确认项/建议操作）；预填铁律规则模板（PENDING 待确认）并自动生成知识库骨架条目（数据源概览/时间维度注意事项/快照口径/版本过滤）；**接入自动知识同步**（v0.9.83）——知识条目与 Schema 元数据自动切块向量入库（文档 ID 确定性哈希幂等、残留自动清理），接入即被问数检索到，并按真实表结构预置六类范式 few-shot 样例种子（趋势/排名/最新快照/版本过滤/去重计数/计数兜底），冷启动无需等待人工补录
- **首启初始化向导**（v0.9.85，仅管理员）：新部署首次启动自动进入五步引导（环境 检测 → 模型服务 → 数据自动准备 → 待办事项 → 完成），环境自检（数据库 / Redis /  模型 / 向量 / 演示数据）与数据源接入、知识向量化一站式跑通；支持跳过、断点续做与中途退出，暂不配置转顶部横幅（7 天免打扰），完成初始化后系统管理首屏「系统体检」卡片可随时复检；v0.9.86 Phase 2 增强——「数据自动准备」步支持「一键加载」内置演示数据集（确定性的销售 / 营销 / 库存三表 926 行样本，自动注册为数据源并完成向量化，幂等可重建），「系统体检」持续列出未处理待办项（铁律 / 阈值 / 知识样例），窄屏自适应优化；v0.9.87 完成后人工入口——「系统体检」卡片新增 [打开初始化向导]，向导完成后管理员仍可随时重开：回看各步骤快照或重跑任意环节（环境自检 / 模型探测 / 数据准备 / 待办更新），顶栏「已完成」标识，打开即拉取最新状态，仅查看维护、不影响系统使用
- **Scope 白名单 + 敏感列过滤**：问数仅访问授权表，敏感字段自动剔除
- **行级权限**：scope 登记表级行过滤谓词，所有真实执行链路由 AST 强制注入为过滤派生表（fail-closed）
- **语义指标层**：管理员登记指标口径（同义词/聚合表达式/固定过滤，带审批状态 PENDING/ACTIVE/REJECTED/DISABLED 与版本历史，仅 ACTIVE 参与注入），问数命中即模板化注入，口径全系统一致；使用侧在三级溯源的指标口径卡同步可见审批状态与版本历史（P0-4）
- **知识库**：业务术语、指标口径、字段含义检索注入（带 token 预算）；v0.9.78 检索升级——中文语义模型（qwen3-embedding，指令前缀按模型族自动适配 + 向量缓存键含模型防跨模型串用）、向量/关键词双通道 RRF 融合（精确术语词法救回）、相关性阈值实测上调 0.5（域外问题不再注入噪声知识），配套重嵌迁移脚本（`npm run reembed:embeddings`）与 31 条检索评测集（`npm run eval:retrieval`，命中率 92.9%/负例零注入 2/3）；可接入外部 RAG 知识服务（POST 检索协议 + 无/Bearer 认证，API Key 加密落库不出明文，接口配置仅管理员，支持生效范围与连通测试）
- **SQL 样例库**：训练语料 CRUD，支持批量粘贴 SQL 由 LLM 反推问题冷启动导入
- **技能库**：个人/系统提示模板，支持分享-审核流
- **数据血缘**（v0.9.71 升级为交互式图谱，仅管理员）：从报表/图表已存 SQL 与指标口径自动解析表级血缘（parsed 解析边 / declared 声明边 + stale 失效检测 + 解析覆盖率统计），React Flow 交互画布（缩放 / 小地图 / 悬停闭包高亮 / 分层布局）；点击节点一键「爆炸半径」影响分析（受影响报表 / 图表 / 指标清单 + 单击定位 + 只看相关链路 + 复制纯文本清单留档），支持搜索与类型过滤；服务不可用时自动降级本地估算

### 分析与呈现
- **可视化决策报表**：一键生成高管分析简报，支持报告计划模式（批准后生成）、PPT 下载（服务端 pptxgenjs）、PDF 导出、Excel/Word 下载（P0-2 服务端 exceljs / docx 组装）、图表批注与图表点击下钻明细（LIMIT 50）；图表同/环比对比仅限时间序列维度（分类维度自动禁用，防维度错配伪数据）；历史报表服务端持久化（团队共享），支持修改条件重新生成与删除维护；**异常扫描**（v0.9.73 服务端五步引擎）：「重新扫描异常」由服务端执行口径校验 → 时序重算 → 维度检测 → 领域阈值 → LLM 归因，结果按「口径存疑 / 数值异常」分区展示，严重异常附领域化归因；无 SQL 溯源报表自动降级本地扫描并提示
- **异常巡检**（P0-1）：数据源级巡检计划（每小时~每周）按期自动扫描最新真实数据报表，复用与报表页「重新扫描异常」同源的服务端五步引擎（v0.9.73：口径校验/时序重算/维度检测/领域阈值）主动预警，含立即巡检、暂停/启用、运行历史与异常明细（口径存疑项独立标注）；内置调度器多实例原子领取不重复执行；入口为系统管理「异常巡检」分类（v0.9.52 起统一入口，仅管理员）
- **三级数据溯源**（P0-3）：问数结果「查看生成的 SQL」逐级展开「指标口径卡（口径/审批状态/版本历史）→ 表关联图（主表+JOIN 链）→ SQL 与原始数据」
- **问数报告中心**：智能问数报告模式生成的报告集中展示与管理（列表/详情/删除/导出 PDF/PPT/Excel/Word），支持自定义报告模板（管理员维护，预设模板不可改删）
- **决策数据看板**：固化指标图表（服务端持久化、团队共享同一看板），适合日常巡检与大屏投放；支持拖拽排序、拽拉调尺寸与出厂默认图表
- **看板高级分析**（P1-5/6/9）：图表卡片三合一弹层——时序预测（移动平均/线性回归/季节分解 auto 回测择优，未来 N 期 + 80% 波动区间 + LLM 解读）、多维归因（最新两期贡献度拆解、正负分离排序 + LLM 结论）、情景推演（LLM 按「如果……会怎样」改写固化 SQL → 安全校验 → 双执行对比 + 解读）
- **灵活查询**：拖拉拽定制固定报表（服务端持久化、团队共享复用），最近查询历史跨设备同步；v0.9.80 增强——**画布字段图形化**（字段片：类型色块图标 + 主键/「已使用」徽章；悬停快捷筛选：数值→HAVING / 其余→WHERE；连接符悬停/编辑联动高亮两侧关联字段，INNER 靛蓝 / LEFT 琥珀着色，表头展示行数与字段数）；v0.9.79 增强——**表关系画布**（主表/关联表卡片化，字段带类型徽标、主键与「已使用」标记；字段可拖至查询配置区直接拼装 SQL 或点击快速添加；「表库」拖表/点击即建关联，关联条件按字段名智能预填，连接符可切换 INNER/LEFT、就地编辑关联字段、一键移除，与行式关联面板共享同一配置）；v0.9.77 增强——计算字段（指标结果列上白名单表达式，最多 4 个，可排序/进图表）、选表数据预览（前 10 行样例、敏感列剔除）、字段拼音搜索（jgmc→机构名称）、固定报表 Excel 导出（服务端重放 + 溯源水印，审计落账）、EXPLAIN 预估扫描行数提示（超 10 万行高亮）、图表扩展（KPI 卡片/散点图/堆叠/双轴）、版本历史与一键回滚（每次保存留快照）、报表订阅与阈值告警（周期 5 分钟~7 天、暂停/恢复/立即执行/运行历史）；v0.9.76 增强——语义指标直接入列（口径与全系统一致）、同比/环比/累计/移动平均时间衍生列、结果缓存与执行取消、后台大查询（任务队列）、OR 条件组、图表点击下钻；v0.9.75 增强——时间维度任意粒度（年/季/月/周/日）、日期快捷区间与低基数字段取值下拉、多列排序、结果合计行（截断自动隐藏、CSV 同步）、固定报表检索与星标收藏、历史一键「存为报表」
- **深浅色主题**：一键切换，偏好持久化
- **安装为桌面应用（PWA，v0.9.72）**：Chrome / Edge 一键安装为独立桌面应用（应用内「安装应用」按钮 + 地址栏原生安装入口）；零依赖手写 Service Worker 三线缓存（导航网络优先 / 同源静态缓存优先 / API 与 SSE 直通绝不缓存），断网可打开应用壳（登录界面 + 离线横幅提示），恢复联网自动还原

### 企业级安全
- **RBAC 三角色**：管理员 / 分析师 / 只读，前后端双重守卫
- **用户管理**：账号增删改查、启停、重置密码（首登强制改密）；用户「部门」从组织架构树中选取，节点名即部门文本，改名自动同步用户与数据源授权清单
- **组织架构**（v0.9.70）：总部 → 机构 → 部门 → 团队四级组织树，支持添加下级 / 重命名 / 同级排序 / 删除（带下级与用户归属双重删除保护）；节点数据标识按层级路径自动编号并支持一键补全，变更写入审计日志
- **八层纵深防御**：输入防护（截断+注入检测）→ 鉴权 → 限流（速率+配额+并发槽位）→ Schema 白名单 → 敏感过滤 → 只读 SQL 执行 → 审计落账 → 可观测日志
- **密钥保护**：数据源凭据加密存储；生产环境缺失 `JWT_SECRET` 拒绝启动

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + Vite + TypeScript + Tailwind CSS 4 + Zustand + Recharts + motion |
| 后端 | Express 4 + Node.js（tsx 开发 / esbuild 打包），含 Dockerfile |
| 数据 | MySQL（mysql2）、PostgreSQL/Greenplum（pg）；可选 Redis（`REDIS_URL`，限流/配额/缓存状态外置，未配则进程内存储） |
| AI | Ollama（本地）/ 通义千问百炼 / Gemini API / DeepSeek API，node-sql-parser |
| 测试 | Vitest（141 文件 / 2032 用例）+ NL2SQL 评测集（server/eval：主集 148 用例六类分层 + 行级权限类、机创集 54 用例、对比抽样集 60 用例；`npm run eval:seed` 一键重建可复现评测数据源；本地/云端模型对比见 [对比评估报告](docs/本地与云端模型问数对比评估报告20260914.md)） |

## 快速开始

### 前置条件

- Node.js ≥ 18
- MySQL 8（系统元数据库，首次启动自动建表）
- [Ollama](https://ollama.com)（本地 AI 引擎）：

```bash
ollama pull qwen3.8:27b-mlx      # 主推理模型（MLX 优化版；勿用 deepseek-r1 等推理模型，思考链分钟级会导致问数超时）
ollama pull nomic-embed-text     # embedding 模型（圈表精排用，可选）
```

- Python 3 + ReportLab（报告 PDF 导出，可选）：

```bash
pip3 install reportlab           # 服务端原生排版生成 PDF（无此依赖时 PDF 导出不可用，其余功能不受影响）
```

### 安装与配置

```bash
npm install
cp .env.example .env.local       # 按实际环境修改
```

### 启动

```bash
./start.sh           # 一键启动：自动拉起 MySQL + Redis（.env.local 配置本机 REDIS_URL 时）+ Ollama + 应用服务，
                     # 含 node_modules 首装/主模型与 embedding 模型/reportlab 自检提示，健康检查通过后打开浏览器
                     #（macOS 也可在 Finder 双击「启动应用.command」，首次双击被拦截时右键 → 打开）
npm run dev          # 或手动开发模式（tsx 直跑，前端 Vite 内嵌）
# 打开 http://127.0.0.1:3000
```

### 生产构建

```bash
npm run build        # 打包前端 + 服务端（dist/server.cjs）
NODE_ENV=production JWT_SECRET=<强密钥> npm start
```

### Docker 部署（P2-3）

多阶段构建：运行镜像仅含生产依赖与 `dist/` 产物，非 root 用户运行，内置 `node fetch` 探活（`HEALTHCHECK` 拉 `/api/health`）。

```bash
docker build -t smart-data-analytics .
docker run -d -p 3000:3000 \
  -e JWT_SECRET=<生产密钥> \
  -e MYSQL_HOST=<数据库地址> -e MYSQL_USER=<账号> -e MYSQL_PASSWORD=<密码> \
  -e MYSQL_DATABASE=smart_analytics \
  smart-data-analytics
```

容器内已固定 `HOST=0.0.0.0`；`JWT_SECRET` 缺失会 fail-fast 拒绝启动；多实例可加 `-e REDIS_URL=...` 做状态同步，密码哈希加固可加 `-e SCRYPT_PEPPER=...`。

### 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 管理员 |

> ⚠️ 首次部署请立即在「系统管理」中修改默认密码（服务端会持续告警提示）。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | 系统元数据库连接 | 127.0.0.1:3306 / smart_analytics |
| `LLM_MODEL` | Ollama 主模型（推荐 qwen3.8:27b-mlx；勿用 deepseek-r1 系列推理模型，思考链分钟级会致问数超时） | deepseek-r1:32b |
| `OLLAMA_URL` | Ollama 服务地址 | http://localhost:11434 |
| `OLLAMA_TIMEOUT_MS` | LLM 推理超时（毫秒） | 180000 |
| `EMBED_MODEL` | embedding 模型 | nomic-embed-text |
| `AI_ENGINE` | 引擎显式选择：ollama / gemini / qwen / deepseek | 按密钥存在性自动 |
| `QWEN_API_KEY` | 通义千问百炼 API Key | — |
| `QWEN_URL` | 百炼端点（Coding Plan 需专属端点） | https://dashscope.aliyuncs.com/compatible-mode/v1 |
| `QWEN_MODEL` | 通义千问模型 | qwen3.8-max |
| `QWEN_EMBED_MODEL` | 通义千问 embedding 模型 | text-embedding-v4 |
| `DEEPSEEK_API_KEY` | DeepSeek API Key（OpenAI 兼容协议） | — |
| `DEEPSEEK_URL` | DeepSeek API 端点 | https://api.deepseek.com/v1 |
| `DEEPSEEK_MODEL` | DeepSeek 模型（deepseek-flash = V4.1 Flash） | deepseek-flash |
| `DEEPSEEK_TIMEOUT_MS` | DeepSeek 推理超时（毫秒） | 180000 |
| `GEMINI_API_KEY` | Gemini API 密钥（备用引擎） | — |
| `JWT_SECRET` | JWT 签名密钥（生产必填） | dev 默认 |
| `JWT_EXPIRES_IN` | token 有效期 | — |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 初始管理员账号 | admin / admin123 |
| `DS_SECRET_KEY` | 数据源凭据加密密钥 | 缺省回退 JWT_SECRET |
| `PORT` / `HOST` | 服务端口 / 绑定地址 | 3000 / 127.0.0.1 |
| `RATE_LIMIT_MAX` / `USER_QUERY_RATE_MAX` | 全局限流 / 每用户问数配额（每用户配额填 `0` = 取消次数限制，不限次数） | — |
| `QUERY_RESULT_ROWS_MAX` | 问数结果行数上限（默认 500；填 `0` = 不限制——「提取全部明细」类提问按需给足，硬上限 10 万行防 OOM） | 500 |
| `SQL_EXPLAIN_MAX_ROWS` | EXPLAIN 防线：预估扫描行数超阈值则拦截并提示收窄条件（export 场景自动 ×10；0=关闭） | 1000000 |
| `SELF_CORRECT_CANDIDATES` | SQL 自纠错候选数（1-3，显式设置优先于分档） | 分档：复杂 3 / 简单 1 |
| `EXPECTED_CONCURRENT_USERS` | 预期并发用户数（连接池容量公式输入） | 20 |
| `DS_POOL_MAX` / `APP_POOL_MAX` | 数据源池 / 应用库池上限（显式配置优先于公式） | 公式推导（5 / 10） |

> v0.9.61 起，「系统管理 → 系统配置」面板可在线修改以上多数参数并**即时生效、无需重启**（面板保存值优先于 .env.local 且重启后保持；输入框留空=该项跟随 .env.local / 默认值）；每项配置显示「运行时」实际生效值供对账。例外：`MYSQL_*` 连接参数属于启动自举配置，不参与在线修改，需改 .env.local 并重启（面板仅登记）。

## 目录结构

```
server.ts                  # 服务入口（Express + Vite dev 中间件）
server/
  liveQuery.ts             # 双阶段 NL2SQL 主链路（自省/澄清/few-shot）
  schemaLinking.ts         # 关键词粗排 + embedding 精排圈表
  schemaContext.ts         # Scope 白名单 + 敏感列过滤 + 缓存
  queryCache.ts            # 语义结果缓存
  queryHooks.ts            # 问数生命周期钩子
  queryFeedback.ts         # 反馈与 SQL 样例库（auto_train）
  knowledgeBase.ts         # 业务知识库检索
  autoKnowledgeSync.ts     # 数据源接入自动知识同步（条目/Schema 向量入库 + few-shot 种子，v0.9.83）
  setupWizard.ts           # 首启初始化向导后端（状态机/环境探测/流水线快照，v0.9.84）
  setupDemoData.ts         # 首启向导演示数据集（确定性样本生成 + 一键加载注册，v0.9.86）
  externalKnowledge.ts     # 外部知识库接入（检索协议适配 + 密钥加密 + 聚合检索）
  conversationHistory.ts   # 对话历史服务端落库
  skillLibrary.ts          # 技能库（分享-审核流）
  sqlExecutor.ts           # 只读安全 SQL 执行
  auditLog.ts              # 问数审计
  llmClient.ts             # 统一 LLM 通道（Ollama/千问/Gemini/DeepSeek）
  anomalyPatrol.ts         # P0-1 异常巡检引擎（巡检计划/内置调度器/复用报表异常检测）
  queryExport.ts           # 问数结果文档导出（载荷归一化 + Markdown 生成，v0.9.82）
  queryExportWord.ts       # 问数结果 Word 导出（docx 组装，v0.9.82）
  pdfExport.ts             # 报告 / 问数结果 PDF 导出（spawn python3 调 ReportLab，stdin JSON → stdout PDF）
  pdfgen/report_pdf.py     # ReportLab 排版脚本（A4 竖/横版、中文 CID 字体、图表 PNG 嵌入）
  pdfgen/query_pdf.py      # 问数结果 PDF 排版脚本（A4 竖版、图表 PNG 嵌入，v0.9.82）
  routes/                  # auth/admin/datasources/knowledge/knowledge-external/sql-examples/skills/query/queryContext/report/patrols/metrics/conversations/help/setup
src/
  components/              # query/charts/reports/dashboard/datasource/setup/help/admin/auth
  hooks/  utils/  types/   # 状态管理（Zustand）与工具
docs/核心文档/            # 核心文档独立目录（v0.9.79）
docs/核心文档/用户使用指南.md    # 终端用户操作向导（系统内帮助实时读取）
docs/核心文档/更新日志.md        # 用户视角版本更新记录（帮助面板「更新日志」实时读取）
docs/核心文档/系统功能说明书.md  # 功能单一事实源（开发/评审侧，变更记录）
docs/数据源配置与问数质量保障指导手册.md  # 新项目部署数据源接入与数据配置指导（质量保证单一事实源）
docs/数据资源库智能问数质量提升实操手册.md  # 质量运营手册（七大杠杆/SOP/验收）
docs/training-ppt/         # 系统功能培训网页版 PPT（HTML slides，T 键切换字体主题）
```

## 测试与检查

```bash
npm test             # Vitest（141 文件 / 2032 用例）
npm run lint         # TypeScript 类型检查
```

## 文档维护约定

`docs/核心文档/系统功能说明书.md` 是系统功能的单一事实源（开发/评审侧）：每次功能新增或变更时同步更新该文件并在其「变更记录」章节追加一行；`docs/核心文档/用户使用指南.md` 是终端用户侧操作向导，随功能同步维护，系统 Header 右上角「帮助」按钮实时读取展示（指南缺失时自动回退说明书），帮助面板另有「更新日志」页签实时读取 `docs/核心文档/更新日志.md`（用户视角版本更新记录，随版本发布同步维护）。三份核心文档统一置于 `docs/核心文档/` 独立目录（v0.9.79）。

## 代码注释规范（v0.9.37 起执行）

注释面向「后来的维护者」，写**为什么这么做**，而不是复述代码做了什么。统一使用中文、四类模板：

**① 文件头块注释（每个模块必有）**
```ts
/**
 * <一句话职责：本模块是什么、为谁服务>。
 * 核心流程/职责：
 * - <要点 1>
 * - <要点 2>
 * 关键设计：<重要设计决策/上下游约束/降级策略，无则省略本节>
 */
```

**② 公开函数 / 组件注释（导出的必有）**
```ts
/**
 * <用途一句话，动词开头>。
 * @param 参数名 含义与约束（可选参数注明缺省行为）
 * @returns 返回什么；失败/异常时返回什么
 */
```
简单工具函数可用单行 `/** <用途> */`。

**③ 逻辑段注释（复杂分支必有）**：`// <目的与原因>：<业务规则出处/背景>`，说明「这段为什么存在」，不复述代码。

**④ 陷阱与不变量注释**：`// 注意：<必须遵守的顺序/不可变条件/历史坑>，违反会导致 <后果>`。

禁止：逐行翻译代码、注释与代码不一致、注释掉死代码（直接删除，历史在 Git 里）。

## Git 协作与提交规范（必须执行）

为保证多环境协作时代码始终一致，本项目强制执行以下 Git 工作流：

1. **修改前先拉取**：每次开始代码修改前，先 `git pull origin main` 拉取最新版本，确保基于最新代码开发，避免冲突累积。
2. **完成后自动提交推送**：代码修改完成并通过验证（`npm run lint` + `npm test`）后，执行 `git add -A` → `git commit`（语义化 message）→ 推送**双远程**：`git push origin main` 与 `git push gitee main`，使本地改动即时同步到 GitHub 与 Gitee。
3. **版本一致性**：任何时刻本地 `main` 应与两个远程（GitHub `origin/main`、Gitee `gitee/main`）保持一致，不得在本地长期积压未提交改动。

> 双远程：`origin` = `github.com/dgjin/smart-data-analytics`（主），`gitee` = `gitee.com/dgjin/smart-data-analytics`（国内镜像备份，私有）。GitHub 走 HTTPS + osxkeychain 凭据缓存，Gitee 走 SSH（公钥已登记，免密）。分支均为主 `main`；禁止 `push --force`。
