---
description: 刷新 Qoder Token 用量统计，并把 IDE 内 Canvas 仪表盘链接返回给用户（覆盖官方模型与自定义模型）
argument-hint: [时间范围：7 / 30 / 90 / all，默认 7]
allowed-tools: [Read, Glob, Bash]
---

# Qoder Token 用量仪表盘

## Arguments

用户输入：$ARGUMENTS（可为空；支持 `7` / `30` / `90` / `all`，也接受"近 30 天"等自然表达）

## Instructions

1. 定位技能目录（取已安装的最新版本，记为 SKILL_DIR）：

   ```bash
   ls -d ~/.qoder/plugins/cache/*/token-usage/*/skills/token-usage/ 2>/dev/null | sort -V | tail -1
   ```

   - 该写法同时覆盖本地安装（`cache/local/...`）与市场安装（`cache/qoder-marketplace/...`）；
   - Windows PowerShell 等价写法：
     `Get-ChildItem "$env:USERPROFILE\.qoder\plugins\cache\*\token-usage\*\skills\token-usage" | Select-Object -Last 1`；
   - 若没有输出，说明插件未安装或未启用：提示用户先在 Qoder 插件面板安装 `token-usage`，不要继续执行后续步骤。

2. （价格自检，推荐）先运行价格表自检——24h 节流、静默失败，不影响统计：

   ```bash
   python3 <SKILL_DIR>/scripts/update_pricing.py --check
   ```

   - 提示有新版本时：运行 `python3 <SKILL_DIR>/scripts/update_pricing.py` 完成更新，并在汇报中注明「价格表已更新至 vX」；
   - 提示已是最新、被节流跳过或执行失败：忽略，继续下一步。

3. 生成 / 刷新 Canvas 仪表盘（一次生成即包含 近 7 天 / 近 30 天 / 近 90 天 / 全部历史 四档数据）：

   ```bash
   python3 <SKILL_DIR>/scripts/build_canvas.py --workspace "<当前工作区绝对路径>"
   ```

   - `--workspace` 必须是**当前会话的工作区根目录绝对路径**，确保画布写入当前项目对应的
     `~/.qoder/projects/<project-slug>/canvases/` 目录；不要使用其它项目的路径。

4. 把脚本输出的 canvas 绝对路径以 Markdown 链接形式返回给用户（点击即可在 IDE 的 Canvas 面板打开，无需浏览器）。

5. 按用户指定的范围简要报数（未指定则默认近 7 天）：总 Tokens、参考费用、消息数。
   如需更细的按天 / 按模型 / 按项目明细，运行：

   ```bash
   python3 <SKILL_DIR>/scripts/usage_report.py --days <7|30|90|0> --by day|model|project
   ```

6. 若用户还想要浏览器版 HTML 仪表盘：

   ```bash
   python3 <SKILL_DIR>/scripts/build_dashboard.py --open
   ```

## Notes

- 数据为 Qoder 本地数据库的一次只读快照，不自动更新；本命令每次执行都会重新生成最新数据。
- `python3` 不可用时改用 `python`（Windows 常见）或 `py -3`，需 Python 3.8+；数据库路径默认跨平台自动探测，也可用环境变量 `QODER_DB_PATH` 或 `--db` 指定。
- 自定义模型（BYOK）费用按其主力模型 DeepSeek-Flash 官网价折算；Qoder 官方档位无公开单价，费用列显示 —。
- 价格表自检/更新（`update_pricing.py`）是唯一的联网动作，只下载公开价格表、不上传数据；`TOKEN_USAGE_NO_NET=1` 或 `--offline` 可禁用。
- 口径与计价细节见技能 `SKILL.md` 的「数据源与口径 / 参考价格 / 价格自动更新」章节。
