# Qoder Token 用量统计（token-usage）

> Qoder 桌面端 token 消费计量插件：同时覆盖 **Qoder 官方模型** 与 **自定义模型（BYOK / custom_model）**，支持按天 / 模型 / 项目聚合、官网价费用换算，一键生成 **可视化 HTML 仪表盘** 与 **IDE 内 Canvas 仪表盘**，并在任意工作区提供 `/token-usage` 斜杠命令。

- 版本 0.2.0 ｜ 许可 MIT ｜ 运行环境 Python 3.8+（仅标准库，无第三方依赖）
- 支持 Qoder 桌面端：macOS / Windows / Linux

## 为什么需要它

- 自定义模型（BYOK）的消耗**不走 Qoder 官方 Credits**，IDE 右下角与官网 Usage 都查不到；
- Qoder 官方档位在本地库有明细但无公开单价（以 Credits 口径为准），官方计费与 token 实物量口径不同；
- 本插件直接读取 Qoder 本地数据库（只读），是本机**官方模型 + 自定义模型统一计量**的可观测途径。

## 功能

| 能力 | 说明 |
|---|---|
| 双通道计量 | 官方模型档位（qmodel/cmodel/gmodel/kmodel/lite/auto 等）+ 自定义模型（`custom_model`） |
| 多维聚合 | 按天 / 按模型 / 按项目，输出消息数、输入/输出/缓存 tokens、参考费用 |
| 费用换算 | `pricing.json` 内置官网价（2026-09-22 获取）；DeepSeek 系列按消息时间自动判峰谷（高峰=北京时间周一至周五 9:00-12:00、14:00-18:00） |
| 可视化仪表盘 | 自包含 HTML：KPI 总览、每日用量堆叠柱、每日费用折线、模型分布、项目排行、明细表；近 7/30/90 天与全部历史四档切换，无外部依赖，双击即开 |
| Canvas 仪表盘 | Qoder IDE 内直接打开：`build_canvas.py` 生成 `.canvas.tsx` 到当前工作区的画布目录，Canvas 面板 / 对话链接点击即看，范围切换偏好持久记忆 |
| 斜杠命令 | `/token-usage`（任意工作区）：一键刷新 Canvas 仪表盘、返回 IDE 打开链接并汇报总览 |
| 结构化输出 | `--json` 供程序消费 |

## 安装

**从 Qoder 插件市场安装**：搜索「Qoder Token 用量统计」（token-usage）→ 安装。安装后技能与 `/token-usage` 斜杠命令对所有工作区生效。

安装后技能目录位于：

- 市场安装：`~/.qoder/plugins/cache/qoder-marketplace/token-usage/*/skills/token-usage/`
- 本地/离线安装：`~/.qoder/plugins/cache/local/token-usage/*/skills/token-usage/`

一条命令定位技能目录（macOS / Linux）：

```bash
ls -d ~/.qoder/plugins/cache/*/token-usage/*/skills/token-usage/ 2>/dev/null | sort -V | tail -1
```

Windows PowerShell 等价写法：

```powershell
Get-ChildItem "$env:USERPROFILE\.qoder\plugins\cache\*\token-usage\*\skills\token-usage" -Directory | Select-Object -Last 1
```

无输出说明插件未安装或未启用，请在 Qoder 插件面板确认。

## 使用

```bash
# 进入技能目录（交互式会话中也可直接用上一步命令的输出路径）
cd "$(ls -d ~/.qoder/plugins/cache/*/token-usage/*/skills/token-usage/ | sort -V | tail -1)"

# 文本报表（近 7 天，按天）
python3 scripts/usage_report.py
# 近 30 天按模型（看「自定义模型」行）
python3 scripts/usage_report.py --days 30 --by model
# 全部历史总账
python3 scripts/usage_report.py --days 0
# 可视化仪表盘（生成并打开；默认输出 ~/Documents/qoder-token-dashboard.html）
python3 scripts/build_dashboard.py --open
# IDE 内 Canvas 仪表盘（生成/刷新到当前工作区画布目录，在 Qoder Canvas 面板点击打开）
python3 scripts/build_canvas.py --workspace "$(pwd)"
```

Windows 上将 `python3` 换成 `python` 或 `py -3`。

在 Qoder 对话中也可直接用自然语言触发（例如「自定义模型用了多少」、「可视化查看 token 消费」），或在任意工作区输入斜杠命令 **`/token-usage`**（可带范围参数如 `/token-usage 30`）。

## 组件清单

| 组件 | 路径 | 说明 |
|---|---|---|
| Skill | `skills/token-usage/SKILL.md` | 触发式技能：报表与仪表盘 |
| 命令 | `commands/token-usage.md` | 斜杠命令 `/token-usage`：刷新 Canvas 仪表盘并报数（任意工作区） |
| 脚本 | `skills/token-usage/scripts/usage_report.py` | 文本 / JSON 报表（markdown 表格） |
| 脚本 | `skills/token-usage/scripts/build_dashboard.py` | 可视化仪表盘生成器（HTML） |
| 脚本 | `skills/token-usage/scripts/build_canvas.py` | IDE Canvas 仪表盘生成器（.canvas.tsx） |
| 模板 | `skills/token-usage/scripts/dashboard_template.html` | 自包含仪表盘模板（原生 JS + SVG） |
| 模板 | `skills/token-usage/scripts/canvas_template.tsx` | Canvas 模板（qoder/canvas SDK 组件） |
| 价格表 | `skills/token-usage/pricing.json` | 官网参考价（峰谷 / flat 两种结构） |
| 图标 | `assets/avatar.svg` | 插件 Logo |

## 数据源与口径

- **数据库（跨平台自动探测，只读打开，不影响正在运行的 Qoder）**：
  - macOS：`~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db`
  - Windows：`%APPDATA%\Qoder\SharedClientCache\cache\db\local.db`（另探测 `%LOCALAPPDATA%`）
  - Linux：`~/.config/Qoder/SharedClientCache/cache/db/local.db`（遵循 `XDG_CONFIG_HOME`）
  - 可用环境变量 `QODER_DB_PATH` 或 `--db` 覆盖，report / dashboard / canvas 三个脚本均适用。

- 关键表 `chat_message`：`token_info`（prompt/completion/cached，cached 是 prompt 子集）、`model_info.model_key`、`gmt_create`（毫秒时间戳）；`session_id` 关联 `chat_session.project_name` 得到项目维度。
- 费用口径：`非缓存输入×input价 + 缓存命中×cached价 + 输出×output价`；未配置单价的模型只统计 token，费用列显示 `-`。
- `custom_model` 为所有自定义模型（BYOK）的统一口径，本地库不区分具体型号；费用按其主力模型 DeepSeek-Flash 计价（切换参考模型见 `pricing.json` 的 `_otherCustomModels`）。
- **隐私**：所有数据仅在本机以只读方式读取并渲染，不联网、不上传。
- 与官方 Credits 的区别：本插件统计 token 实物量，不等于官方 Credit 计费口径；官方额度请看 IDE 右下角「Credits 用量」或官网 Settings > Usage。

## 费用换算（pricing.json）

`pricing.json` 已内置各模型官网参考价（2026-09-22 获取），统计时直接输出预估费用：

- 两种价格结构：flat（`input / output / cached`）或峰谷分时（`peak / offpeak`）；DeepSeek 系列按每条消息的时间自动判断高峰/空闲。
- 自定义模型默认按 **DeepSeek-Flash** 计价；主力模型变化时，把 `_otherCustomModels` 里对应价格（已备好 DeepSeek-V4-Pro / Kimi-K3 / Kimi-for-coding / Qwen-3.8-Max）复制到 `models.custom_model` 覆盖即可。
- Qoder 官方档位无公开单价映射，费用列显示 `-`（以 Credits 口径为准）。
- 价格来源（如官网调整以官网为准）：[DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) ｜ [Kimi](https://platform.moonshot.cn/docs/pricing/chat) ｜ [阿里云百炼](https://help.aliyun.com/zh/model-studio/models)

## 常见问题

- **提示「未找到 Qoder 本地数据库」？** 确认本机已启动过一次 Qoder 桌面端；或先用上面的定位命令确认数据库实际位置，再用 `--db` 指定或设置 `QODER_DB_PATH`。
- **费用列显示 `-`？** 该模型未在 `pricing.json` 配置单价（如官方档位、`(未记录)` 分组），只统计 token 不折算费用。
- **为什么和「Credits 用量」对不上？** 官方 Credits 是计费口径（含折扣、套餐），本插件是 token 实物量口径，两者不同属正常。
- **数据会自动更新吗？** 不会。数据是生成时刻的只读快照，重新运行对应脚本即刷新（Canvas 版可对 Qoder 说「刷新 token 用量 Canvas 仪表盘」）。

## 兼容性

- Qoder 桌面端：macOS / Windows / Linux（数据库路径按 Electron 用户数据目录约定自动探测）。
- Python 3.8+，仅标准库：无需 `pip install`，不改动 Qoder 安装目录，只读访问本地库。

## 更新记录

- 0.2.0（2026-09-23）：跨平台通用化——数据库路径自动探测（macOS/Windows/Linux）+ `QODER_DB_PATH` 覆盖；仪表盘默认输出与浏览器打开改用跨平台标准库；Canvas 项目目录 slug 归一化；斜杠命令跨安装根定位。
- 0.1.0（2026-09-23）：首个版本——文本报表、可视化 HTML 仪表盘、IDE 内 Canvas 仪表盘与 `/token-usage` 斜杠命令。

## 来源与许可

- 许可：[MIT](./LICENSE)。
- Logo：本插件原创 SVG。
- 来源：由用户级 Skill 演进为 Qoder 原生插件（插件化）。价格数据（如官网调整以官网为准）：[DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) ｜ [Kimi](https://platform.moonshot.cn/docs/pricing/chat) ｜ [阿里云百炼](https://help.aliyun.com/zh/model-studio/models)

## 验证记录

- **离线校验**（2026-09-23）：`validate_qoder_plugin.py`（Qoder 插件结构校验器）对插件根目录检查通过——manifest 字段、组件路径、`SKILL.md` frontmatter 均合规。
- **功能实测**（2026-09-23，macOS，真实本机数据库）：`usage_report.py` 近 7 天输出 6,307 条消息 / 710,869,367 tokens；`build_dashboard.py` 生成 61.9 KB 自包含 HTML（占位数据替换、payload 完整、页面结构校验通过）；`build_canvas.py` 生成 37.2 KB `.canvas.tsx`，经 `tsc --strict`（对照 Qoder 内置 `qoder/canvas` SDK 声明）零类型错误。
- **容错实测**：`--db` 指向不存在路径时输出候选路径清单与解决提示后退出（exit 1）；`QODER_DB_PATH` 覆盖生效。
- **平台说明**：以上实测在 macOS 完成；Windows / Linux 的数据库探测、浏览器打开与路径处理为按平台约定实现，尚未在对应系统实测。
