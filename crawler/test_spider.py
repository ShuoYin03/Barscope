#!/usr/bin/env python3
"""
Barscope 爬虫测试脚本
测试网易云音乐 + QQ音乐 能否正常返回说唱专辑数据

运行：
  pip install requests
  python test_spider.py
"""

import json
import time
import requests

# ─── 请求头 ────────────────────────────────────────────────────────────────────

HEADERS_NETEASE = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://music.163.com/",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

HEADERS_QQ = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Referer": "https://y.qq.com/",
    "Accept": "application/json",
}

SEARCH_KEYWORDS = ["中国说唱", "中文说唱", "GAI", "VAVA", "trap 说唱"]


# ─── 网易云音乐 ─────────────────────────────────────────────────────────────────

def test_netease(keyword="中国说唱", limit=10):
    print(f"\n【网易云音乐】搜索: '{keyword}'")
    try:
        resp = requests.post(
            "https://music.163.com/api/search/get",
            headers=HEADERS_NETEASE,
            data={
                "s": keyword,
                "type": "10",   # 10 = 专辑
                "limit": str(limit),
                "offset": "0",
            },
            timeout=12,
        )
        print(f"  HTTP {resp.status_code}")
        data = resp.json()
        api_code = data.get("code")
        print(f"  API code: {api_code}")

        if api_code == 200:
            albums = data.get("result", {}).get("albums", [])
            print(f"  ✓ 找到专辑: {len(albums)} 张")
            for a in albums[:5]:
                name     = a.get("name", "?")
                artist   = a.get("artist", {}).get("name", "?")
                cover    = a.get("picUrl", "")
                pub_ms   = a.get("publishTime", 0)
                year     = str(pub_ms)[:4] if pub_ms else "?"
                print(f"    ▸ {name} — {artist}  ({year})  封面:{'✓' if cover else '✗'}")
            return albums
        else:
            print(f"  ✗ 返回非200: {json.dumps(data, ensure_ascii=False)[:300]}")
            return []

    except Exception as exc:
        print(f"  ✗ 异常: {exc}")
        return []


# ─── QQ 音乐 ───────────────────────────────────────────────────────────────────

def test_qqmusic(keyword="中国说唱", limit=10):
    print(f"\n【QQ音乐】搜索: '{keyword}'")
    try:
        resp = requests.get(
            "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp",
            headers=HEADERS_QQ,
            params={
                "w":           keyword,
                "format":      "json",
                "inCharset":   "utf8",
                "outCharset":  "utf-8",
                "platform":    "yqq.json",
                "needNewCode": "0",
                "t":           "8",     # 8 = 专辑
                "aggr":        "1",
                "p":           "1",
                "n":           str(limit),
            },
            timeout=12,
        )
        print(f"  HTTP {resp.status_code}")
        data = resp.json()
        api_code = data.get("code")
        print(f"  API code: {api_code}")

        if api_code == 0:
            albums = data.get("data", {}).get("album", {}).get("list", [])
            print(f"  ✓ 找到专辑: {len(albums)} 张")
            for a in albums[:5]:
                name   = a.get("albumname", "?")
                artist = a.get("singername", "?")
                mid    = a.get("albummid", "")
                year   = (a.get("publictime") or "")[:4] or "?"
                cover  = f"https://y.gtimg.cn/music/photo_new/T002R300x300M000{mid}.jpg" if mid else ""
                print(f"    ▸ {name} — {artist}  ({year})  封面:{'✓' if cover else '✗'}")
            return albums
        else:
            print(f"  ✗ 返回非0: {json.dumps(data, ensure_ascii=False)[:300]}")
            return []

    except Exception as exc:
        print(f"  ✗ 异常: {exc}")
        return []


# ─── 主入口 ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 55)
    print("  Barscope · 爬虫接口测试")
    print("=" * 55)

    keyword = "中国说唱"

    ne = test_netease(keyword, limit=10)
    time.sleep(1)
    qq = test_qqmusic(keyword, limit=10)

    print("\n" + "=" * 55)
    print("测试结果汇总")
    print("=" * 55)
    print(f"  网易云音乐: {'✓ 可用' if ne else '✗ 不可用'}  ({len(ne)} 条数据)")
    print(f"  QQ 音乐:    {'✓ 可用' if qq else '✗ 不可用'}  ({len(qq)} 条数据)")
    print("=" * 55)

    if not ne and not qq:
        print("\n⚠️  两个接口都不通，可能需要添加 Cookie 或换 API 方案。")
    elif ne and not qq:
        print("\n→ 建议主用网易云音乐数据源。")
    elif qq and not ne:
        print("\n→ 建议主用 QQ音乐数据源。")
    else:
        print("\n→ 两个数据源都可用，可以双源合并去重。")
