#!/usr/bin/env python3
"""
Beatween · 诊断脚本 —— 测试 syncArtistMetadata 云函数用到的各个接口，
逐个单独探测哪个接口真的能拿到歌手头像 / 封面图。

背景：
  cloudfunctions/syncArtistMetadata/index.js 依次尝试 6 个 JSON 接口 +
  4 个移动端网页兜底抓图，"第一个成功的就用"，所以平时看不出到底是哪个
  接口在起作用、哪些接口一直是废的。这个脚本把 6+4 个接口逐个单独打一遍，
  分别统计每个接口的成功率，方便判断问题出在哪一层。

注意：
  本机网络出口和云函数所在的腾讯云机房不是同一个 IP 段。如果本地测试
  大量成功，但线上云函数经常失败/超时，大概率是腾讯云出口 IP 被网易云
  风控/限流，而不是接口本身失效——这也是本脚本要帮你排除的一种可能性。

用法：
  cd crawler
  python test_artist_image_sources.py                  # 从 rappers.json 随机抽 12 个
  python test_artist_image_sources.py --count 30        # 抽 30 个
  python test_artist_image_sources.py --ids 123416,197248  # 指定艺人 ID
  python test_artist_image_sources.py --json-out result.json  # 保存原始结果
"""

import argparse
import json
import os
import random
import re
import sys
import time
from typing import Optional

import requests

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RAPPERS_FILE = os.path.join(BASE_DIR, "rappers.json")

REQUEST_TIMEOUT = 12
SLEEP_BETWEEN_REQUESTS = 0.15

# 与 cloudfunctions/syncArtistMetadata/index.js 完全一致的接口列表和请求头，
# 逐个单独测试而不是"第一个成功就停"。
JSON_ENDPOINTS = [
    ("head/info (interface)", "https://interface.music.163.com/api/artist/head/info/get?id={id}"),
    ("head/info (music)",     "https://music.163.com/api/artist/head/info/get?id={id}"),
    ("v1/artist (interface)", "https://interface.music.163.com/api/v1/artist/{id}"),
    ("v1/artist (music)",     "https://music.163.com/api/v1/artist/{id}"),
    ("artist (interface)",    "https://interface.music.163.com/api/artist/{id}"),
    ("artist (music)",        "https://music.163.com/api/artist/{id}"),
]

MOBILE_ENDPOINTS = [
    ("m/artist?id (y)",  "https://y.music.163.com/m/artist?id={id}"),
    ("m/artist?id",      "https://music.163.com/m/artist?id={id}"),
    ("m/artist/id (y)",  "https://y.music.163.com/m/artist/{id}"),
    ("m/artist/id",      "https://music.163.com/m/artist/{id}"),
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 Mobile/15E148 NeteaseMusic/9.0.0"
    ),
    "Referer": "https://y.music.163.com/",
    "Accept": "text/html,application/json,text/plain,*/*",
}


# ── 与 index.js 对齐的字段提取 / 校验逻辑 ────────────────────────────────────────

def is_real_image_url(url: Optional[str]) -> bool:
    s = str(url or "").strip()
    if not s or not s.startswith("http"):
        return False
    if "music.126.net" not in s:
        return False
    for bad in ("default_avatar", "anonymous", "5639395138885805", "109951163563"):
        if bad in s:
            return False
    return True


def flatten_artist_detail(detail: dict) -> dict:
    """对应 index.js 的 flattenArtistDetail：把各种接口形状拍平成统一字段。"""
    data = detail.get("data") or {}
    artist = detail.get("artist") or data.get("artist") or data.get("artistInfo") or {}
    user = detail.get("user") or data.get("user") or data.get("userInfo") or data.get("profile") or detail.get("profile") or {}
    profile = detail.get("profile") or data.get("profile") or {}

    def first(*vals):
        for v in vals:
            if v:
                return v
        return None

    return {
        "avatarUrl": first(user.get("avatarUrl"), profile.get("avatarUrl"), data.get("avatarUrl"),
                            artist.get("avatarUrl"), artist.get("picUrl"), artist.get("img1v1Url")),
        "picUrl": first(artist.get("picUrl"), data.get("picUrl"), profile.get("avatarUrl"), user.get("avatarUrl")),
        "backgroundUrl": first(user.get("backgroundUrl"), profile.get("backgroundUrl"), data.get("backgroundUrl"),
                                artist.get("backgroundUrl"), artist.get("cover"), artist.get("coverUrl")),
        "coverUrl": first(artist.get("coverUrl"), data.get("coverUrl"), user.get("backgroundUrl"), profile.get("backgroundUrl")),
        "cover": first(artist.get("cover"), data.get("cover"), user.get("backgroundUrl"), profile.get("backgroundUrl")),
    }


def extract_music_images(text: str) -> list:
    """对应 index.js 的 extractMusicImages：从原始 HTML 里扒 music.126.net 图片链接。"""
    raw = (text or "").replace("&quot;", '"').replace("&#34;", '"') \
        .replace("&amp;", "&").replace("&#x2F;", "/").replace("\\/", "/")
    marker = "music.126.net/"
    results = []
    pos = raw.find(marker)
    boundary_left = {'"', "'", "(", " "}
    boundary_right = {'"', "'", ")", " ", "<"}
    while pos >= 0:
        start = pos
        while start > 0 and raw[start - 1] not in boundary_left:
            start -= 1
        end = pos + len(marker)
        while end < len(raw) and raw[end] not in boundary_right:
            end += 1
        url = raw[start:end]
        if url.startswith("//"):
            url = "https:" + url
        if url.startswith("http://"):
            url = url.replace("http://", "https://")
        if is_real_image_url(url):
            results.append(url.replace("&amp;", "&").strip())
        pos = raw.find(marker, end)
    seen = []
    for u in results:
        if u not in seen:
            seen.append(u)
    return seen


# ── 单接口探测 ───────────────────────────────────────────────────────────────────

def probe_json_endpoint(url: str) -> dict:
    result = {"ok": False, "status": None, "error": None, "avatar": None, "cover": None}
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        result["status"] = resp.status_code
        if resp.status_code >= 400:
            result["error"] = f"HTTP {resp.status_code}"
            return result
        try:
            detail = resp.json()
        except ValueError:
            result["error"] = "响应不是合法 JSON（可能被风控返回了网页/空内容）"
            return result
        code = detail.get("code", 200)
        if int(code) == 404:
            result["error"] = "接口返回 code=404（艺人不存在于该接口）"
            return result
        flat = flatten_artist_detail(detail)
        avatar = flat["avatarUrl"] or flat["picUrl"]
        cover = flat["backgroundUrl"] or flat["coverUrl"] or flat["cover"]
        result["ok"] = True
        result["avatar"] = avatar if is_real_image_url(avatar) else None
        result["cover"] = cover if is_real_image_url(cover) else None
        result["raw_code"] = code
    except requests.exceptions.Timeout:
        result["error"] = "超时"
    except requests.exceptions.RequestException as e:
        result["error"] = f"请求异常: {e}"
    return result


def probe_mobile_endpoint(url: str) -> dict:
    result = {"ok": False, "status": None, "error": None, "avatar": None, "cover": None, "html_len": 0}
    try:
        resp = requests.get(url, headers=HEADERS, timeout=REQUEST_TIMEOUT)
        result["status"] = resp.status_code
        result["html_len"] = len(resp.text or "")
        if resp.status_code >= 400:
            result["error"] = f"HTTP {resp.status_code}"
            return result
        images = extract_music_images(resp.text)
        result["ok"] = True
        result["images_found"] = len(images)
        if images:
            result["avatar"] = images[0]
            result["cover"] = next((i for i in images if i != images[0]), images[0])
    except requests.exceptions.Timeout:
        result["error"] = "超时"
    except requests.exceptions.RequestException as e:
        result["error"] = f"请求异常: {e}"
    return result


# ── 主流程 ───────────────────────────────────────────────────────────────────────

def load_test_artists(ids_arg: Optional[str], count: int) -> list:
    if ids_arg:
        return [(f"id={aid}", int(aid)) for aid in ids_arg.split(",") if aid.strip()]

    if os.path.exists(RAPPERS_FILE):
        with open(RAPPERS_FILE, encoding="utf-8") as f:
            rappers = json.load(f).get("rappers", [])
        rappers = [r for r in rappers if r.get("id")]
        random.seed(2026)
        sample = random.sample(rappers, min(count, len(rappers)))
        return [(r.get("name", ""), r["id"]) for r in sample]

    print(f"[!] 找不到 {RAPPERS_FILE}，用内置的少量已知艺人 ID 兜底")
    return [("Dok2", 123416), ("R3HAB", 197248), ("TizzyT", 1204010)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ids", help="逗号分隔的艺人 ID，例如 123416,197248")
    parser.add_argument("--count", type=int, default=12, help="不指定 --ids 时，从 rappers.json 随机抽取的数量")
    parser.add_argument("--json-out", help="把完整原始结果保存到指定 json 文件")
    args = parser.parse_args()

    artists = load_test_artists(args.ids, args.count)
    print(f"共测试 {len(artists)} 位艺人：{', '.join(f'{n}({i})' for n, i in artists)}\n")

    all_endpoints = [("json", name, tpl) for name, tpl in JSON_ENDPOINTS] + \
                    [("mobile", name, tpl) for name, tpl in MOBILE_ENDPOINTS]

    # stats[endpoint_name] = {"avatar_ok": int, "cover_ok": int, "request_ok": int, "total": int, "errors": {msg: count}}
    stats = {name: {"avatar_ok": 0, "cover_ok": 0, "request_ok": 0, "total": 0, "errors": {}} for _, name, _ in all_endpoints}
    raw_results = {}

    for artist_name, artist_id in artists:
        print(f"── {artist_name} ({artist_id}) ──────────────────────────")
        raw_results[str(artist_id)] = {"name": artist_name, "endpoints": {}}

        for kind, name, url_tpl in all_endpoints:
            url = url_tpl.format(id=artist_id)
            probe = probe_json_endpoint(url) if kind == "json" else probe_mobile_endpoint(url)
            raw_results[str(artist_id)]["endpoints"][name] = {"url": url, **probe}

            s = stats[name]
            s["total"] += 1
            if probe["ok"]:
                s["request_ok"] += 1
            else:
                err = probe.get("error") or "未知错误"
                s["errors"][err] = s["errors"].get(err, 0) + 1
            if probe.get("avatar"):
                s["avatar_ok"] += 1
            if probe.get("cover"):
                s["cover_ok"] += 1

            avatar_mark = "头像✓" if probe.get("avatar") else "头像✗"
            cover_mark = "封面✓" if probe.get("cover") else "封面✗"
            status_txt = probe.get("status")
            err_txt = f" ({probe['error']})" if probe.get("error") else ""
            print(f"  [{kind:6}] {name:22} HTTP {status_txt}  {avatar_mark} {cover_mark}{err_txt}")

            time.sleep(SLEEP_BETWEEN_REQUESTS)
        print()

    # ── 汇总表 ──────────────────────────────────────────────────────────────────
    print("=" * 78)
    print(f"汇总（样本数 = {len(artists)}）")
    print("=" * 78)
    header = f"{'接口':24} {'请求成功率':>10} {'头像成功率':>10} {'封面成功率':>10}  常见错误"
    print(header)
    print("-" * len(header))
    for kind, name, _ in all_endpoints:
        s = stats[name]
        total = s["total"] or 1
        req_pct = s["request_ok"] / total * 100
        avatar_pct = s["avatar_ok"] / total * 100
        cover_pct = s["cover_ok"] / total * 100
        top_err = max(s["errors"].items(), key=lambda kv: kv[1])[0] if s["errors"] else "-"
        print(f"{name:24} {req_pct:9.0f}% {avatar_pct:9.0f}% {cover_pct:9.0f}%  {top_err}")

    print("\n提示：如果本地这里成功率很高，但线上 syncArtistMetadata 云函数经常拿不到图，")
    print("大概率是腾讯云机房出口 IP 被网易云音乐限流/风控，而不是接口本身失效。")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"stats": stats, "results": raw_results}, f, ensure_ascii=False, indent=2)
        print(f"\n完整原始结果已保存到 {args.json_out}")


if __name__ == "__main__":
    main()
