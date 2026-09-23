# Qoder Token 用量统计（token-usage）

> Qoder 桌面端 token 消费计量插件：同时覆盖 **Qoder 官方模型** 与 **自定义模型（BYOK / custom_model）**，支持按天/模型/项目聚合、官网价费用换算，一键生成 **可视化 HTML 仪表盘** 与 **IDE 内 Canvas 仪表盘**，并提供任意工作区可用的 `/token-usage` 斜杠命令。

## 为什么需要它

- 自定义模型（BYOK）的消耗**不走 Qoder 官方 Credits**，IDE 右下角与官网 Usage 都查不到；
- Qoder 官方档位在本地库有明细但无公开单价（以 Credits 口径为准），官方计费与 token 实物量口径不同；
- 本插件直接读取 Qoder 本地数据库（只读），是本机**官方模型 + 自定义模型统一计量**的唯一可观测途径。

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

## 安装与位置

- 源码项目（可提交 / 可分发）：`~/dgjinapp/智能问数据分析系统/plugins/token-usage/`（与安装副本内容一致）
- 插件目录（本地安装）：`~/.qoder/plugins/cache/local/token-usage/0.1.0/`
- 注册方式：`~/.qoder/plugins/installed_plugins_v2.json` 中 `token-usage@local`（scope: user）
- 更新流程：改源码 → 提升 `.qoder-plugin/plugin.json` 版本号 → 整包复制到 `~/.qoder/plugins/cache/local/token-usage/<新版本>/` → 同步注册 JSON → 重启 Qoder 生效

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

## 使用

```bash
cd ~/.qoder/plugins/cache/local/token-usage/0.1.0/skills/token-usage

# 文本报表（近 7 天，按天）
python3 scripts/usage_report.py
# 近 30 天按模型（看"自定义模型"行）
python3 scripts/usage_report.py --days 30 --by model
# 全部历史总账
python3 scripts/usage_report.py --days 0
# 可视化仪表盘（生成并打开；默认输出 ~/Documents/qoder-token-dashboard.html）
python3 scripts/build_dashboard.py --open
# IDE 内 Canvas 仪表盘（生成/刷新到当前工作区画布目录，在 Qoder Canvas 面板点击打开）
python3 scripts/build_canvas.py --workspace "$(pwd)"
```

在 Qoder 对话中也可直接用自然语言触发（例如"自定义模型用了多少"、"可视化查看 token 消费"），或在任意工作区输入斜杠命令 **`/token-usage`**（可带范围参数如 `/token-usage 30`）。

## 数据源与口径

- 数据库：`~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db`（macOS，**只读**打开）；
  关键表 `chat_message`：`token_info`（prompt/completion/cached，cached 是 prompt 子集）、`model_info.model_key`、`gmt_create`（毫秒时间戳）、`session_id`（关联项目名）。
- 费用口径：`非缓存输入×input价 + 缓存命中×cached价 + 输出×output价`；未配置单价的模型只统计 token。
- `custom_model` 为所有自定义模型（BYOK）的统一口径，本地库不区分具体型号；费用按其主力模型 DeepSeek-Flash 计价（切换参考模型见 `pricing.json` 的 `_otherCustomModels`）。
- 与官方 Credits 的区别：本插件统计 token 实物量，不等于官方 Credit 计费口径；官方额度请看 IDE 右下角「Credits 用量」或官网 Settings > Usage。

## 来源与许可

- 来源：由本机 Qoder 用户级技能 `~/.qoder/skills/token-usage`（2026-09-22 创建）演进而来，2026-09-23 转为 Qoder 原生插件并新增可视化仪表盘。
- 价格来源（如官网调整以官网为准）：[DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) ｜ [Kimi](https://platform.moonshot.cn/docs/pricing/chat) ｜ [阿里云百炼](https://help.aliyun.com/zh/model-studio/models)
- Logo：插件自带 SVG（本插件原创）。

## 验证

- 离线校验：`python3 validate_qoder_plugin.py <plugin-root>` —— 通过（manifest、组件路径、SKILL.md frontmatter 均合规；2026-09-23 对源码包 `plugins/token-usage/` 复核通过）。
- 功能实测（2026-09-23，本机真实数据）：`build_dashboard.py` 生成 60KB 自包含 HTML，近 7 天 7.05 亿 tokens / ¥94.17 / 6,239 条消息，渲染与范围切换经浏览器验证正常。
- Canvas 实测（2026-09-23）：`build_canvas.py` 生成 36KB `.canvas.tsx`（近 7 天 7.09 亿 tokens / ¥94.90 / 6,275 条消息），经本机 `tsc --strict`（对照 qoder/canvas SDK 声明）零类型错误。
- `qodercli` 在本机不可用，未执行 `qodercli plugin validate / install` 冒烟（安装采用本地注册方式，见"安装与位置"）。
