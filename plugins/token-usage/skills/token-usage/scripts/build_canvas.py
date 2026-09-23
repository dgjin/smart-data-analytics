#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qoder Token 用量 Canvas 仪表盘生成器。

读取 Qoder 本地数据库（只读），复用 usage_report.py 的过滤/聚合/计价逻辑，
生成 Qoder IDE Canvas 面板可直接打开的 `.canvas.tsx` 文件（数据内联）：
KPI / 每日 Token 堆叠柱 / 每日费用折线 / 模型分布 / 项目排行 / 明细表，
支持 近 7 天 / 近 30 天 / 近 90 天 / 全部历史 四档切换（偏好由 Canvas 持久化）。

默认输出到「目标工作区」对应的 Qoder 项目画布目录：
  ~/.qoder/projects/<project-slug>/canvases/token-usage-dashboard.canvas.tsx

目标工作区由 --workspace 指定；未指定时依次取环境变量 QODER_WORKSPACE、
当前工作目录（CWD）。因此本脚本对任意工作区通用——在任何项目里运行都会
把画布写入该项目的 canvases 目录。

用法：
  python3 build_canvas.py                                      # 取 CWD 作为目标工作区
  python3 build_canvas.py --workspace /path/to/current-project # 显式指定（推荐）
  python3 build_canvas.py --out /tmp/x.canvas.tsx
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from types import SimpleNamespace

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # 避免在插件目录生成 __pycache__ 缓存
sys.path.insert(0, SCRIPT_DIR)
import usage_report as ur  # noqa: E402

TEMPLATE = os.path.join(SCRIPT_DIR, "canvas_template.tsx")
# 目标工作区：显式参数 > $QODER_WORKSPACE > 当前工作目录 CWD（不绑定任何具体项目）
WORKSPACE_DEFAULT = os.environ.get("QODER_WORKSPACE") or os.getcwd()
QODER_PROJECTS = os.path.expanduser("~/.qoder/projects")
CANVAS_NAME = "token-usage-dashboard.canvas.tsx"
RANGES = [("7", "近 7 天", 7), ("30", "近 30 天", 30), ("90", "近 90 天", 90), ("all", "全部历史", 0)]
TOP_PROJECTS = 15

FOOTNOTES = [
    "费用为参考估算：单价取自各模型官网（2026-09-22 获取）；DeepSeek 系列按消息时间自动区分高峰/空闲时段。",
    "自定义模型（custom_model）在本地库不区分具体型号，费用按其主力模型 DeepSeek-Flash 计价；切换参考模型见 pricing.json 的 _otherCustomModels。",
    "Qoder 官方档位无公开单价，其 Tokens 计入总量但参考费用显示为 —（官方额度以 Credits 口径为准）。",
    "数据为 Qoder 本地 chat_message 表的一次只读快照，不自动更新；点击「刷新数据」或在 Chat 中说「刷新 token 用量 Canvas 仪表盘」即可重新生成。",
    "范围切换偏好由 Qoder Canvas 主动记忆，重新打开时保持上次选择。",
]


def parse_args():
    p = argparse.ArgumentParser(description="生成 Qoder Token 用量 Canvas 仪表盘（.canvas.tsx）")
    p.add_argument("--db", default=ur.DB_DEFAULT, help="Qoder 本地数据库路径（默认自动跨平台定位；可用环境变量 QODER_DB_PATH 覆盖）")
    p.add_argument("--pricing", default=ur.PRICING_DEFAULT, help="单价表路径（默认技能目录下 pricing.json）")
    p.add_argument(
        "--workspace",
        default=None,
        help="目标工作区路径（默认取 $QODER_WORKSPACE 或当前工作目录，用于推导 Qoder 项目画布目录）",
    )
    p.add_argument("--out", default=None, help="输出 .canvas.tsx 路径（默认写入工作区对应的 canvases 目录）")
    return p.parse_args()


def project_slug(path):
    """工作区绝对路径 -> Qoder 项目目录 slug（分隔符统一为 /，去掉盘符冒号后替换为 -，前加 -）。"""
    p = os.path.abspath(os.path.expanduser(path)).replace("\\", "/").replace(":", "")
    return "-" + p.strip("/").replace("/", "-")


def build_days(rows, pricing):
    """按天聚合，返回 (升序每日点列表, 汇总基础字段)。"""
    buckets = ur.aggregate(rows, "day", {}, pricing)
    result, _ = ur.build_result(SimpleNamespace(by="day", top=0), buckets, pricing)
    result = list(reversed(result))  # 时间升序
    pts, msgs, prompt, completion, cached, cost = [], 0, 0, 0, 0, 0.0
    for r in result:
        pts.append({
            "label": r["key"][5:],  # YYYY-MM-DD -> MM-DD
            "cached": r["cached"],
            "uncached": max(r["prompt"] - r["cached"], 0),
            "output": r["completion"],
            "cost": round(r["cost"] or 0.0, 2),
        })
        msgs += r["msgs"]
        prompt += r["prompt"]
        completion += r["completion"]
        cached += r["cached"]
        cost += r["cost"] or 0.0
    base = {
        "msgs": msgs,
        "prompt": prompt,
        "completion": completion,
        "cached": cached,
        "total": prompt + completion,
        "cost": round(cost, 2),
    }
    return pts, base


def build_dim(rows, by, project_map, pricing, top, range_total):
    """按模型 / 项目聚合，返回 (行列表, 无单价模型列表, 自定义模型合计 tokens)。"""
    buckets = ur.aggregate(rows, by, project_map, pricing)
    result, missing = ur.build_result(SimpleNamespace(by=by, top=top), buckets, pricing)
    out, custom_total = [], 0
    for r in result:
        if r["key"] == "custom_model":
            custom_total = r["total"]
        out.append({
            "name": r["label"],
            "msgs": r["msgs"],
            "prompt": r["prompt"],
            "completion": r["completion"],
            "cached": r["cached"],
            "total": r["total"],
            "share": round(r["total"] / range_total, 4) if range_total else 0,
            "cost": r["cost"],
        })
    return out, missing, custom_total


def build_range(rows, project_map, pricing, rid, label):
    """组装单个时间范围的完整 payload。"""
    days, base = build_days(rows, pricing)
    models, missing, custom_total = build_dim(rows, "model", project_map, pricing, 30, base["total"])
    projects, _, _ = build_dim(rows, "project", project_map, pricing, TOP_PROJECTS, base["total"])
    return {
        "id": rid,
        "label": label,
        "summary": {
            **base,
            "cost": base["cost"] if base["cost"] > 0 else None,
            "cacheRate": (base["cached"] / base["prompt"]) if base["prompt"] else 0,
            "customTotal": custom_total,
            "customShare": (custom_total / base["total"]) if base["total"] else 0,
        },
        "days": days,
        "models": models,
        "projects": projects,
        "missing": missing,
    }


def main():
    args = parse_args()
    workspace = os.path.abspath(os.path.expanduser(args.workspace or WORKSPACE_DEFAULT))
    ur.require_db(args.db)
    if not os.path.exists(TEMPLATE):
        print(f"未找到模板文件：{TEMPLATE}", file=sys.stderr)
        sys.exit(1)

    pricing, currency = ur.load_pricing(args.pricing)
    project_map, rows = ur.fetch_usage(args.db, None)  # 全量读取一次，各范围内存切片
    now = datetime.now(tz=ur.TZ)

    ranges = []
    for rid, label, days in RANGES:
        if days > 0:
            since_ms = int((now - timedelta(days=days)).timestamp() * 1000)
            sub = [r for r in rows if (r[0] or 0) >= since_ms]
        else:
            sub = rows
        ranges.append(build_range(sub, project_map, pricing, rid, label))

    payload = {
        "generatedAt": now.strftime("%Y-%m-%d %H:%M"),
        "currency": currency,
        "ranges": ranges,
        "footnotes": FOOTNOTES,
    }

    with open(TEMPLATE, encoding="utf-8") as f:
        tpl = f.read()
    data_json = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    code = tpl.replace("__DATA__", data_json)

    if args.out:
        out = os.path.abspath(os.path.expanduser(args.out))
    else:
        canvas_dir = os.path.join(QODER_PROJECTS, project_slug(workspace), "canvases")
        if not os.path.isdir(os.path.dirname(canvas_dir)):
            print(f"提示：未找到该工作区对应的 Qoder 项目目录，将创建 {canvas_dir}", file=sys.stderr)
            print("  可先用 Qoder 打开该工作区，或用 --out 指定输出文件路径。", file=sys.stderr)
            try:
                names = sorted(d for d in os.listdir(QODER_PROJECTS)
                               if os.path.isdir(os.path.join(QODER_PROJECTS, d)))[:8]
                if names:
                    print("  现有项目目录示例：" + "、".join(names), file=sys.stderr)
            except OSError:
                pass
        out = os.path.join(canvas_dir, CANVAS_NAME)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(code)

    cur = ranges[0]["summary"]
    print(f"目标工作区：{workspace}")
    print(f"Canvas 仪表盘已生成：{out}")
    print(f"  近 7 天：{cur['total']:,} tokens｜参考费用 ¥{cur['cost'] or 0:,.2f}｜{cur['msgs']:,} 条消息")
    print("  在 Qoder 中打开：点击对话中的画布链接，或从 Canvas 面板选择「token-usage-dashboard」")


if __name__ == "__main__":
    main()
