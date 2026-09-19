---
kind: "repo_knowledge"
category: "configuration_system"
title: "基于 .env + 进程环境变量的运行时配置系统"
scopes: ["**"]
updated_at: "2026-09-13T15:42:16Z"
---

# 基于 .env + 进程环境变量的运行时配置系统

## 1. 采用的方案

本仓库没有使用任何第三方配置框架（如 `config`、`conf`、`yaml` 解析器），而是采用 **纯环境变量 + dotenv** 的极简配置体系：

- 启动入口 `server.ts` 在加载任何模块前，通过 `dotenv.config()` 依次从三个候选目录（`__dirname`、`path.join(__dirname, '..')`、`process.cwd()`）加载 `.env.local` 和 `.env`，利用 dotenv “已存在值优先”的特性实现覆盖。
- 所有业务模块通过 **惰性读取 `process.env.XXX`** 的方式获取配置，避免 ESM import 提升导致 dotenv 尚未执行的问题（注释明确说明“ESM import 提升会使模块级 process.env 读取早于 dotenv.config()，因此必须惰性读取”）。
- 生产模式由 `NODE_ENV=production` 或运行产物位于 `dist/` 自动判定；开发模式走 Vite dev server，生产模式静态托管 `dist/`。

## 2. 关键文件与位置

| 职责 | 文件 | 说明 |
|---|---|---|
| 入口与环境加载 | `server.ts` | 加载 `.env.local` / `.env`，校验生产必需密钥（`JWT_SECRET`），启动时预热 Redis、注册任务队列、健康检查等 |
| MySQL 连接池与建库 | `server/infra/db.ts` | 读取 `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE`，按 `EXPECTED_CONCURRENT_USERS` 推导连接池上限，幂等建表并播种默认管理员与数据源 |
| 多后端状态存储 | `server/infra/stateStore.ts` | `REDIS_URL` 未配置 → 内存实现；配置后切换为 Redis 实现，提供缓存/限流/分布式锁抽象 |
| LLM 引擎选择 | `server/llm/llmClient.ts` | 通过 `AI_ENGINE`、`LLM_MODEL`、`QWEN_API_KEY`、`GEMINI_API_KEY`、`LLM_SQL_ENGINE/MODEL`、`LLM_ANALYSIS_ENGINE/MODEL` 等决定主引擎、阶段路由、超时、重试、熔断 |
| JWT 鉴权 | `server/auth/auth.ts` | 读取 `JWT_SECRET`、`JWT_EXPIRES_IN`，生产缺失直接拒绝启动（fail-fast） |
| 凭据加密 | `server/infra/secretsCrypto.ts` | 用 `DS_SECRET_KEY`（回退 `JWT_SECRET`）派生 AES-256-GCM 密钥，对数据源密码落库加密 |
| 示例模板 | `.env.example` | 列出全部可配置环境变量（作为部署清单） |

## 3. 架构与设计约定

### 3.1 配置来源优先级（从高到低）
1. 进程级 `process.env`（容器编排注入、CI 变量）
2. `.env.local`（本地覆盖，gitignore）
3. `.env`（项目级默认）
4. 代码内硬编码默认值（各模块函数内 `|| 'default'`）

### 3.2 惰性读取约定
几乎所有模块都遵循同一模式：把 `process.env.XXX` 的读取放在函数体内而非模块顶层，例如 `db.ts` 的 `mysqlBase()`、`dbName()`、`appPoolMax()`；`auth.ts` 的 `jwtSecret()`、`jwtExpiresIn()`；`stateStore.ts` 的 `getStateStore()`；`llmClient.ts` 的 `llmModel()`、`qwenUrl()`、`engineKind()`。这是为了兼容 ESM 的 import hoisting 与 dotenv 的执行时序。

### 3.3 安全强制项（fail-fast）
- 生产环境（`NODE_ENV=production` 或运行 `dist/server.cjs`）缺少 `JWT_SECRET` 时直接 `process.exit(1)`，防止 JWT 伪造。
- 生产环境缺少 `METRICS_TOKEN` 时输出告警日志，提示 `/metrics` 将无鉴权暴露。
- 数据源凭据统一经 `secretsCrypto.encryptConfigPassword` 加密后再写入 `data_sources.config_json`，启动时扫描存量明文并就地迁移。

### 3.4 可插拔后端通过环境变量切换
- **状态存储**：`REDIS_URL` 为空 → `MemoryStateStore`；非空 → `RedisStateStore`，键命名约定 `qp:`/`rqp:`/`qc:`/`uql:`/`rl:` 等前缀。
- **LLM 引擎**：`AI_ENGINE` 显式指定 `ollama/gemini/qwen`；否则按密钥存在性自动选择（有 `GEMINI_API_KEY`→gemini，有 `QWEN_API_KEY`→qwen，否则 ollama）。支持请求级覆盖（`AsyncLocalStorage`）与阶段级路由（`LLM_SQL_ENGINE/MODEL`、`LLM_ANALYSIS_ENGINE/MODEL`）。
- **Ollama 多后端**：通过 `ollamaBackends` 维护节点池，失败自动切换次优节点。

### 3.5 容量与韧性参数化
- 应用库连接池：`APP_POOL_MAX` 显式优先；否则按 `EXPECTED_CONCURRENT_USERS / 2` 推导，clamp 到 `[10, 50]`。
- LLM 韧性：`LLM_RETRY_MAX`（默认 2）、`LLM_MAX_CONCURRENT`（默认 4）、`LLM_BREAKER_FAILS`（默认 3）、`LLM_BREAKER_COOLDOWN_MS`（默认 30s）、`LLM_ADAPTIVE_TIMEOUT`（默认开启自适应超时）。
- Qwen 超时：`QWEN_TIMEOUT_MS`（默认 180s）。

## 4. 已知约束与规则

- **禁止在模块顶层读取 `process.env`**：多处注释强调 ESM import 提升会早于 dotenv 执行，必须在函数内惰性读取。
- **生产密钥不可缺省**：`JWT_SECRET` 是硬性要求；`DS_SECRET_KEY` 用于数据源凭据加密，缺失时回退 `JWT_SECRET`，但生产应单独配置。
- **`.env.local` 优先于 `.env`**：dotenv 多次加载不覆盖已有值，先加载者优先，因此 `.env.local` 可用于覆盖 `.env` 中的默认值。
- **默认管理员账号首次登录强制改密**：`initSchema` 种子用户设置 `must_change_password=1`，`authMiddleware` 拦截除 `/api/auth/*` 外的所有接口。
- **Redis 冷启动降级**：`warmStateStore` 最多等待 5s，超时仅告警不阻断启动；限流 fail-closed、缓存 fail-open，保证降级路径安全。
- **前端构建产物不携带服务端配置**：Vite 构建的浏览器端无法访问 `process.env`，所有服务端配置仅在 `server.ts` 及 `server/**` 中读取，前端通过 `/api/system/engine`、`/api/system/models` 等只读接口获取当前生效的模型信息。

## 5. 总结

该仓库的配置系统以“环境变量即配置”为核心，零依赖、无配置文件格式，通过统一的惰性读取约定、fail-fast 安全检查、以及按功能域划分的模块级默认值，实现了开发/测试/生产三套环境的平滑切换。新增配置项只需在对应模块函数中添加 `process.env.XXX || default` 并在 `.env.example` 中补充说明即可，无需改动配置加载管线。
