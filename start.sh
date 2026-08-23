#!/bin/bash
# ============================================================
# 智能问数据分析系统 · 一键启动
# 依赖链：MySQL(:3306) → Ollama(:11434) → 应用服务(:3000)
# 用法：终端执行 ./start.sh，或双击「启动应用.command」
# ============================================================
set -u
cd "$(dirname "$0")"

# 双击 .command 时 PATH 精简，补齐 node/mysql/ollama 常见安装位置
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

LOG_FILE="/tmp/app_server.log"
APP_URL="http://localhost:3000"

say()  { echo "[$(date '+%H:%M:%S')] $*"; }
ok()   { say "[ OK ] $*"; }
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

# ---------- 0. 配置检查 ----------
[ -f .env.local ] || fail ".env.local 不存在，请先执行：cp .env.example .env.local 并按实际环境修改"

# ---------- 1. MySQL ----------
if lsof -ti :3306 >/dev/null 2>&1; then
  ok "MySQL 已在运行（:3306）"
else
  say "启动 MySQL ..."
  mysql.server start >/dev/null 2>&1 &
  wait_port 3306 40 "MySQL" || fail "MySQL 启动超时，请手动执行 mysql.server start 排查"
fi

# ---------- 2. Ollama ----------
if curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  ok "Ollama 已在运行（:11434）"
else
  say "启动 Ollama ..."
  open -a Ollama >/dev/null 2>&1 || nohup ollama serve >/dev/null 2>&1 &
  wait_http "http://localhost:11434/api/tags" 30 "Ollama（:11434）" \
    || fail "Ollama 启动超时，请手动打开 Ollama 应用"
fi

# 主模型存在性软检查（缺失仅提示不阻断）
MAIN_MODEL=$(grep -E '^LLM_MODEL=' .env.local | tail -1 | cut -d= -f2- | tr -d '[:space:]')
MAIN_MODEL=${MAIN_MODEL:-qwen3.8:27b-mlx}
ollama list 2>/dev/null | awk 'NR>1{print $1}' | grep -qx "${MAIN_MODEL}" \
  || say "[提示] 主模型 ${MAIN_MODEL} 未安装，首次问数前请执行：ollama pull ${MAIN_MODEL}"

# ---------- 3. 应用服务 ----------
if lsof -ti :3000 >/dev/null 2>&1; then
  say "停止旧实例（:3000）..."
  lsof -ti :3000 | xargs kill -9 2>/dev/null
  sleep 1
fi

say "启动应用服务（日志：${LOG_FILE}）..."
nohup npx tsx server.ts > "${LOG_FILE}" 2>&1 &

if wait_port 3000 40 "应用服务"; then
  grep -E "\[DB\]|\[AI Engine\]|Running on" "${LOG_FILE}" | sed 's/^/           /'
  say "打开浏览器 ${APP_URL}"
  open "${APP_URL}"
  echo ""
  ok "全部就绪：${APP_URL}"
else
  say "----- 最近日志 -----"
  tail -15 "${LOG_FILE}"
  fail "应用启动超时，完整日志见 ${LOG_FILE}"
fi
