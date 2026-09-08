#!/bin/bash
# ============================================================
# 智能问数据分析系统 · 一键启动
# 依赖链：MySQL(:3306) → [Redis(:6379)，仅当 .env.local 配置本机 REDIS_URL]
#         → Ollama(:11434) → 应用服务(:3000)
# 用法：终端执行 ./start.sh，或双击「启动应用.command」
# ============================================================
set -u
cd "$(dirname "$0")"

# 双击 .command 时 PATH 精简，补齐 node/mysql/redis/ollama 常见安装位置
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

LOG_FILE="/tmp/app_server.log"
APP_URL="http://localhost:3000"

say()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { say "[ OK ] $*"; }
warn() { say "[提示] $*"; }
fail() { say "[失败] $*"; exit 1; }

# 轮询等待端口就绪：$1=端口 $2=超时秒 $3=名称
wait_port() {
  for _ in $(seq 1 "$2"); do
    lsof -ti :"$1" >/dev/null 2>&1 && { ok "$3 就绪（:${1}）"; return 0; }
    sleep 1
  done
  return 1
}

# 轮询等待 HTTP 就绪：$1=URL $2=超时秒 $3=名称
wait_http() {
  for _ in $(seq 1 "$2"); do
    curl -s --max-time 2 "$1" >/dev/null 2>&1 && { ok "${3} 就绪"; return 0; }
    sleep 1
  done
  return 1
}

# 从 .env.local 读取配置项（取最后一个有效定义，去空白）
env_get() { grep -E "^$1=" .env.local 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]'; }

# ---------- 0. 配置与依赖检查 ----------
[ -f .env.local ] || fail ".env.local 不存在，请先执行：cp .env.example .env.local 并按实际环境修改"

command -v node >/dev/null 2>&1 || fail "未找到 node，请先安装 Node.js（建议 LTS）"
if [ ! -d node_modules ]; then
  say "首次运行，安装依赖（npm install）..."
  npm install || fail "npm install 失败，请检查网络后重试"
fi

# 开发环境 JWT_SECRET 未配置时进程级临时密钥：重启后登录态失效（仅提示）
[ -n "$(env_get JWT_SECRET)" ] || warn "JWT_SECRET 未配置，开发模式使用临时密钥（重启后需重新登录）；生产部署请务必配置"

# ---------- 1. MySQL ----------
if lsof -ti :3306 >/dev/null 2>&1; then
  ok "MySQL 已在运行（:3306）"
else
  say "启动 MySQL ..."
  mysql.server start >/dev/null 2>&1 &
  wait_port 3306 40 "MySQL" || fail "MySQL 启动超时，请手动执行 mysql.server start 排查"
fi

# ---------- 2. Redis（可选：仅当 REDIS_URL 配置且指向本机时负责拉起） ----------
REDIS_URL=$(env_get REDIS_URL)
if [ -n "${REDIS_URL}" ]; then
  # 提取 host:port（兼容 redis://[:密码@]host:port/db 写法）
  REDIS_HOSTPORT=$(echo "${REDIS_URL}" | sed -E 's#^redis://([^@]*@)?([^/]+).*#\2#')
  case "${REDIS_HOSTPORT}" in
    127.0.0.1:*|localhost:*)
      REDIS_PORT=${REDIS_HOSTPORT##*:}
      if lsof -ti :"${REDIS_PORT}" >/dev/null 2>&1; then
        ok "Redis 已在运行（:${REDIS_PORT}）"
      else
        say "启动 Redis ..."
        brew services start redis >/dev/null 2>&1 || nohup redis-server --daemonize yes >/dev/null 2>&1 &
        wait_port "${REDIS_PORT}" 20 "Redis" \
          || warn "Redis 启动超时：查询缓存/状态外置将不可用（应用自动回退内存模式，功能不受影响）"
      fi
      ;;
    *)
      # 远端 Redis：只做连通性提示，不负责拉起
      if nc -z "${REDIS_HOSTPORT%:*}" "${REDIS_HOSTPORT##*:}" 2>/dev/null; then
        ok "远端 Redis 可达（${REDIS_HOSTPORT}）"
      else
        warn "远端 Redis ${REDIS_HOSTPORT} 不可达：应用将回退内存模式（单实例功能不受影响）"
      fi
      ;;
  esac
else
  say "REDIS_URL 未配置：使用进程内存模式（单机零依赖，行为一致）"
fi

# ---------- 3. Ollama ----------
if curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  ok "Ollama 已在运行（:11434）"
else
  say "启动 Ollama ..."
  open -a Ollama >/dev/null 2>&1 || nohup ollama serve >/dev/null 2>&1 &
  wait_http "http://localhost:11434/api/tags" 30 "Ollama（:11434）" \
    || fail "Ollama 启动超时，请手动打开 Ollama 应用"
fi

# 模型存在性软检查（缺失仅提示不阻断）：主模型 + embedding 模型（语义缓存精排/知识库导入用）
MAIN_MODEL=$(env_get LLM_MODEL); MAIN_MODEL=${MAIN_MODEL:-qwen3.8:27b-mlx}
ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "${MAIN_MODEL}" \
  || warn "主模型 ${MAIN_MODEL} 未安装，首次问数前请执行：ollama pull ${MAIN_MODEL}"
EMBED_MODEL=$(env_get EMBED_MODEL); EMBED_MODEL=${EMBED_MODEL:-nomic-embed-text}
ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "${EMBED_MODEL}" \
  || warn "embedding 模型 ${EMBED_MODEL} 未安装（影响语义缓存命中与知识库导入精度）：ollama pull ${EMBED_MODEL}"

# ---------- 4. 可选依赖：reportlab（报表 PDF 导出用） ----------
python3 -c "import reportlab" >/dev/null 2>&1 \
  || warn "reportlab 未安装，报表 PDF 导出不可用（其余功能不受影响）：pip3 install reportlab"

# ---------- 5. 应用服务 ----------
if lsof -ti :3000 >/dev/null 2>&1; then
  say "停止旧实例（:3000）..."
  lsof -ti :3000 | xargs kill -9 2>/dev/null
  sleep 1
fi

say "启动应用服务（日志：${LOG_FILE}）..."
nohup npx tsx server.ts > "${LOG_FILE}" 2>&1 &

# 就绪判定升级为健康端点（200 = 路由挂载完成可正常服务）
if wait_http "${APP_URL}/api/health" 45 "应用服务（:3000）"; then
  grep -E "\[DB\]|\[AI Engine\]|Running on" "${LOG_FILE}" | sed 's/^/           /'
  say "打开浏览器 ${APP_URL}"
  open "${APP_URL}"
  echo ""
  ok "全部就绪：${APP_URL}（默认账号 admin / admin123，首次登录请修改密码）"
else
  say "----- 最近日志 -----"
  tail -15 "${LOG_FILE}"
  fail "应用启动超时，完整日志见 ${LOG_FILE}"
fi
