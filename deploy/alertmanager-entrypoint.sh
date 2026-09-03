#!/bin/sh
# Alertmanager 启动渲染脚本：
# alertmanager 无原生环境变量展开能力（v0.27~v0.34 实测均无 --config.expand-env flag），
# 启动时将 alertmanager.tpl.yml 中的 __ALERT_WEBHOOK_URL__ 占位符替换为 ALERT_WEBHOOK_URL 环境变量值。
set -eu

RAW="${ALERT_WEBHOOK_URL:-http://127.0.0.1:9/blackhole}"
# sed 替换串需转义反斜杠、&（整段匹配）与分隔符 |
ESC=$(printf '%s' "$RAW" | sed 's/[\\&|]/\\&/g')
sed "s|__ALERT_WEBHOOK_URL__|$ESC|g" /etc/alertmanager/alertmanager.tpl.yml > /tmp/alertmanager.yml

exec /bin/alertmanager --config.file=/tmp/alertmanager.yml --storage.path=/alertmanager
