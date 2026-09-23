#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Qoder Token 消费统计 —— 同时覆盖 Qoder 官方模型与自定义模型（BYOK）。

数据源：Qoder 桌面端本地数据库（只读打开，不影响正在运行的 Qoder）
  ~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db
    chat_message.token_info   {prompt_tokens, completion_tokens, cached_tokens, ...}
    chat_message.model_info   {model_key}    —— custom_model 即自定义模型
    chat_message.gmt_create   毫秒时间戳；session_id 关联 chat_session.project_name

用法：
  python3 usage_report.py                          # 近 7 天，按天
  python3 usage_report.py --days 30 --by model     # 近 30 天，按模型
  python3 usage_report.py --days 0 --by project    # 全量历史，按项目
  python3 usage_report.py --days 7 --json          # 输出 JSON（供程序消费）

费用换算：读取同技能目录下的 pricing.json（元 / 百万 tokens，分输入/输出/缓存三项）。
未配置单价的模型只统计 token，费用列显示 "-"。
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

DB_DEFAULT = os.path.expanduser(
    "~/Library/Application Support/Qoder/SharedClientCache/cache/db/local.db"
)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PRICING_DEFAULT = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "pricing.json"))
TZ = timezone(timedelta(hours=8))  # 北京时间
UNKNOWN_MODEL = "(未记录)"


def parse_args():
    p = argparse.ArgumentParser(description="Qoder token 消费统计（官方模型 + 自定义模型）")
    p.add_argument("--days", type=int, default=7, help="统计近 N 天；0 = 全部历史（默认 7）")
    p.add_argument("--by", choices=["day", "model", "project"], default="day", help="聚合维度（默认 day）")
    p.add_argument("--db", default=DB_DEFAULT, help="Qoder 本地数据库路径（默认自动定位）")
    p.add_argument("--pricing", default=PRICING_DEFAULT, help="单价表路径（默认技能目录下 pricing.json）")
    p.add_argument("--top", type=int, default=50, help="model/project 维度的最大行数（默认 50）")
    p.add_argument("--json", action="store_true", help="输出 JSON 而非 markdown")
    return p.parse_args()


def load_pricing(path):
    """返回 (models_map, currency)。文件缺失或损坏时返回空映射（仅统计 token）。"""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        models = data.get("models") or {}
        return {k: v for k, v in models.items() if isinstance(v, dict)}, data.get("currency", "CNY")
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}, "CNY"


def _parse_rates(d):
    """解析一组单价 {input, output, cached}；input/output 必须为数字。"""
    if not isinstance(d, dict):
        return None
    inp, out, cac = d.get("input"), d.get("output"), d.get("cached")
    if not isinstance(inp, (int, float)) or not isinstance(out, (int, float)):
        return None
    cac = cac if isinstance(cac, (int, float)) else inp  # 未单独配置缓存价时按输入价
    return {"input": float(inp), "output": float(out), "cached": float(cac)}


def model_price(pricing, key):
    """返回该模型的计价规则：{'flat': {...}} 或 {'peak': {...}, 'offpeak': {...}}；未配置返回 None。"""
    p = pricing.get(key)
    if not p:
        return None
    if isinstance(p.get("peak"), dict) or isinstance(p.get("offpeak"), dict):
        peak, off = _parse_rates(p.get("peak")), _parse_rates(p.get("offpeak"))
        peak, off = peak or off, off or peak
        return {"peak": peak, "offpeak": off} if peak else None
    flat = _parse_rates(p)
    return {"flat": flat} if flat else None


def model_label(pricing, key):
    p = pricing.get(key) or {}
    return p.get("display_name") or key


def is_peak_hour(gmt_ms):
    """DeepSeek 计费高峰：北京时间周一至周五 9:00-12:00、14:00-18:00（法定节假日近似忽略）。"""
    dt = datetime.fromtimestamp((gmt_ms or 0) / 1000, tz=TZ)
    if dt.weekday() >= 5:
        return False
    return (9 <= dt.hour < 12) or (14 <= dt.hour < 18)


def message_cost(price, pt, ct, cd, gmt_ms):
    """单条消息费用：cached 是 prompt 的子集，未命中部分按 input 价、命中部分按 cached 价。"""
    unit = price.get("flat") or (price["peak"] if is_peak_hour(gmt_ms) else price["offpeak"])
    non_cached = max(pt - cd, 0)
    return (non_cached / 1e6 * unit["input"]
            + cd / 1e6 * unit["cached"]
            + ct / 1e6 * unit["output"])


def fetch_usage(db_path, since_ms):
    """读取 token 记录并聚合。返回 (buckets, totals, project_map, missing_models, range_info)。"""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=15)
    try:
        # session_id -> 项目名映射（供 project 维度）
        project_map = {}
        for sid, name in conn.execute("SELECT session_id, project_name FROM chat_session"):
            project_map[sid] = (name or "").strip() or "(未命名项目)"

        sql = (
            "SELECT gmt_create, token_info, model_info, session_id FROM chat_message "
            "WHERE token_info IS NOT NULL AND token_info <> ''"
        )
        params = []
        if since_ms:
            sql += " AND gmt_create >= ?"
            params.append(since_ms)
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return project_map, rows


def aggregate(rows, by, project_map, pricing):
    buckets = {}

    def new_bucket():
        return {"msgs": 0, "prompt": 0, "completion": 0, "cached": 0, "cost": 0.0, "missing": set()}

    for gmt, token_info, model_info, session_id in rows:
        try:
            tk = json.loads(token_info)
        except (TypeError, json.JSONDecodeError):
            continue
        pt = int(tk.get("prompt_tokens") or 0)
        ct = int(tk.get("completion_tokens") or 0)
        cd = int(tk.get("cached_tokens") or 0)
        try:
            mk = json.loads(model_info).get("model_key") or UNKNOWN_MODEL
        except (TypeError, json.JSONDecodeError):
            mk = UNKNOWN_MODEL

        if by == "day":
            key = datetime.fromtimestamp((gmt or 0) / 1000, tz=TZ).strftime("%Y-%m-%d")
        elif by == "model":
            key = mk
        else:
            key = project_map.get(session_id, "(未知项目)")

        b = buckets.setdefault(key, new_bucket())
        b["msgs"] += 1
        b["prompt"] += pt
        b["completion"] += ct
        b["cached"] += cd
        price = model_price(pricing, mk)
        if price is None:
            b["missing"].add(mk)
        else:
            b["cost"] += message_cost(price, pt, ct, cd, gmt)
    return buckets


def build_result(args, buckets, pricing):
    """组装最终行结构（费用已在聚合时按消息逐条累计）。"""
    rows_out, missing_all = [], set()
    for key, b in buckets.items():
        missing_all |= b["missing"]
        rows_out.append({
            "key": key,
            "label": model_label(pricing, key) if args.by == "model" else key,
            "msgs": b["msgs"],
            "prompt": b["prompt"],
            "completion": b["completion"],
            "cached": b["cached"],
            "total": b["prompt"] + b["completion"],
            "cost": round(b["cost"], 2) if b["cost"] > 0 else None,
        })
    if args.by == "day":
        rows_out.sort(key=lambda r: r["key"], reverse=True)
    else:
        rows_out.sort(key=lambda r: r["total"], reverse=True)
        rows_out = rows_out[: args.top]
    return rows_out, sorted(missing_all)


def fmt_int(n):
    return f"{n:,}"


def fmt_cost(cost, currency):
    if cost is None:
        return "-"
    return f"{'¥' if currency == 'CNY' else ''}{cost:,.2f}"


def render_markdown(args, rows, missing, pricing, range_label, currency):
    dim = {"day": "日期", "model": "模型", "project": "项目"}[args.by]
    lines = [
        f"# Qoder Token 消费统计（{range_label}）",
        "",
        f"- 聚合维度：按{dim}",
        f"- 消息数合计：{fmt_int(sum(r['msgs'] for r in rows))}",
        f"- Token 合计：{fmt_int(sum(r['total'] for r in rows))}（输入 {fmt_int(sum(r['prompt'] for r in rows))} / 输出 {fmt_int(sum(r['completion'] for r in rows))} / 缓存命中 {fmt_int(sum(r['cached'] for r in rows))}）",
        "",
        f"| {dim} | 消息数 | 输入 Tokens | 输出 Tokens | 缓存 Tokens | 合计 Tokens | 预估费用 |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for r in rows:
        lines.append(
            f"| {r['label']} | {fmt_int(r['msgs'])} | {fmt_int(r['prompt'])} | "
            f"{fmt_int(r['completion'])} | {fmt_int(r['cached'])} | {fmt_int(r['total'])} | "
            f"{fmt_cost(r['cost'], currency)} |"
        )
    if missing:
        lines += [
            "",
            "> 未配置单价的模型（费用未计入）：" + "、".join(missing),
            "> 在 pricing.json 的 models 中填入单价（元 / 百万 tokens）后重跑即可显示费用。",
        ]
    lines += [
        "",
        "> 费用为参考估算：单价取自各模型官网（2026-09-22），DeepSeek 系列已按消息时间自动区分高峰/空闲时段。",
        "> 自定义模型在本地库统一记录为 custom_model，费用按 pricing.json 中其配置的参考模型计价（见 display_name）。",
    ]
    return "\n".join(lines)


def main():
    args = parse_args()
    if not os.path.exists(args.db):
        print(f"未找到 Qoder 数据库：{args.db}\n（请确认本机已安装并运行过 Qoder 桌面端）", file=sys.stderr)
        sys.exit(1)

    pricing, currency = load_pricing(args.pricing)
    since_ms = None
    if args.days > 0:
        since_ms = int((datetime.now(tz=TZ) - timedelta(days=args.days)).timestamp() * 1000)
    range_label = f"近 {args.days} 天" if args.days > 0 else "全部历史"

    project_map, rows = fetch_usage(args.db, since_ms)
    buckets = aggregate(rows, args.by, project_map, pricing)
    result_rows, missing = build_result(args, buckets, pricing)

    if args.json:
        payload = {
            "range": range_label,
            "by": args.by,
            "currency": currency,
            "rows": result_rows,
            "missingPricing": missing,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    print(render_markdown(args, result_rows, missing, pricing, range_label, currency))


if __name__ == "__main__":
    main()
