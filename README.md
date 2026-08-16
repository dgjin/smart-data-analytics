# 智能问数分析系统（NL2SQL Pro）

企业级自然语言数据分析平台：用中文提问，系统自动理解语义、匹配数据表结构、生成并执行 SQL，将真实查询结果转化为图表、KPI 与洞察解读，并可一键产出高管决策简报。

> 完整功能说明见 [docs/系统功能说明书.md](docs/系统功能说明书.md)（系统内「帮助」按钮实时读取该文档）。

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
- **模型自选**：问数输入框旁下拉选择 AI 模型（Ollama 已安装模型实时列出，百炼/Gemini 按配置列入），选择随提问生效并持久化
- **推导过程回放**：全程步骤埋点（query_trace），完成后可展开时间线查看每环节 SQL/行数/耗时
- **计划模式**（开关）：先由 LLM 生成分析计划供批准，再携带 planId 执行
- **深度分析（中间表清洗链）**：复杂问题多步清洗并物化应用库中间表 `ait_*`（TTL 24h，失败不阻断）
- **降级兜底**：LLM/数据库不可用时返回带明确标识的示例数据

### 数据治理
- **多源接入**：MySQL / PostgreSQL / Greenplum / CSV / API / JSON
- **Scope 白名单 + 敏感列过滤**：问数仅访问授权表，敏感字段自动剔除
- **行级权限**：scope 登记表级行过滤谓词，所有真实执行链路由 AST 强制注入为过滤派生表（fail-closed）
- **语义指标层**：管理员登记指标口径（同义词/聚合表达式/固定过滤），问数命中即模板化注入，口径全系统一致
- **知识库**：业务术语、指标口径、字段含义检索注入（带 token 预算）；可接入外部 RAG 知识服务（POST 检索协议 + 无/Bearer 认证，API Key 加密落库不出明文，接口配置仅管理员，支持生效范围与连通测试）
- **SQL 样例库**：训练语料 CRUD，支持批量粘贴 SQL 由 LLM 反推问题冷启动导入
- **技能库**：个人/系统提示模板，支持分享-审核流
- **数据血缘**：数据流向与依赖可视化

### 分析与呈现
- **可视化决策报表**：一键生成高管分析简报，支持报告计划模式（批准后生成）、PPT 下载（服务端 pptxgenjs）、PDF 导出、图表批注与图表点击下钻明细（LIMIT 50）
- **决策数据看板**：固化指标图表，适合日常巡检与大屏投放
- **深浅色主题**：一键切换，偏好持久化

### 企业级安全
- **RBAC 三角色**：管理员 / 分析师 / 只读，前后端双重守卫
- **八层纵深防御**：输入防护（截断+注入检测）→ 鉴权 → 限流（速率+配额+并发槽位）→ Schema 白名单 → 敏感过滤 → 只读 SQL 执行 → 审计落账 → 可观测日志
- **密钥保护**：数据源凭据加密存储；生产环境缺失 `JWT_SECRET` 拒绝启动

## 技术栈

| 层 | 技术 |
|----|------|
| 前端 | React 19 + Vite + TypeScript + Tailwind CSS 4 + Zustand + Recharts + motion |
| 后端 | Express 4 + Node.js（tsx 开发 / esbuild 打包），含 Dockerfile |
| 数据 | MySQL（mysql2）、PostgreSQL/Greenplum（pg）；可选 Redis（`REDIS_URL`，限流/配额/缓存状态外置，未配则进程内存储） |
| AI | Ollama（本地）/ 通义千问百炼 / Gemini API，node-sql-parser |
| 测试 | Vitest（45 文件 / 459 用例）+ NL2SQL 评测集（server/eval，16 用例） |

## 快速开始

### 前置条件

- Node.js ≥ 18
- MySQL 8（系统元数据库，首次启动自动建表）
- [Ollama](https://ollama.com)（本地 AI 引擎）：

```bash
ollama pull deepseek-r1:32b      # 主推理模型（可用 LLM_MODEL 覆盖）
ollama pull nomic-embed-text     # embedding 模型（圈表精排用，可选）
```

### 安装与配置

```bash
npm install
cp .env.example .env.local       # 按实际环境修改
```

### 启动

```bash
npm run dev          # 开发模式（tsx 直跑，前端 Vite 内嵌）
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
| `LLM_MODEL` | Ollama 推理模型 | deepseek-r1:32b |
| `OLLAMA_URL` | Ollama 服务地址 | http://localhost:11434 |
| `OLLAMA_TIMEOUT_MS` | LLM 推理超时（毫秒） | 180000 |
| `EMBED_MODEL` | embedding 模型 | nomic-embed-text |
| `AI_ENGINE` | 引擎显式选择：ollama / gemini / qwen | 按密钥存在性自动 |
| `QWEN_API_KEY` | 通义千问百炼 API Key | — |
| `QWEN_URL` | 百炼端点（Coding Plan 需专属端点） | https://dashscope.aliyuncs.com/compatible-mode/v1 |
| `QWEN_MODEL` | 通义千问模型 | qwen3.8-max |
| `QWEN_EMBED_MODEL` | 通义千问 embedding 模型 | text-embedding-v4 |
| `GEMINI_API_KEY` | Gemini API 密钥（备用引擎） | — |
| `JWT_SECRET` | JWT 签名密钥（生产必填） | dev 默认 |
| `JWT_EXPIRES_IN` | token 有效期 | — |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 初始管理员账号 | admin / admin123 |
| `DS_SECRET_KEY` | 数据源凭据加密密钥 | 缺省回退 JWT_SECRET |
| `PORT` / `HOST` | 服务端口 / 绑定地址 | 3000 / 127.0.0.1 |
| `RATE_LIMIT_MAX` / `USER_QUERY_RATE_MAX` | 全局限流 / 每用户问数配额 | — |
| `SELF_CORRECT_CANDIDATES` | SQL 自纠错候选数 | — |

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
  externalKnowledge.ts     # 外部知识库接入（检索协议适配 + 密钥加密 + 聚合检索）
  conversationHistory.ts   # 对话历史服务端落库
  skillLibrary.ts          # 技能库（分享-审核流）
  sqlExecutor.ts           # 只读安全 SQL 执行
  auditLog.ts              # 问数审计
  llmClient.ts             # Ollama/Gemini 统一 LLM 通道
  routes/                  # auth/admin/datasources/knowledge/knowledge-external/sql-examples/skills/query/queryContext/report/metrics/conversations/help
src/
  components/              # query/charts/reports/dashboard/datasource/help/admin/auth
  hooks/  utils/  types/   # 状态管理（Zustand）与工具
docs/系统功能说明书.md      # 功能单一事实源（系统内帮助实时读取）
docs/training-ppt/         # 系统功能培训网页版 PPT（HTML slides）
```

## 测试与检查

```bash
npm test             # Vitest（459 用例）
npm run lint         # TypeScript 类型检查
```

## 文档维护约定

`docs/系统功能说明书.md` 是系统功能的单一事实源：每次功能新增或变更时同步更新该文件并在其「变更记录」章节追加一行；系统 Header 右上角「帮助」按钮实时读取展示。
