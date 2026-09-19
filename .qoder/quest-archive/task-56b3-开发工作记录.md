# Quest 任务记录：开发工作记录（帮助 / 知识库 / 流式输出 / Greenplum）

> **任务 ID**：`task-56b365522a3e48799f60`（初始标题"领导欢送祝福视频"，标题由首条消息生成，实际为多项开发工作）
> **时间**：2026-08-26 ~ 08-28（35 条有效用户消息 / 1,300 行记录）
> **工作目录**：`/Users/dgjin/dgjinapp/智能问数据分析系统`
> **当时版本**：v0.9.0 ~ v0.9.1

---

## 一、任务内容总览

此任务在一个会话内连续完成了 5 个专项，均为本项目功能：

| 专项 | 时间 | 核心内容 |
|------|------|----------|
| 1. 系统帮助功能优化 | 08-27 | 帮助不能说"有什么"，要说"怎么用" |
| 2. 对标 LangChain + P0-P3 完善 | 08-27 | 结构化输出升级、数据资源库初始化、P1-2 流式输出 |
| 3. 知识库导入导出 | 08-28 | 备份导出与恢复备份 |
| 4. Greenplum 兼容性修复 | 08-28 | sql_identifier 报错、Schema 参数、视图提取 |
| 5. 本地部署与 CSP 修复 | 08-28 | 本地部署、Content Security Policy 修复 |

---

## 二、工作过程时间线

### 08-26

- （首条消息为欢送会祝福语文案，属个人事务，已从本归档剔除）
- 16:48 "分公司画像体系.docx 将附件转换为模版" —— 为后续山东分公司画像报告做模板准备

### 08-27：帮助功能 + 对标 + P0-P3

| 时间 | 工作项 |
|------|--------|
| 08:15 | 提出帮助功能优化原则：**"系统帮助不能简单将功能说明书替代，而是要告诉用户系统怎么用"** |
| 08:40 | 要求对标 LangChain 的实现和功能，给出项目优化建议 |
| 10:59 | 按 P0-P3 进行完善 |
| 11:03 | **P0-1 结构化输出升级** |
| 11:32 | **数据资源库作为内置测试数据源**：统一放到系统初始化部署文件，含完整数据 + 业务知识库，部署时一键初始化 |
| 11:46 | 强调"业务知识库内容必须完整，除数据外其他相关内容都要完整" |
| 12:35 | **P1-2 Token 级流式输出**：千问解析 SSE `data: {...}` 提取 `choices[].delta.content`；Ollama 解析 SSE 事件提取 `message.content`；前端 QueryChat.tsx 维护 streamingContent state 增量渲染 |
| 12:55 | 将 kb_004 / kb_005 作为独立任务后续完善 |
| 13:58 | 按计划推进完成剩余任务 |

### 08-28：知识库导入导出 + Greenplum + CSP + 部署

| 时间 | 工作项 |
|------|--------|
| 08:44 | **业务知识库导入导出功能**：知识库备份导出与恢复备份 |
| 10:26 | **Greenplum 数据源报错**：`function format(unknown, information_schema.sql_identifier, information_schema.sql_identifier) does not exist` |
| 10:31 | 按长期方案解决 TypeScript 编译错误问题 |
| 11:52 | GP 数据源仍失败 + 指出"增加 GP 数据源时缺少 schema 配置参数" |
| 11:57 | 提交到服务器 |
| 13:11 | 在本地安装 Greenplum 数据库 |
| 13:59 | GP 数据资源读取展现为只读视图，未完整解析 |
| 14:08 | 立即本地部署 |
| 15:27 | 一个对象都解析不出来 → 仔细检查修复 |
| 15:33 | **CSP 报错**：`Refused to execute inline script because it violates "script-src 'self'"` |
| 15:42 | 提交到 gitee |
| 15:51 | 读取 schema 时把视图也要加进去 |

---

## 三、关键交付物

### 1. 数据资源库内置测试数据源（P0-3）

- **`server/seedDataResources.ts`**（368 行）：数据资源库完整配置
- 统一纳入系统初始化部署文件，部署时方便数据初始化
- 包含：数据、业务知识库等完整内容（业务知识库除数据外的相关内容全部完整）
- 已沉淀为记忆：「数据资源库内置测试数据源初始化方案」

### 2. P1-2 Token 级流式输出（完整实现）

- **后端真实流式处理**（`server/llmClient.ts` +230 行）：
  - 千问 / Ollama / Gemini 三种引擎的 SSE 流式解析
  - 千问：解析 `data: {...}` 格式，提取 `choices[].delta.content`
  - Ollama：解析 SSE 事件，提取 `message.content`
- **前端增量渲染**：QueryChat.tsx 维护 streamingContent state，每收到 chunk 即触发重渲染

### 3. 业务知识库导入导出

- 知识库备份导出（JSON 格式）+ 恢复备份功能
- 冲突策略（overwrite 版本递增）后续沉淀为记忆：「指标库导入导出行为规范：overwrite策略版本递增」

### 4. Greenplum 兼容性修复（多项）

| 问题 | 修复 |
|------|------|
| `format(sql_identifier, sql_identifier)` 不存在 | GP 元数据查询兼容性改写（后续沉淀为「pg_catalog 元数据提取统一方案」） |
| 缺少 Schema 配置参数 | GP 数据源表单新增 "Schema 名称" 输入框（如 pmart_res） |
| 对象解析不完整 | 修复后普通表 / 外部表 / 视图 / 物化视图均可提取 |
| 视图未展示 | 读取 schema 时将视图一并纳入（类型扩展：TABLE / VIEW / MATERIALIZED_VIEW / FOREIGN_TABLE / SEQUENCE / 分区表） |

### 5. 视图提取与展示完整支持（提交 `d81f5a9`，已推送 GitHub/Gitee）

- **类型定义扩展**：`src/types/analytics.ts` 新增 `tableType` 字段
- **UI 可视化**（SchemaViewer.tsx）：
  - 👁️ 视图（紫色 Eye）、🗃️ 物化视图（粉色 Database）、📦 外部表（绿色 Box）、📚 分区表（蓝色 Layers）、🔢 序列（琥珀色 Hash）
- **后端数据传递**：`server/routes/datasources.ts` 的 `assembleTables` 传递 `tableType`

### 6. 本地部署（v0.9.1，提交 `b82e408`）

- 服务端口 3000、MySQL `127.0.0.1:3306/smart_analytics`、AI 引擎 Ollama（qwen3.8:27b-mlx）
- Greenplum 数据源完整接入（Schema 参数 + 各类对象识别）

### 7. CSP 安全策略修复

- 修复 `script-src 'self'` 拦截内联脚本问题，形成修复报告文档并同步至 Gitee

---

## 四、本任务形成的工程经验（后续已沉淀为记忆）

1. **帮助文档定位**：帮助功能要说"怎么用"（操作指引），而非罗列"有什么"（说明书替代）
2. **知识库完整性红线**：内置测试数据源的业务知识库必须内容完整
3. **Greenplum/PostgreSQL 兼容**：`information_schema.sql_identifier` 类型需显式转换，元数据提取统一走 `pg_catalog`
4. **视图类对象**：Schema 提取必须覆盖视图/物化视图/外部表，且视图默认可展示（灰色标注不可问数）
