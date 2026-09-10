---
kind: build_system
name: Node.js 全栈构建与容器化交付体系
category: build_system
scope:
    - '**'
source_files:
    - Dockerfile
    - package.json
    - vite.config.ts
    - .github/workflows/ci.yml
    - playwright.config.ts
    - start.sh
    - docker-compose.monitoring.yml
    - tsconfig.json
    - tsconfig.server.json
    - deploy/prometheus.yml
    - deploy/alertmanager-entrypoint.sh
---

## 1. 构建系统总览

本项目采用 **Vite + esbuild** 的 Node.js 全栈构建方案：前端使用 Vite（React + Tailwind CSS）生成静态资源，服务端通过 `esbuild` 将 `server.ts` 打包为单文件 CJS（`dist/server.cjs`），最终由 Docker 多阶段镜像在 Alpine 上以非 root 用户运行。版本管理集中在根 `package.json` 的 `version` 字段，并通过 Vite 的 `define` 注入为前端全局常量 `import.meta.env.VITE_APP_VERSION`，实现单一事实源。

## 2. 关键文件与职责

- `Dockerfile`：双阶段构建（`node:22-alpine` 作为 build 与 runtime 基础镜像）。构建阶段执行 `npm ci` + `npm run build`；运行阶段仅安装生产依赖（`npm ci --omit=dev`），拷贝 `dist/`，暴露 3000 端口，并通过内置 `fetch` 调用 `/api/health` 做健康检查。
- `package.json`：定义全部脚本入口——`dev`（tsx 热重载）、`build`（vite build && esbuild bundle）、`start`、`lint`（tsc 无输出类型检查，分前端/strict/server 三套 tsconfig）、`test`（vitest）、`test:e2e`（playwright）、`eval` / `loadtest` 等评测脚本。
- `vite.config.ts`：配置 React/Tailwind 插件、`@/*` 路径别名、CSP 开发头、HMR 开关（受 `DISABLE_HMR` 控制）、以及 Vitest 排除 E2E 用例。
- `tsconfig.json` / `tsconfig.server.json` / `tsconfig.strict.json`：共享基础 TS 配置，server 端继承并启用 `strict`，前端额外启用 strictNullChecks。
- `.github/workflows/ci.yml`：GitHub Actions 质量门禁——push/PR 到 main 触发，依次执行 tsc（前端+server+strict）、eslint、OpenAPI 同步校验、进程状态巡检、vitest 全量单测；另起 `eval-gate` 作业校验评测集结构（≥100 条、六类覆盖）并在 prompt 相关文件变更时提示本地全量评测。
- `playwright.config.ts`：E2E 测试配置，默认复用已运行的 dev server（`reuseExistingServer`），CI 下自动拉起 `npx tsx server.ts` 并等待 `/api/health` 就绪。
- `start.sh`：本地一键启动脚本，按序检查/启动 MySQL、Redis（可选，仅本机地址时拉起）、Ollama、reportlab，最后以 `nohup npx tsx server.ts` 启动应用并轮询 `/api/health`。
- `docker-compose.monitoring.yml`：监控栈编排（Prometheus + Alertmanager + Grafana + node/redis/mysql exporter），通过卷挂载 `deploy/` 下的配置文件，独立于主应用。

## 3. 架构与设计约定

- **多阶段镜像最小化**：构建期安装全部 devDependencies 以完成 Vite/esbuild 编译，运行期仅保留生产依赖，镜像体积显著缩小。
- **安全基线**：容器内以 `USER node` 非 root 运行；未设置 `JWT_SECRET` 时服务 fail-fast 拒绝启动（与 `server.ts` 一致）；监听 `0.0.0.0` 而非 `127.0.0.1`。
- **健康检查统一**：Docker HEALTHCHECK、Playwright webServer、`start.sh` 均通过轮询 `/api/health` 判定就绪。
- **版本注入**：构建期从 `package.json` 读取版本号，经 Vite define 注入前端，保证前后端版本唯一来源。
- **测试分层**：单元测试（vitest，含 `*.test.ts`）、E2E（playwright，`tests/e2e/*.spec.ts`）、评测集（`server/eval/`，mock-free 不连 DB/LLM）三者分离，CI 中分别执行。
- **监控可插拔**：通过独立的 `docker-compose.monitoring.yml` 编排 Prometheus/Grafana，应用侧通过 prom-client 暴露 `/metrics`，无需修改主应用代码。

## 4. 约定与约束

- **依赖安装**：构建与 CI 强制使用 `npm ci`（锁定包版本），禁止 `npm install` 进入流水线。
- **TypeScript 严格模式**：服务端走 `tsconfig.server.json`（`strict: true`），前端额外走 `tsconfig.strict.json` 开启 `strictNullChecks`，CI 中三者均需通过。
- **ESLint 规则**：通过 `eslint.config.js`（根目录）统一管理，CI 中 `npm run lint:js` 必须通过。
- **OpenAPI 同步**：`npm run docs:check` 校验代码路由与 `docs/openapi.json` 一致性，纳入 CI 质量门禁。
- **进程状态无状态约束**：`npm run state:check` 拦截白名单外的模块级可变存储，确保服务可水平扩展。
- **环境变量驱动部署**：所有运行时配置（数据库、Redis、LLM、告警 Webhook 等）通过环境变量注入，Dockerfile 注释明确列出必需/可选变量。
- **本地开发依赖链**：`start.sh` 要求 MySQL(:3306)、可选 Redis(:6379)、Ollama(:11434) 先于应用就绪，任一缺失会给出明确失败信息。
- **E2E 浏览器策略**：优先复用系统 Chrome（`channel: 'chrome'`），避免 Playwright CDN 下载，CI 环境可切换为 `browserName: 'chromium'`。
- **监控凭据安全**：MySQL Exporter 通过挂载只读 `.my.cnf` 注入密码，不使用 DATA_SOURCE_NAME 环境变量，cnf 文件权限建议 600。

## 5. 发布流程

当前仓库未包含 npm publish 或 GitHub Releases 自动化步骤；发布流程主要依赖 Docker 镜像构建（`docker build -t smart-data-analytics .`），版本由 `package.json` 的 `version` 字段维护，需人工更新后重新构建镜像。CI 仅负责质量门禁与评测集结构校验，不包含产物上传环节。