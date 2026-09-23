---
name: token-usage
version: 0.1.0
description: 统计 Qoder 桌面端的 token 消费计量——同时覆盖 Qoder 官方模型额度与自定义模型（BYOK / custom_model）。数据来自 Qoder 本地数据库（每条消息的 token 明细：输入/输出/缓存命中），支持按天、按模型、按项目聚合，可按 pricing.json 中的官网单价换算参考费用，可生成可视化 HTML 仪表盘与 Qoder IDE 内 Canvas 仪表盘，并提供 /token-usage 斜杠命令在任意工作区一键刷新。Use when the user asks about Qoder token 消费/用量统计（含自定义模型）, "我这周用了多少 token", token usage / token cost / credits 消耗报告, 统计 token 消费, 查看用量, custom model 用量, 可视化查看用量/账单, 或需要导出用量报表与仪表盘时。
description_zh: 统计 Qoder 桌面端 token 消费（官方模型 + 自定义模型），支持费用换算、可视化 HTML 仪表盘与 IDE 内 Canvas 仪表盘，任意工作区可用 /token-usage 斜杠命令。
user-invocable: true
---

# Token Usage — Qoder Token 消费统计

读取 Qoder 桌面端本地数据库，聚合每条消息的 token 明细，输出按天 / 模型 / 项目的消费报表与可视化仪表盘。**同时覆盖 Qoder 官方模型（qmodel / cmodel / gmodel / kmodel / lite / auto 等档位）与自定义模型（`custom_model`，BYOK）**——自定义模型消耗不走 Qoder 官方 Credits，官方入口查不到，此技能是唯一可观测途径。

插件为 User 级安装，**对所有工作区通用**：在任何项目里都可以用自然语言触发，或直接使用斜杠命令。

## 斜杠命令（任意工作区可用）

插件注册了斜杠命令 **`/token-usage`**（在 Qoder 聊天输入框输入 `/` 可见）：

| 输入 | 行为 |
|---|---|
| `/token-usage` | 刷新 Canvas 仪表盘（含四档数据），返回 IDE 内打开链接，并汇报近 7 天总览 |
| `/token-usage 30` | 同上，并按近 30 天汇报（也支持 `90` / `all`） |

命令按「生成 canvas 到当前工作区 → 返回 Markdown 链接 → 报数」执行，定义见 `commands/token-usage.md`。

## 快速使用

在本技能目录下运行（或使用绝对路径）：

```bash
python3 scripts/usage_report.py                      # 近 7 天，按天
python3 scripts/usage_report.py --days 30 --by model # 近 30 天，按模型
python3 scripts/usage_report.py --days 30 --by project  # 按项目
python3 scripts/usage_report.py --days 0 --by day    # 全部历史
python3 scripts/usage_report.py --days 7 --json      # 结构化输出（供程序消费）
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--days N` | 统计近 N 天；`0` = 全部历史（默认 7） |
| `--by day\|model\|project` | 聚合维度（默认 day） |
| `--top N` | model/project 维度的最大行数（默认 50） |
| `--json` | 输出 JSON 而非 markdown |
| `--db PATH` | 覆盖数据库路径（默认 macOS 自动定位） |
| `--pricing PATH` | 覆盖单价表路径（默认技能目录下 pricing.json） |

输出列：消息数、输入 Tokens、输出 Tokens、缓存 Tokens、合计 Tokens、预估费用。

## 可视化仪表盘

生成自包含 HTML 仪表盘（数据内联，无外部依赖，双击即可用浏览器打开）：

```bash
python3 scripts/build_dashboard.py --open   # 生成并自动打开（默认输出 ~/Documents/qoder-token-dashboard.html）
python3 scripts/build_dashboard.py          # 仅生成
python3 scripts/build_dashboard.py --out /path/to/dashboard.html   # 自定义输出路径
```

仪表盘内容：

- **KPI 总览**：总 Tokens、参考费用、消息数、缓存命中率、自定义模型占比
- **每日 Token 用量**：堆叠柱状（缓存命中 / 未命中输入 / 输出）
- **每日参考费用**：费用趋势折线
- **模型分布**：各模型 Token 量与占比横向条形
- **项目排行**：Top 12 项目横向条形
- **明细表**：按天 / 按模型 / 按项目三个维度

页面顶部可切换 **近 7 天 / 近 30 天 / 近 90 天 / 全部历史** 四个时间范围。数据为生成时的快照，刷新数据需重新运行脚本。

### Canvas 版（Qoder IDE 内直接打开）

```bash
python3 scripts/build_canvas.py --workspace "<当前工作区路径>"   # 生成 / 刷新（推荐：显式传当前工作区）
python3 scripts/build_canvas.py                                  # 未显式传参时取 $QODER_WORKSPACE 或当前目录
python3 scripts/build_canvas.py --out /tmp/x.canvas.tsx          # 自定义输出路径
```

- 输出到**目标工作区**对应的 `~/.qoder/projects/<project-slug>/canvases/token-usage-dashboard.canvas.tsx`——本插件对任意工作区通用，在哪个项目里运行就写到该项目的画布目录（生成输出会回显「目标工作区」供核对，跨工作区使用务必显式传 `--workspace`）；
- 在 Qoder **Canvas 面板**中点击打开，或把 canvas 绝对路径以 Markdown 链接返回给用户、点击即刻在 IDE 内预览（无需浏览器）；
- 内容与 HTML 版一致（KPI / 堆叠柱 / 费用折线 / 模型分布 / 项目排行 / 明细表），四档范围切换偏好由 Canvas 持久记忆；
- 数据为快照；用户说「刷新 token 用量 Canvas 仪表盘」时重跑脚本，画布即时热更新；
- Canvas 组件来自 Qoder 内置 `qoder/canvas` SDK（ReportShell / MetricsGrid / BarChart / LineChart / PieChart / Table 等）。

## 参考价格（已内置官网价）

`pricing.json` 已内置各模型的官网参考价（2026-09-22 获取），统计时直接输出预估费用：

- **自定义模型（custom_model）**：本地库不区分具体型号，默认按其主力模型 **DeepSeek-Flash** 计价；DeepSeek 系列为峰谷两档，脚本按每条消息的时间自动判断高峰/空闲（高峰=北京时间周一至周五 9:00-12:00、14:00-18:00）。
- **切换参考模型**：主力模型变化时，把 `_otherCustomModels` 里对应价格（已备好 DeepSeek-V4-Pro / Kimi-K3 / Kimi-for-coding / Qwen-3.8-Max）复制到 `models.custom_model` 覆盖即可。
- **两种价格结构**：flat（`input/output/cached`）或峰谷分时（`peak/offpeak`）。
- Qoder 官方档位（qmodel/cmodel/gmodel 等）无公开单价映射，费用列显示 `-`（官方额度以 Credits 口径为准）。
- 价格来源（如官网调整以官网为准）：[DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) ｜ [Kimi](https://platform.moonshot.cn/docs/pricing/chat) ｜ [阿里云百炼](https://help.aliyun.com/zh/model-studio/models)

## 数据源与口径

- 数据库：`~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db`（macOS），以**只读模式**打开，不影响正在运行的 Qoder。
- 关键表：`chat_message`（`token_info` 含 prompt/completion/cached tokens，`model_info.model_key` 标识模型，`gmt_create` 为毫秒时间戳）；`session_id` 关联 `chat_session.project_name` 得到项目维度。
- `(未记录)` 分组：早期消息缺 model_info 时的归集；`custom_model` 分组：所有自定义模型（BYOK）的统一口径，本地库不含型号细分。
- 费用口径：`非缓存输入×input价 + 缓存命中×cached价 + 输出×output价`（cached 是 prompt 的子集，不重复计费）。
- **与官方 Credits 的区别**：本技能统计的是 token 实物量（含官方模型调用明细与自定义模型），不等于官方 Credit 计费口径；官方额度消耗请查看 IDE 右下角「Credits 用量」或官网 Settings > Usage。

## 常见请求 → 命令

| 用户说 | 执行 |
|---|---|
| 统计我这周的 token 消费 | `python3 scripts/usage_report.py --days 7` |
| 自定义模型用了多少 | `python3 scripts/usage_report.py --days 30 --by model`（看 `自定义模型` 行） |
| 哪个项目最费 | `python3 scripts/usage_report.py --days 30 --by project` |
| 全部历史总账 | `python3 scripts/usage_report.py --days 0` |
| 可视化查看 / 看图表 / 仪表盘（浏览器） | `python3 scripts/build_dashboard.py --open` |
| 在 IDE 内打开仪表盘（Canvas 面板） | 首选斜杠命令 `/token-usage`；或 `python3 scripts/build_canvas.py --workspace <当前工作区>`，再把 canvas 路径以 Markdown 链接返回给用户点击打开 |
| 换算成钱 | 先确认 `pricing.json` 单价已配置，再重跑 |
