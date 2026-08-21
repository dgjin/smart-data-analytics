# 智能问数据分析系统 — 部署手册

> 版本：v1.0（对应系统 v0.4.5）  
> 适用部署方式：本地开发、Docker 容器、生产服务器

---

## 一、系统架构概览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         智能问数据分析系统 (Node.js + React)                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  前端 SPA     │  │  Express API │  │  NL2SQL 引擎 │  │  报告生成    │     │
│  │  React+Vite  │  │  JWT 鉴权    │  │  Ollama/    │  │  PPTX/PDF   │     │
│  │  Tailwind CSS│  │  RBAC 权限   │  │  Qwen/      │  │  导出        │     │
│  │              │  │  限流/审计   │  │  Gemini     │  │             │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                 │                 │             │
│         └─────────────────┴─────────────────┴─────────────────┘             │
│                                    │                                        │
│                         ┌──────────┴──────────┐                            │
│                         │   MySQL 元数据库     │                            │
│                         │  smart_analytics     │                            │
│                         │  (连接池 10 连接)     │                            │
│                         └─────────────────────┘                            │
│                                    │                                        │
│              ┌─────────────────────┼─────────────────────┐                 │
│              │                     │                     │                 │
│       ┌──────┴──────┐     ┌──────┴──────┐     ┌──────┴──────┐            │
│       │  业务库 A    │     │  业务库 B    │     │  CSV/文件   │            │
│       │  MySQL      │     │ PostgreSQL  │     │  (内存解析)  │            │
│       │  (实时查询)  │     │ Greenplum   │     │             │            │
│       └─────────────┘     └─────────────┘     └─────────────┘            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 数据库分层架构

本应用涉及 **两类数据库**，职责分离清晰：

| 层级 | 数据库 | 驱动 | 职责 | 数据持久化 |
|------|--------|------|------|-----------|
| **元数据库** | `smart_analytics` (MySQL) | `mysql2/promise` | 用户账号、数据源配置、知识库、指标库、SQL样例、技能库、对话历史、审计日志、LLM用量、中间表注册 | **必须持久化** |
| **业务数据源** | 用户配置的任意库 (MySQL/PostgreSQL/Greenplum/CSV) | `mysql2` / `pg` | NL2SQL 实际查询的目标库，Schema 自省、实时 SELECT 执行 | 只读连接，不写入 |

> **关键设计**：元数据库与业务数据源完全解耦。元数据库存储「系统知道什么」（配置、知识、历史），业务数据源存储「系统查什么」（业务事实数据）。应用启动时自动初始化元数据库表结构，业务数据源则在管理员配置后动态连接。

---

## 二、元数据库（smart_analytics）表结构详解

服务启动时由 `server/db.ts` 自动执行 `initSchema()`，完成建库、建表、迁移、种子数据写入。

### 2.1 用户与权限

#### `users` — 系统账号表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | INT PK | 自增主键 |
| `username` | VARCHAR(50) UNIQUE | 登录用户名（3-20位字母/数字/下划线） |
| `password_hash` | VARCHAR(255) | scrypt 哈希（可选 pepper 加固） |
| `display_name` | VARCHAR(50) | 显示名称 |
| `role` | ENUM | `ADMIN` / `ANALYST` / `VIEWER` |
| `status` | ENUM | `ACTIVE` / `DISABLED` |
| `must_change_password` | TINYINT | 首登/重置后强制改密标记 |
| `last_login_at` | TIMESTAMP | 最近登录时间 |

**种子行为**：`users` 表为空时，自动创建 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 指定的管理员账号，并标记 `must_change_password=1`（首次登录强制改密）。

### 2.2 数据源配置

#### `data_sources` — 数据源注册表

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | VARCHAR(64) PK | 数据源唯一标识（如 `ds_1786620486498`） |
| `name` | VARCHAR(128) | 显示名称 |
| `type` | VARCHAR(20) | `mysql` / `postgresql` / `greenplum` / `csv` / `demo` |
| `config_json` | TEXT | 连接配置（host/port/database/username/password），密码经 AES-256-GCM 加密 |
| `schema_json` | MEDIUMTEXT | 缓存的 Schema 结构（表/列/类型/描述） |
| `scope_json` | TEXT | 问数范围白名单（NULL = 不限制） |
| `allow_introspection` | TINYINT | 数据自省开关（0=关，默认关） |
| `status` | VARCHAR(20) | `connected` / `error` / `disabled` |

**连接方式**：问数时根据 `data_source_id` 读取配置 → 按类型选择驱动（`mysql2` 或 `pg`）→ 建立连接池执行 SELECT-only SQL。连接池按 `data_source_id` 缓存，配置变更后自动失效重建。

### 2.3 智能问数核心

#### `knowledge_base` — 业务知识库（RAG）

管理员登记的业务知识（指标口径、术语解释），按 `data_source_id` 隔离。问数时切块检索，注入 NL2SQL prompt。

| 字段 | 说明 |
|------|------|
| `doc_id` | 文档分组 ID（同一文档多 chunk 共享） |
| `chunk_text` | 知识文本块 |
| `embedding_json` | 向量表示（JSON 数组；NULL 时降级 bigram 词法匹配） |

#### `metric_definitions` — 语义指标库

结构化业务指标定义，问数命中后模板化注入 prompt，保证全系统口径一致。

| 字段 | 说明 |
|------|------|
| `name` | 指标名称 |
| `aliases_json` | 同义词 JSON 数组 |
| `expr` | 聚合表达式（如 `SUM(BNTFJE)`） |
| `table_name` | 归属表 |
| `filters` | 固定过滤条件（如 `BB = 1 AND BBRQ = (SELECT MAX(BBRQ) ...)`） |
| `status` | `ACTIVE` / `DISABLED` |

#### `sql_examples` — SQL 样例库（few-shot 训练语料）

| 字段 | 说明 |
|------|------|
| `question` | 自然语言问题 |
| `sql_text` | 对应 SQL |
| `source` | `MANUAL`（手工登记）/ `FEEDBACK_UP`（点赞自动沉淀）/ `IMPORT` |
| `embedding` | 问题向量（NULL 时降级 bigram） |

#### `skill_library` — 技能库

可复用 prompt 模板，分 `USER`（个人）和 `SYSTEM`（系统）两级作用域。个人技能可发起分享申请，管理员审核后进入系统库。

### 2.4 运行时可观测性

#### `query_audit_log` — 智能问数审计日志

全链路审计，含被拒绝的请求。每次问数无论成功与否均记录。

| 字段 | 说明 |
|------|------|
| `user_id` / `username` | 请求用户 |
| `endpoint` | 接口标识 |
| `question` | 用户问题 |
| `status` | `SUCCESS` / `FALLBACK` / `DENIED_INPUT` / `RATE_LIMITED` / `ERROR` |
| `executed_sql` | 实际执行的 SQL（失败时为空） |
| `row_count` | 返回行数 |
| `duration_ms` | 总耗时 |

#### `query_trace` — 推导过程留痕

问数全链路每步记录（理解 → 圈表 → SQL 生成 → 执行 → 解读），支持事后回放。

| 字段 | 说明 |
|------|------|
| `trace_id` | 单次问数唯一追踪 ID |
| `step_type` | `understanding` / `linking` / `sql_gen` / `execution` / `analysis` / `clarify` |
| `title` / `input_summary` / `output_summary` | 步骤描述与输入输出摘要 |
| `sql_text` | 本步涉及的 SQL |
| `duration_ms` | 本步耗时 |

#### `llm_usage` — LLM 用量埋点

每次 LLM 调用记录 token 与耗时，支撑多引擎成本对比与用户消耗审计。

| 字段 | 说明 |
|------|------|
| `engine` / `model` / `channel` | 引擎 / 模型 / 通道（json/text/embedding） |
| `user_id` / `username` | 请求用户（无上下文时归入「系统/后台」） |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | Token 消耗 |
| `duration_ms` | 调用耗时 |
| `ok` | 是否成功 |

### 2.5 对话与反馈

#### `conversation_history` — 对话历史

问数问答落库，支撑历史面板（搜索/重问/删除/导出），并沉淀为 few-shot 自学习语料。

#### `query_feedback` — 结果反馈

用户点赞（`UP`）/ 点踩（`DOWN`）。点赞的 live 记录自动沉淀为 SQL 样例。

### 2.6 中间表清洗链

#### `analysis_intermediate_tables` — 中间表注册

复杂分析时，先在源库跑 SELECT 清洗，结果落库应用库物理中间表（`ait_*`），TTL 默认 24h。启动时 + 每小时定时清理过期表。

| 字段 | 说明 |
|------|------|
| `table_name` | 物理表名（`ait_<hash>`） |
| `expires_at` | 过期时间 |
| `row_count` | 行数 |

### 2.7 外部知识库

#### `external_kb_sources` — 外部 RAG 服务配置

企业级外部知识服务接口，问数时与本地知识库一并检索注入。`api_key` 经 AES-256-GCM 加密落库。

---

## 三、数据库关系图

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     users       │◄────┤  query_audit_log │     │  query_trace    │
│  (系统账号)      │     │  (审计日志)      │     │  (推导留痕)      │
└────────┬────────┘     └─────────────────┘     └─────────────────┘
         │
         │ 1:N          ┌─────────────────┐     ┌─────────────────┐
         ├─────────────►│ conversation_history │ │  query_feedback  │
         │              │  (对话历史)      │     │  (点赞/点踩)     │
         │              └─────────────────┘     └─────────────────┘
         │
         │            ┌─────────────────────────────────────────┐
         │            │           data_sources                  │
         │            │  (数据源配置：MySQL/PostgreSQL/Greenplum/CSV) │
         │            │  ├─ config_json: 加密连接配置            │
         │            │  ├─ schema_json: 缓存的表结构            │
         │            │  └─ scope_json: 问数范围白名单           │
         │            └─────────────────────────────────────────┘
         │                           │
         │              ┌────────────┼────────────┐
         │              │            │            │
         │         ┌────┴────┐  ┌────┴────┐  ┌────┴────┐
         │         │knowledge│  │ metric_ │  │  sql_   │
         │         │  _base  │  │definitions│ │examples │
         │         │(知识库) │  │(指标库)  │  │(样例库) │
         │         └─────────┘  └─────────┘  └─────────┘
         │
         │            ┌─────────────────┐     ┌─────────────────┐
         └───────────►│  llm_usage      │     │ skill_library   │
                      │  (Token 用量)   │     │  (技能库)       │
                      └─────────────────┘     └─────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    外部数据源（只读连接，动态建池）                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │  MySQL 业务库 │  │ PostgreSQL  │  │  CSV/文件   │                  │
│  │  (mysql2)    │  │  (pg 驱动)  │  │  (内存解析)  │                  │
│  └─────────────┘  └─────────────┘  └─────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.1 关键关系说明

- **users → 所有审计/历史/用量表**：`user_id` 外键关联，记录操作归属
- **data_sources → knowledge_base / metric_definitions / sql_examples**：按 `data_source_id` 隔离，多数据源场景下知识/指标/样例各自独立
- **data_sources → 业务库**：`config_json` 存储连接信息，运行时动态建立只读连接池
- **query_feedback → sql_examples**：点赞（`UP` + `provenance='live'`）自动沉淀为样例
- **analysis_intermediate_tables → users**：按 `user_id` 限制每用户最多 10 张中间表

---

## 四、环境变量配置

复制 `.env.example` 为 `.env.local` 并按部署场景调整：

```bash
cp .env.example .env.local
```

### 4.1 必配项（所有环境）

| 变量 | 说明 | 示例 |
|------|------|------|
| `MYSQL_HOST` | 元数据库地址 | `127.0.0.1` |
| `MYSQL_PORT` | 元数据库端口 | `3306` |
| `MYSQL_USER` | 元数据库账号 | `root` |
| `MYSQL_PASSWORD` | 元数据库密码 | `your_mysql_password` |
| `MYSQL_DATABASE` | 元数据库名 | `smart_analytics` |
| `ADMIN_USERNAME` | 初始管理员账号 | `admin` |
| `ADMIN_PASSWORD` | 初始管理员密码 | `admin123`（首次登录强制改密） |

### 4.2 AI 引擎配置（至少配一种）

#### 方案 A：Ollama 本地模型（推荐，零云端成本）

```bash
OLLAMA_URL=http://localhost:11434
LLM_MODEL=deepseek-r1:32b        # 主推理模型
EMBED_MODEL=nomic-embed-text     # 圈表精排 embedding（可选）
OLLAMA_TIMEOUT_MS=180000         # 推理超时（毫秒）

# 阶段二快速路由（可选，提速解读）
LLM_ANALYSIS_ENGINE=ollama
LLM_ANALYSIS_MODEL=deepseek-r1:8b
```

前置要求：
```bash
# 安装 Ollama（macOS/Linux）
curl -fsSL https://ollama.com/install.sh | sh

# 拉取模型
ollama pull deepseek-r1:32b
ollama pull nomic-embed-text
```

#### 方案 B：通义千问（百炼平台）

```bash
QWEN_API_KEY=sk-your-key
QWEN_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_MODEL=qwen3.8-max
# QWEN_EMBED_MODEL=text-embedding-v4
```

> 注意：Coding Plan Key（`sk-sp-xxx`）必须使用专属端点 `https://coding.dashscope.aliyuncs.com/v1`

#### 方案 C：Gemini

```bash
GEMINI_API_KEY=your-gemini-key
```

### 4.3 生产安全必配项

| 变量 | 说明 | 生成方式 |
|------|------|---------|
| `JWT_SECRET` | JWT 签名密钥 | `openssl rand -hex 32` |
| `JWT_EXPIRES_IN` | Token 有效期 | `12h` |
| `DS_SECRET_KEY` | 数据源凭据加密密钥 | `openssl rand -hex 32`（缺省回退 JWT_SECRET） |
| `SCRYPT_PEPPER` | 密码哈希加固（可选） | `openssl rand -hex 32` |

> **生产 fail-fast**：未设置 `JWT_SECRET` 时，`NODE_ENV=production` 下服务直接拒绝启动。

### 4.4 可选配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `HOST` | 监听地址 | `127.0.0.1`（生产设为 `0.0.0.0`） |
| `REDIS_URL` | 状态外置（多实例扩展） | 无（进程内存） |
| `RATE_LIMIT_MAX` | 全局限流阈值 | `100` |
| `USER_QUERY_RATE_MAX` | 每用户查询限流 | `20` |
| `SELF_CORRECT_CANDIDATES` | SQL 自纠错候选数（1-3，显式设置优先于分档） | 分档：复杂问题 3 / 简单问题 1 |
| `SEMANTIC_CACHE_THRESHOLD` | L2 语义缓存命中阈值（0.5-1.0，误命中代价高宜保守；实测同域近似问题 0.85~0.95 区间会误命中，故默认 0.95，更换 embedding 模型需重新标定） | `0.95` |
| `EXPECTED_CONCURRENT_USERS` | 预期并发用户数（连接池容量公式输入，P1-9） | `20` |
| `DS_POOL_MAX` | 数据源连接池上限（显式配置优先于公式 ceil(并发/4)，clamp 3-20） | 公式推导（默认 5） |
| `APP_POOL_MAX` | 应用元数据库连接池上限（显式配置优先于公式 ceil(并发/2)，clamp 10-50） | 公式推导（默认 10） |

---

## 五、部署方式

### 5.1 本地开发部署

**前置要求**：Node.js 22+、MySQL 8.0+、Ollama（如选本地模型）

```bash
# 1. 克隆项目
git clone <repo-url>
cd smart-data-analytics

# 2. 安装依赖
npm install

# 3. 配置环境
cp .env.example .env.local
# 编辑 .env.local，填入 MySQL 密码和 AI 引擎配置

# 4. 启动 MySQL（如未运行）
# macOS: brew services start mysql
# Linux: sudo systemctl start mysql

# 5. 启动开发服务（自动初始化数据库）
npm run dev

# 6. 访问
open http://localhost:3000
```

首次启动时自动完成：
- 创建 `smart_analytics` 数据库（如不存在）
- 创建/迁移所有表结构
- 写入种子数据（默认管理员账号 + 演示数据源）
- 加密存量明文密码

### 5.2 Docker 部署（推荐生产）

**单容器部署**：

```bash
# 构建镜像
docker build -t smart-data-analytics .

# 运行（生产必须设置 JWT_SECRET）
docker run -d -p 3000:3000 \
  -e NODE_ENV=production \
  -e HOST=0.0.0.0 \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e MYSQL_HOST=mysql-host \
  -e MYSQL_PORT=3306 \
  -e MYSQL_USER=analytics \
  -e MYSQL_PASSWORD=strong-password \
  -e MYSQL_DATABASE=smart_analytics \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=$(openssl rand -hex 16) \
  -e OLLAMA_URL=http://ollama-host:11434 \
  -e LLM_MODEL=deepseek-r1:32b \
  smart-data-analytics
```

**docker-compose 完整栈**（含 MySQL + Ollama + 应用）：

```yaml
# docker-compose.yml
version: '3.8'

services:
  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: root_password
      MYSQL_DATABASE: smart_analytics
    volumes:
      - mysql_data:/var/lib/mysql
    ports:
      - "3306:3306"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

  ollama:
    image: ollama/ollama:latest
    volumes:
      - ollama_data:/root/.ollama
    ports:
      - "11434:11434"
    # GPU 支持（nvidia-docker）
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: 3000
      JWT_SECRET: ${JWT_SECRET}
      MYSQL_HOST: mysql
      MYSQL_PORT: 3306
      MYSQL_USER: root
      MYSQL_PASSWORD: root_password
      MYSQL_DATABASE: smart_analytics
      ADMIN_USERNAME: admin
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      OLLAMA_URL: http://ollama:11434
      LLM_MODEL: deepseek-r1:32b
      EMBED_MODEL: nomic-embed-text
    depends_on:
      mysql:
        condition: service_healthy
      ollama:
        condition: service_started

volumes:
  mysql_data:
  ollama_data:
```

启动：
```bash
export JWT_SECRET=$(openssl rand -hex 32)
export ADMIN_PASSWORD=$(openssl rand -hex 16)
docker-compose up -d
```

### 5.3 生产服务器部署

**系统要求**：
- OS: Ubuntu 22.04 LTS / CentOS 8 / macOS 14+
- CPU: 4 核+（LLM 推理建议 8 核+）
- RAM: 16GB+（32GB 可流畅运行 32B 参数模型）
- Disk: 50GB+ SSD
- GPU: 可选（Ollama 支持 CUDA/Metal 加速）

**步骤**：

```bash
# 1. 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. 安装 MySQL 8.0
sudo apt-get install -y mysql-server
sudo mysql_secure_installation

# 3. 创建数据库和用户
sudo mysql -e "CREATE DATABASE smart_analytics CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
sudo mysql -e "CREATE USER 'analytics'@'localhost' IDENTIFIED BY 'strong_password';"
sudo mysql -e "GRANT ALL PRIVILEGES ON smart_analytics.* TO 'analytics'@'localhost';"
sudo mysql -e "FLUSH PRIVILEGES;"

# 4. 安装 Ollama（如使用本地模型）
curl -fsSL https://ollama.com/install.sh | sh
ollama pull deepseek-r1:32b
ollama pull nomic-embed-text

# 5. 部署应用
git clone <repo-url> /opt/smart-data-analytics
cd /opt/smart-data-analytics
npm ci

# 6. 配置环境变量
sudo tee /opt/smart-data-analytics/.env.local > /dev/null << 'EOF'
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
JWT_SECRET=<openssl-rand-hex-32>
DS_SECRET_KEY=<openssl-rand-hex-32>
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=analytics
MYSQL_PASSWORD=strong_password
MYSQL_DATABASE=smart_analytics
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<initial-strong-password>
OLLAMA_URL=http://127.0.0.1:11434
LLM_MODEL=deepseek-r1:32b
EMBED_MODEL=nomic-embed-text
EOF

# 7. 构建
npm run build

# 8. 使用 PM2 守护运行
sudo npm install -g pm2
pm2 start dist/server.cjs --name "smart-data-analytics"
pm2 startup
pm2 save

# 9. Nginx 反向代理（SSL）
sudo tee /etc/nginx/sites-available/smart-data-analytics > /dev/null << 'EOF'
server {
    listen 443 ssl http2;
    server_name analytics.yourcompany.com;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/smart-data-analytics /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 六、数据库运维

### 6.1 备份策略

```bash
# 每日全量备份（crontab）
0 2 * * * mysqldump -u analytics -p'strong_password' smart_analytics > /backup/sa_$(date +\%Y\%m\%d).sql

# 保留 7 天
0 3 * * * find /backup -name 'sa_*.sql' -mtime +7 -delete
```

### 6.2 性能优化

```sql
-- 检查慢查询（需开启 slow_query_log）
SELECT * FROM mysql.slow_log WHERE start_time > DATE_SUB(NOW(), INTERVAL 1 DAY);

-- 清理过期审计日志（保留 90 天）
DELETE FROM query_audit_log WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- 清理过期对话历史（保留 180 天）
DELETE FROM conversation_history WHERE created_at < DATE_SUB(NOW(), INTERVAL 180 DAY);

-- LLM 用量表分区（大数据量时）
-- ALTER TABLE llm_usage PARTITION BY RANGE (YEAR(created_at)) (...);
```

### 6.3 监控指标

| 指标 | 查询 | 告警阈值 |
|------|------|---------|
| 元数据库连接数 | `SHOW STATUS LIKE 'Threads_connected';` | > 80% max_connections |
| 慢查询数量 | `SHOW GLOBAL STATUS LIKE 'Slow_queries';` | 每小时 > 10 |
| 磁盘空间 | `df -h` | > 85% |
| 应用内存 | `pm2 monit` | > 80% |
| Ollama 响应 | `curl http://localhost:11434/api/ps` | 模型加载失败 |

---

## 七、故障排查

### 7.1 启动失败

| 现象 | 原因 | 解决 |
|------|------|------|
| `生产环境必须设置 JWT_SECRET` | 生产环境未配 JWT_SECRET | 设置 `JWT_SECRET` 环境变量 |
| `Database pool not initialized` | MySQL 连接失败 | 检查 MySQL 地址/端口/账号/密码 |
| `EACCES permission denied` | 端口权限不足 | 使用 >1024 端口或以 root 运行 |

### 7.2 问数失败

| 现象 | 原因 | 解决 |
|------|------|------|
| `查询超时` | LLM 推理过慢 | 换用更小模型或上调 `OLLAMA_TIMEOUT_MS` |
| `引用问数范围外的表` | SQL 校验误拒 | 检查 scope 白名单配置 |
| `数据源不存在` | data_source_id 错误 | 确认数据源已配置且状态为 connected |
| `UNSUPPORTED_DS_TYPE` | 数据源类型不支持 | 仅支持 mysql/postgresql/greenplum |

### 7.3 健康检查

```bash
# 服务健康
curl http://localhost:3000/api/health
# {"status":"ok","timestamp":"2026-08-18T..."}

# AI 引擎状态（需登录）
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/system/engine

# 数据库连接
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/system/llm-usage?days=7
```

---

## 八、安全基线

1. **生产环境必设 `JWT_SECRET`** — 未设置拒绝启动
2. **数据源密码加密** — 所有落库密码经 AES-256-GCM 加密，更换 `DS_SECRET_KEY` 后需重新录入
3. **SQL 只读执行** — 所有业务数据源查询强制 SELECT-only，禁止 DML/DDL
4. **表名白名单** — 仅允许查询 scope 配置内的表，敏感列自动过滤
5. **密码安全** — scrypt 哈希 + 可选 pepper，首登强制改密，5 次错误锁定 15 分钟
6. **CSP 响应头** — 生产环境启用内容安全策略
7. **非 root 运行** — Docker 容器内使用 `node` 用户（uid=1000）

---

## 九、版本兼容性

| 组件 | 最低版本 | 推荐版本 | 说明 |
|------|---------|---------|------|
| Node.js | 20 | 22 | ESM + fetch 原生支持 |
| MySQL | 5.7 | 8.0 | utf8mb4 + JSON 列支持 |
| PostgreSQL | 12 | 15 | 用于业务数据源 |
| Greenplum | 6 | 6 | MPP 数仓场景 |
| Ollama | 0.3 | 0.5 | 本地模型推理 |
| Redis | 6 | 7 | 可选，多实例状态同步 |

---

*文档维护：系统功能更新时同步修订本手册，确保与代码实现一致。*
