#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
Qoder Token 价格表自动更新 —— 从插件的公开仓库拉取最新 pricing.json。

机制：
  1. 按顺序尝试多个更新源（Gitee 优先、GitHub 兜底；可用 --source 或环境变量覆盖）；
  2. 严格校验远端内容（JSON 结构、币种/单位、版本格式、价格数值范围）；
  3. 与本地比对：远端 _version 更新时写入（原子替换 + 自动备份，旧文件可回滚）；
  4. 24 小时节流：短时间内重复运行直接跳过（--force 可强制；失败重试窗口 2 小时）；
  5. 只下载公开价格表，不上传任何本地数据。

用法：
  python3 update_pricing.py              # 检查并更新（推荐：统计前的自动模式）
  python3 update_pricing.py --check      # 只检查是否有新版，不写入
  python3 update_pricing.py --dry-run    # 联网比对并显示差异摘要，但不写入
  python3 update_pricing.py --force      # 跳过 24 小时节流
  python3 update_pricing.py --offline    # 完全不联网（直接退出）
  python3 update_pricing.py --source URL # 自定义更新源（可重复指定）
  python3 update_pricing.py --pricing P  # 目标价格表（默认技能目录下 pricing.json）
  python3 update_pricing.py --keep N     # 备份保留份数（默认 3）
  python3 update_pricing.py --json       # JSON 输出（供程序 / Agent 消费）

环境变量：
  TOKEN_USAGE_PRICING_URL   覆盖更新源（多个用英文逗号分隔）
  TOKEN_USAGE_NO_NET=1      强制离线

退出码：
  0 = 成功（已最新 / 已更新 / 已禁用联网 / 节流跳过）
  1 = 失败（网络不可达或校验不通过或写入失败；本地文件保持原样）
"""
import argparse
import glob
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PRICING_DEFAULT = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "pricing.json"))

SOURCES = [
    "https://gitee.com/dgjin/qoder-token-usage/raw/main/skills/token-usage/pricing.json",
    "https://raw.githubusercontent.com/dgjin/qoder-token-usage/main/skills/token-usage/pricing.json",
]
SOURCE_NAMES = {"gitee.com": "gitee", "raw.githubusercontent.com": "github"}

UA = "token-usage-plugin (Qoder skill; +https://github.com/dgjin/qoder-token-usage)"
TIMEOUT = 8                # 单个源的网络超时（秒）
MAX_BYTES = 256 * 1024     # 响应体上限（防超大/异常内容）
VERSION_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")
STATE_NAME = ".pricing-update-state.json"
FRESH_OK = timedelta(hours=24)    # 上次检查成功后的节流窗口
FRESH_FAIL = timedelta(hours=2)   # 上次失败后的重试窗口
TZ = timezone(timedelta(hours=8))  # 北京时间


def parse_args():
    p = argparse.ArgumentParser(description="Qoder token 价格表自动更新（从插件公开仓库拉取）")
    p.add_argument("--pricing", default=PRICING_DEFAULT, help="目标价格表路径（默认技能目录下 pricing.json）")
    p.add_argument("--check", action="store_true", help="只检查是否有新版，不写入")
    p.add_argument("--dry-run", action="store_true", help="显示差异摘要，但不写入")
    p.add_argument("--force", action="store_true", help="跳过节流窗口")
    p.add_argument("--offline", action="store_true", help="完全不联网")
    p.add_argument("--source", action="append", default=None, help="自定义更新源 URL（可重复指定，按序尝试）")
    p.add_argument("--keep", type=int, default=3, help="备份保留份数（默认 3，0 不备份）")
    p.add_argument("--json", action="store_true", help="以 JSON 输出结果")
    return p.parse_args()


def now():
    return datetime.now(TZ)


def version_tuple(v):
    """'YYYY.MM.DD' -> (YYYY, MM, DD)；非法或缺失返回 None。"""
    if isinstance(v, str) and VERSION_RE.match(v):
        return tuple(int(x) for x in v.split("."))
    return None


def is_number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def _check_rate_block(block, label, errs):
    """校验一组单价 {input, output, cached}：允许 null（未配置），否则须为 0 ~ 1e6 的数字。"""
    if not isinstance(block, dict):
        errs.append(f"{label} 必须是对象")
        return
    for field in ("input", "output", "cached"):
        if field not in block:
            continue
        v = block[field]
        if v is None:
            continue
        if not is_number(v) or not (0 <= v <= 1_000_000):
            errs.append(f"{label}.{field} 数值非法: {v!r}")


def _check_model_entry(key, val, section, errs):
    if isinstance(key, str) and key.startswith("_"):
        return  # 段内元数据键（如 _usage / _note 说明），非模型条目
    if not isinstance(key, str) or not key or len(key) > 200:
        errs.append(f"{section} 含非法键: {key!r}")
        return
    if not isinstance(val, dict):
        errs.append(f"{section}.{key} 必须是对象")
        return
    for fld in ("display_name", "note", "_note", "source"):
        v = val.get(fld)
        if v is not None and (not isinstance(v, str) or len(v) > 2048):
            errs.append(f"{section}.{key}.{fld} 字符串过长或类型非法")
    if isinstance(val.get("peak"), dict) or isinstance(val.get("offpeak"), dict):
        for slot in ("peak", "offpeak"):
            if slot in val:
                _check_rate_block(val.get(slot), f"{section}.{key}.{slot}", errs)
    else:
        _check_rate_block(val, f"{section}.{key}", errs)


def validate_pricing(data):
    """结构校验；返回错误列表（空列表 = 通过）。"""
    errs = []
    if not isinstance(data, dict):
        return ["根节点必须是 JSON 对象"]
    if data.get("currency") != "CNY":
        errs.append("currency 必须为 CNY")
    if data.get("unit") != "per_1m_tokens":
        errs.append("unit 必须为 per_1m_tokens")
    if version_tuple(data.get("_version")) is None:
        errs.append("_version 缺失或格式非法（应为 YYYY.MM.DD）")
    models = data.get("models")
    if not isinstance(models, dict) or not models:
        errs.append("models 段缺失或为空")
    else:
        for k, v in models.items():
            _check_model_entry(k, v, "models", errs)
    other = data.get("_otherCustomModels")
    if other is not None:
        if not isinstance(other, dict):
            errs.append("_otherCustomModels 必须是对象")
        else:
            for k, v in other.items():
                _check_model_entry(k, v, "_otherCustomModels", errs)
    return errs


def fetch(url):
    """下载文本；返回 (text, 源短名)。超限或非 UTF-8 会抛异常。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json, text/plain, */*"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:  # 自动跟随 30x
        size = resp.headers.get("Content-Length")
        if size and size.isdigit() and int(size) > MAX_BYTES:
            raise ValueError(f"响应过大（{size} 字节）")
        raw = resp.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("响应超过 256KB 上限")
    name = next((n for host, n in SOURCE_NAMES.items() if host in url), "custom")
    return raw.decode("utf-8"), name


def try_fetch_all(sources):
    """按序尝试各源；返回 (text, source_name, error_summary)。"""
    errors = []
    for url in sources:
        try:
            text, name = fetch(url)
            return text, name, None
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError,
                TimeoutError, OSError) as e:
            errors.append(f"{url.split('/')[2]}: {e}")
    return None, None, "; ".join(errors) if errors else "无可用更新源"


def load_local(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), None
    except FileNotFoundError:
        return None, "本地文件不存在"
    except (json.JSONDecodeError, OSError) as e:
        return None, f"本地文件读取失败: {e}"


def flatten_rates(data):
    """展平为 {(section, key, slot): (input, output, cached)}，便于比对差异。"""
    out = {}
    for section in ("models", "_otherCustomModels"):
        sec = data.get(section) or {}
        if not isinstance(sec, dict):
            continue
        for key, val in sec.items():
            if isinstance(key, str) and key.startswith("_"):
                continue  # 段内元数据键，非模型条目
            if not isinstance(val, dict):
                continue
            if isinstance(val.get("peak"), dict) or isinstance(val.get("offpeak"), dict):
                for slot in ("peak", "offpeak"):
                    block = val.get(slot)
                    if isinstance(block, dict):
                        out[(section, key, slot)] = tuple(block.get(f) for f in ("input", "output", "cached"))
            else:
                out[(section, key, "flat")] = tuple(val.get(f) for f in ("input", "output", "cached"))
    return out


def diff_summary(local, remote):
    """返回人类可读的变更列表（新增 / 删除 / 价格变化）。"""
    lmap, rmap = flatten_rates(local), flatten_rates(remote)
    lines = []
    for key in sorted(set(rmap) - set(lmap)):
        section, name, slot = key
        lines.append(f"  + 新增 {name}（{section}）")
    for key in sorted(set(lmap) - set(rmap)):
        section, name, slot = key
        lines.append(f"  - 移除 {name}（{section}）")
    for key in sorted(set(lmap) & set(rmap)):
        if lmap[key] != rmap[key]:
            section, name, slot = key
            old_s = "/".join("-" if v is None else f"{v:g}" for v in lmap[key])
            new_s = "/".join("-" if v is None else f"{v:g}" for v in rmap[key])
            lines.append(f"  ~ {name} [{slot}]: {old_s} → {new_s}")
    return lines


def state_path(pricing_path):
    return os.path.join(os.path.dirname(os.path.abspath(pricing_path)), STATE_NAME)


def read_state(pricing_path):
    try:
        with open(state_path(pricing_path), encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def write_state(pricing_path, result, source, version):
    """记录检查状态（失败不阻塞主流程）。"""
    rec = {"last_checked_at": now().isoformat(timespec="seconds"), "last_result": result,
           "last_source": source, "last_version": version}
    try:
        with open(state_path(pricing_path), "w", encoding="utf-8") as f:
            json.dump(rec, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except OSError:
        pass


def throttled(pricing_path):
    """返回节流提示文本；未命中返回 None。"""
    st = read_state(pricing_path)
    ts = st.get("last_checked_at")
    if not isinstance(ts, str):
        return None
    try:
        checked = datetime.fromisoformat(ts)
    except ValueError:
        return None
    window = FRESH_FAIL if st.get("last_result") == "failed" else FRESH_OK
    if now() - checked < window:
        ver = st.get("last_version") or "未知"
        ago = now() - checked
        mins = int(ago.total_seconds() // 60)
        ago_s = f"{mins} 分钟前" if mins < 60 else f"{mins // 60} 小时前"
        return f"最近已于 {ago_s}检查过（{st.get('last_result')}，版本 {ver}），跳过本次联网"
    return None


def backup(path, keep):
    if keep <= 0 or not os.path.exists(path):
        return None
    stamp = now().strftime("%Y%m%d-%H%M%S")
    bak = f"{path}.bak-{stamp}"
    shutil.copy2(path, bak)
    olds = sorted(glob.glob(f"{path}.bak-*"))
    for old in olds[:-keep] if len(olds) > keep else []:
        try:
            os.remove(old)
        except OSError:
            pass
    return bak


def write_atomic(path, text):
    """原子写入：临时文件 + os.replace（避免半写状态）；保持原文件权限。"""
    d = os.path.dirname(os.path.abspath(path)) or "."
    try:
        mode = os.stat(path).st_mode & 0o777
    except OSError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(prefix=".pricing-tmp-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def emit(args, payload):
    """按 --json 或人类可读格式输出。"""
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    status = payload.get("status")
    if status == "disabled":
        print("已禁用联网（--offline / TOKEN_USAGE_NO_NET=1），价格表保持本地版本。")
        return
    if status == "skipped":
        print(payload.get("message", "节流跳过。"))
        return
    if status == "failed":
        print(f"价格表更新失败：{payload.get('message')}", file=sys.stderr)
        print(f"本地文件未改动：{payload.get('pricing')}", file=sys.stderr)
        return
    print("== Qoder Token 价格表 · 自动更新 ==")
    print(f"本地: {payload.get('pricing')}（v{payload.get('local_version') or '未知'}）")
    print(f"远端: v{payload.get('remote_version')}  ← 来源 {payload.get('source')}")
    if payload.get("update_available"):
        changes = payload.get("changes") or []
        if changes:
            print(f"差异（{len(changes)} 处）:")
            for line in changes:
                print(line)
        else:
            print("版本号更新（价格未见结构差异）")
    else:
        print("本地已是最新。")
    if payload.get("status") == "updated":
        print(f"已更新: {payload.get('pricing')}")
        if payload.get("backup"):
            print(f"备份:   {payload.get('backup')}（回滚 = 复制覆盖回去即可）")
    elif payload.get("update_available"):
        print("未写入（--check / --dry-run）；去掉对应参数即可更新。")


def main():
    args = parse_args()
    pricing = os.path.normpath(os.path.expanduser(args.pricing))

    def done(payload, code=0):
        emit(args, payload)
        sys.exit(code)

    if args.offline or os.environ.get("TOKEN_USAGE_NO_NET") == "1":
        done({"status": "disabled", "pricing": pricing})

    if not args.force and not args.dry_run:
        msg = throttled(pricing)
        if msg:
            done({"status": "skipped", "pricing": pricing, "message": msg})

    env_sources = os.environ.get("TOKEN_USAGE_PRICING_URL")
    sources = args.source or ([s.strip() for s in env_sources.split(",") if s.strip()] if env_sources else SOURCES)

    text, source, err = try_fetch_all(sources)
    if text is None:
        write_state(pricing, "failed", None, None)
        done({"status": "failed", "pricing": pricing, "message": f"全部更新源不可达: {err}"}, code=1)

    try:
        remote = json.loads(text)
    except json.JSONDecodeError as e:
        write_state(pricing, "failed", source, None)
        done({"status": "failed", "pricing": pricing, "message": f"远端内容不是合法 JSON: {e}"}, code=1)

    errs = validate_pricing(remote)
    if errs:
        write_state(pricing, "failed", source, None)
        done({"status": "failed", "pricing": pricing,
              "message": "远端内容未通过校验（已拒绝）: " + "; ".join(errs[:5])}, code=1)

    remote_ver = remote["_version"]
    local, local_err = load_local(pricing)
    local_ver = local.get("_version") if isinstance(local, dict) else None
    update_available = (
        version_tuple(remote_ver) is not None
        and (version_tuple(local_ver) is None or version_tuple(remote_ver) > version_tuple(local_ver))
    )
    changes = diff_summary(local, remote) if isinstance(local, dict) else (["  （本地缺失，将全新写入）"] if local is None else [])

    payload = {
        "status": "update-available" if update_available else "up-to-date",
        "pricing": pricing,
        "local_version": local_ver,
        "remote_version": remote_ver,
        "source": source,
        "update_available": update_available,
        "changes": changes,
        "local_error": local_err,
    }

    if not update_available:
        write_state(pricing, "up-to-date", source, remote_ver)
        done(payload)

    if args.check or args.dry_run:
        done(payload)

    bak = backup(pricing, args.keep)
    try:
        write_atomic(pricing, text)
    except OSError as e:
        done({"status": "failed", "pricing": pricing, "message": f"写入失败: {e}",
              "local_version": local_ver, "remote_version": remote_ver, "source": source}, code=1)

    write_state(pricing, "updated", source, remote_ver)
    payload["status"] = "updated"
    payload["backup"] = bak
    done(payload)


if __name__ == "__main__":
    main()
