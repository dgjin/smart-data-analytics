#!/bin/sh
# Alertmanager 启动渲染脚本：
# alertmanager 无原生环境变量展开能力（v0.27~v0.34 实测均无 --config.expand-env flag），
# 启动时将 alertmanager.tpl.yml 中的 __ALERT_WEBHOOK_URL__ 占位符替换为 ALERT_WEBHOOK_URL 环境变量值。
# v0.9.94 自动运维智能体旁路：__OPS_AGENT_WEBHOOK_URL__ 同理渲染；
# 未设置 OPS_AGENT_WEBHOOK_URL 时删除 # 【BEGIN-OPS-AGENT】～# 【END-OPS-AGENT】标记段
# （routes 中的旁路路由与 receivers 中的 ops-agent 定义），保证未接入时配置合法且行为与旧版一致。
set -eu

RAW="${ALERT_WEBHOOK_URL:-http://127.0.0.1:9/blackhole}"
# sed 替换串需转义反斜杠、&（整段匹配）与分隔符 |
ESC=$(printf '%s' "$RAW" | sed 's/[\\&|]/\\&/g')
sed "s|__ALERT_WEBHOOK_URL__|$ESC|g" /etc/alertmanager/alertmanager.tpl.yml > /tmp/alertmanager.yml

if [ -n "${OPS_AGENT_WEBHOOK_URL:-}" ]; then
  OPS_ESC=$(printf '%s' "$OPS_AGENT_WEBHOOK_URL" | sed 's/[\\&|]/\\&/g')
  sed "s|__OPS_AGENT_WEBHOOK_URL__|$OPS_ESC|g" /tmp/alertmanager.yml > /tmp/alertmanager.yml.tmp
  mv /tmp/alertmanager.yml.tmp /tmp/alertmanager.yml
else
  # 标记段裁剪（两段各自成对：routes 旁路路由 + receivers ops-agent 定义）
  sed '/# 【BEGIN-OPS-AGENT】/,/# 【END-OPS-AGENT】/d' /tmp/alertmanager.yml > /tmp/alertmanager.yml.tmp
  mv /tmp/alertmanager.yml.tmp /tmp/alertmanager.yml
fi

exec /bin/alertmanager --config.file=/tmp/alertmanager.yml --storage.path=/alertmanager
