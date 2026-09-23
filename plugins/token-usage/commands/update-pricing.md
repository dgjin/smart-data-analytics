---
description: 检查并更新 Qoder Token 用量插件的模型价格表（从插件公开仓库同步最新官网参考价）
argument-hint: [--check 只检查 ｜ --dry-run 只看差异（可选）]
allowed-tools: [Read, Glob, Bash]
---

# 更新模型价格表

## Arguments

用户输入：$ARGUMENTS（可为空；支持透传 `--check`（只检查不写入）/ `--dry-run`（只显示差异）/ `--force`（跳过 24h 节流））

## Instructions

1. 定位技能目录（取已安装的最新版本，记为 SKILL_DIR）：

   ```bash
   ls -d ~/.qoder/plugins/cache/*/token-usage/*/skills/token-usage/ 2>/dev/null | sort -V | tail -1
   ```

   - 该写法同时覆盖本地安装（`cache/local/...`）与市场安装（`cache/qoder-marketplace/...`）；
   - Windows PowerShell 等价写法：
     `Get-ChildItem "$env:USERPROFILE\.qoder\plugins\cache\*\token-usage\*\skills\token-usage" | Select-Object -Last 1`；
   - 若没有输出，说明插件未安装或未启用：提示用户先在 Qoder 插件面板安装 `token-usage`，不要继续执行后续步骤。

2. 运行价格表更新（默认检查并更新；24 小时内重复执行会自动跳过）：

   ```bash
   python3 <SKILL_DIR>/scripts/update_pricing.py
   ```

   - 用户显式带了参数（`--check` / `--dry-run` / `--force`）时原样透传。

3. 汇报结果（简明，不要贴全量输出）：

   - **已更新**：报「价格表已从 vX 更新到 vY（变更 N 处）」，附变更摘要中的关键行（价格变化 / 新增 / 移除）与备份文件名；
   - **已是最新**：报「当前价格表 vY 已是最新（最近检查 <时间>）」；
   - **网络失败 / 被节流**：报「本次未联网（原因），本地价格表保持不变」，说明不影响正常统计，可稍后重试。

4. 若用户随后想按新价看费用，运行：

   ```bash
   python3 <SKILL_DIR>/scripts/usage_report.py --days 7
   ```

## Notes

- 更新只从插件公开仓库下载价格表（双源：Gitee 优先、GitHub 兜底），不上传任何本地数据；`TOKEN_USAGE_NO_NET=1` 或 `--offline` 可完全禁用联网。
- 写入前做结构与数值校验、原子替换并自动备份（`pricing.json.bak-<时间戳>`，保留 3 份）；不合法内容会被拒绝、原文件不变。
- 价格口径与来源见技能 `SKILL.md` 的「参考价格 / 价格自动更新」章节。
