#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qoder Token 消费可视化仪表盘生成器。

读取 Qoder 本地数据库（只读），复用 usage_report.py 的过滤/聚合/计价逻辑，
把 近 7 天 / 近 30 天 / 近 90 天 / 全部历史 四个范围的聚合结果内联进自包含
HTML 模板（dashboard_template.html），生成可直接双击打开的仪表盘页面。
纯 Python 标准库 + 原生 JS/SVG 渲染，无任何外部依赖。

用法：
  python3 build_dashboard.py                    # 生成到 ~/Documents/qoder-token-dashboard.html（无 Documents 目录时落到用户主目录）
  python3 build_dashboard.py --open             # 生成并用默认浏览器打开（跨平台）
  python3 build_dashboard.py --out /tmp/x.html  # 自定义输出路径
"""
import argparse
import json
import os
import sys
import webbrowser
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True  # 避免在插件目录生成 __pycache__ 缓存
sys.path.insert(0, SCRIPT_DIR)
import usage_report as ur  # noqa: E402

TEMPLATE = os.path.join(SCRIPT_DIR, "dashboard_template.html")


def _default_out():
    """默认输出：优先 ~/Documents（存在时），否则用户主目录 —— 跨平台。"""
    home = os.path.expanduser("~")
    docs = os.path.join(home, "Documents")
    return os.path.join(docs if os.path.isdir(docs) else home, "qoder-token-dashboard.html")


OUT_DEFAULT = _default_out()
RANGES = [("7", "近 7 天", 7), ("30", "近 30 天", 30), ("90", "近 90 天", 90), ("all", "全部历史", 0)]

FOOTNOTES = [
    "费用为参考估算：单价取自各模型官网（2026-09-23 获取），DeepSeek 系列已按消息时间自动区分高峰/空闲时段。",
    "自定义模型（custom_model）在本地库不区分具体型号，费用按其主力模型 DeepSeek-Flash 计价；切换参考模型见 pricing.json 的 _otherCustomModels。",
    "Qoder 官方档位无公开单价（官方额度以 Credits 口径为准），其 Token 计入总量但费用不计入。",
    "数据源为 Qoder 本地 chat_message 表的一次只读快照，页面数据不自动更新；刷新数据请重新运行生成脚本。",
]


def parse_args():
    p = argparse.ArgumentParser(description="生成 Qoder Token 消费可视化仪表盘（自包含 HTML）")
    p.add_argument("--db", default=ur.DB_DEFAULT, help="Qoder 本地数据库路径（默认自动跨平台定位；可用环境变量 QODER_DB_PATH 覆盖）")
    p.add_argument("--pricing", default=ur.PRICING_DEFAULT, help="单价表路径（默认技能目录下 pricing.json）")
    p.add_argument("--out", default=OUT_DEFAULT, help="输出 HTML 路径")
    p.add_argument("--open", action="store_true", dest="open_after", help="生成后用默认浏览器打开")
    return p.parse_args()


def build_range_payload(rows, project_map, pricing, range_id, range_label):
    """聚合单个时间范围：day/model/project 三个维度 + 汇总指标。"""
    rng = {"id": range_id, "label": range_label}
    for by, top in (("day", 400), ("model", 30), ("project", 30)):
        buckets = ur.aggregate(rows, by, project_map, pricing)
        result, missing = ur.build_result(SimpleNamespace(by=by, top=top), buckets, pricing)
        rng[by] = result
        if by == "model":
            rng["missing"] = missing

    day = rng["day"]
    prompt = sum(r["prompt"] for r in day)
    cached = sum(r["cached"] for r in day)
    total = sum(r["total"] for r in day)
    cost = round(sum((r["cost"] or 0) for r in day), 2)
    custom = next((r for r in rng["model"] if r["key"] == "custom_model"), None)
    rng["summary"] = {
        "msgs": sum(r["msgs"] for r in day),
        "prompt": prompt,
        "completion": sum(r["completion"] for r in day),
        "cached": cached,
        "total": total,
        "cost": cost if cost > 0 else None,
        "cacheRate": (cached / prompt) if prompt else 0,
        "customTotal": custom["total"] if custom else 0,
        "customShare": (custom["total"] / total) if custom and total else 0,
    }
    return rng


def main():
    args = parse_args()
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
        ranges.append(build_range_payload(sub, project_map, pricing, rid, label))

    payload = {
        "generatedAt": now.strftime("%Y-%m-%d %H:%M"),
        "currency": currency,
        "ranges": ranges,
        "footnotes": FOOTNOTES,
    }

    with open(TEMPLATE, encoding="utf-8") as f:
        tpl = f.read()
    data_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    html = tpl.replace("__DATA__", data_json)

    out = os.path.abspath(os.path.expanduser(args.out))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)

    cur = ranges[0]["summary"]
    print(f"仪表盘已生成：{out}")
    print(f"  近 7 天：{cur['total']:,} tokens｜参考费用 ¥{cur['cost'] or 0:,.2f}｜{cur['msgs']:,} 条消息")
    if args.open_after:
        webbrowser.open(Path(out).resolve().as_uri())


if __name__ == "__main__":
    main()
