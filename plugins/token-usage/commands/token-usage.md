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
   ls -d ~/.qoder/plugins/cache/local/token-usage/*/skills/token-usage/ | sort -V | tail -1
   ```

2. 生成 / 刷新 Canvas 仪表盘（一次生成即包含 近 7 天 / 近 30 天 / 近 90 天 / 全部历史 四档数据）：

   ```bash
   python3 <SKILL_DIR>/scripts/build_canvas.py --workspace "<当前工作区绝对路径>"
   ```

   - `--workspace` 必须是**当前会话的工作区根目录绝对路径**，确保画布写入当前项目对应的
     `~/.qoder/projects/<project-slug>/canvases/` 目录；不要使用其它项目的路径。

3. 把脚本输出的 canvas 绝对路径以 Markdown 链接形式返回给用户（点击即可在 IDE 的 Canvas 面板打开，无需浏览器）。

4. 按用户指定的范围简要报数（未指定则默认近 7 天）：总 Tokens、参考费用、消息数。
   如需更细的按天 / 按模型 / 按项目明细，运行：

   ```bash
   python3 <SKILL_DIR>/scripts/usage_report.py --days <7|30|90|0> --by day|model|project
   ```

5. 若用户还想要浏览器版 HTML 仪表盘：

   ```bash
   python3 <SKILL_DIR>/scripts/build_dashboard.py --open
   ```

## Notes

- 数据为 Qoder 本地数据库的一次只读快照，不自动更新；本命令每次执行都会重新生成最新数据。
- 自定义模型（BYOK）费用按其主力模型 DeepSeek-Flash 官网价折算；Qoder 官方档位无公开单价，费用列显示 —。
- 口径与计价细节见技能 `SKILL.md` 的「数据源与口径 / 参考价格」章节。
