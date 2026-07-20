#!/usr/bin/env python3
"""Remove QQ album candidates whose titles are >=70% similar to ANY existing BarScope album.

This is deliberately aggressive and follows the current curation rule:
- compare against the entire live mini-program `albums` collection, not only the mapped artist
- strip platform-only labels such as Explicit
- normalize punctuation/case/spacing
- normalize Traditional Chinese to Simplified Chinese when OpenCC is available
- remove every candidate whose best existing-title similarity is >= threshold (default 0.70)

Outputs:
- overwrites qq_album_need_submit.json with the remaining candidates
- writes removed matches to qq_album_fuzzy_overlap.json
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

import requests

BASE_DIR = Path(__file__).resolve().parent
CONFIG_FILE = BASE_DIR / "config.json"

try:
    from opencc import OpenCC  # type: ignore
    OPENCC = OpenCC("t2s")
except Exception:
    OPENCC = None

PLATFORM_SUFFIX_RE = re.compile(
    r"(?:"
    r"[\s\-–—_:：]*[\(\[（【]?\s*(?:explicit|deluxe|extended|remaster(?:ed)?|clean)\s*[\)\]）】]?\s*$"
    r")",
    re.IGNORECASE,
)


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def get_access_token(appid: str, appsecret: str) -> str:
    r = requests.get(
        "https://api.weixin.qq.com/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=15,
    )
    r.raise_for_status()
    payload = r.json()
    token = payload.get("access_token")
    if not token:
        raise RuntimeError(f"获取 access_token 失败: {payload}")
    return str(token)


def invoke_catalog_page(token: str, env: str, offset: int, limit: int = 100) -> dict[str, Any]:
    r = requests.post(
        "https://api.weixin.qq.com/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": "fastCompareQQAlbums"},
        json={"action": "catalogPage", "offset": offset, "limit": limit},
        timeout=60,
    )
    r.raise_for_status()
    payload = r.json()
    if payload.get("errcode", 0) != 0:
        raise RuntimeError(f"云函数调用失败: {payload}")
    result = json.loads(payload.get("resp_data", "{}"))
    if not result.get("success"):
        raise RuntimeError(result.get("error") or "catalogPage failed")
    return result


def normalize_title(value: str) -> str:
    text = unicodedata.normalize("NFKC", str(value or "")).strip().lower()
    # Repeatedly remove platform-only end labels, e.g. "(Explicit)" or " Explicit".
    old = None
    while old != text:
        old = text
        text = PLATFORM_SUFFIX_RE.sub("", text).strip()
    text = re.sub(r"\bexplicit\b", "", text, flags=re.IGNORECASE)
    if OPENCC is not None:
        text = OPENCC.convert(text)
    return re.sub(r"[\s\-_·•:：()（）\[\]【】<>《》'\"“”‘’.,，。!?！？&＋+／/\\|]+", "", text)


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    # Containment should be treated as highly similar when the shorter title still carries most of
    # the longer title. This catches platform suffix/prefix noise beyond Explicit.
    if a in b or b in a:
        shorter, longer = sorted((len(a), len(b)))
        if longer and shorter / longer >= 0.70:
            return max(0.90, shorter / longer)
    return SequenceMatcher(None, a, b).ratio()


def fetch_catalog(token: str, env: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        result = invoke_catalog_page(token, env, offset, 100)
        page = result.get("rows", []) or []
        rows.extend(page)
        print(f"  已读取小程序专辑库 {len(rows)} 张")
        if not result.get("hasMore") or not page:
            break
        offset += len(page)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="按全库标题 70% 相似度剔除 QQ 重复专辑")
    parser.add_argument("--input", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--output", default=str(BASE_DIR / "qq_album_need_submit.json"))
    parser.add_argument("--overlap-output", default=str(BASE_DIR / "qq_album_fuzzy_overlap.json"))
    parser.add_argument("--threshold", type=float, default=0.70)
    args = parser.parse_args()

    threshold = max(0.0, min(1.0, float(args.threshold)))
    source = load_json(Path(args.input))
    candidates = source.get("results", []) or []

    cfg = load_json(CONFIG_FILE)
    token = get_access_token(str(cfg.get("appid") or ""), str(cfg.get("appsecret") or ""))
    env = str(cfg.get("env") or "")

    if OPENCC is None:
        print("⚠️ 未安装 OpenCC：简繁体统一将不完整。建议先运行：pip3 install opencc-python-reimplemented")

    print(f"读取候选 {len(candidates)} 张；开始拉取现存小程序完整专辑库……")
    catalog = fetch_catalog(token, env)
    normalized_catalog = [
        (album, normalize_title(str(album.get("title") or "")))
        for album in catalog
        if str(album.get("title") or "").strip()
    ]

    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []

    for idx, item in enumerate(candidates, 1):
        candidate_title = str(item.get("title") or "")
        candidate_norm = normalize_title(candidate_title)
        best_album: dict[str, Any] | None = None
        best_score = 0.0

        for album, album_norm in normalized_catalog:
            score = similarity(candidate_norm, album_norm)
            if score > best_score:
                best_score = score
                best_album = album
                if best_score >= 1.0:
                    break

        if best_album is not None and best_score >= threshold:
            removed.append({
                **item,
                "matchedExistingAlbumId": best_album.get("_id"),
                "matchedExistingTitle": best_album.get("title"),
                "matchedExistingReleaseDate": best_album.get("releaseDate") or "",
                "titleSimilarity": round(best_score, 4),
                "filterReason": f"现存小程序专辑库存在标题相似度 {best_score:.0%} 的专辑",
                "filteredBy": "global_title_similarity",
            })
        else:
            kept.append(item)

        if idx % 50 == 0 or idx == len(candidates):
            print(f"  模糊去重 {idx}/{len(candidates)} · 剔除 {len(removed)} · 保留 {len(kept)}")

    Path(args.output).write_text(
        json.dumps({"source": "qq_album_need_submit_fuzzy_pruned", "count": len(kept), "results": kept}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    Path(args.overlap_output).write_text(
        json.dumps({"source": "qq_album_fuzzy_overlap", "count": len(removed), "threshold": threshold, "results": removed}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print("\n完成")
    print(f"全库 >= {threshold:.0%} 相似度剔除: {len(removed)} -> {args.overlap_output}")
    print(f"最终剩余需要提交:       {len(kept)} -> {args.output}")


if __name__ == "__main__":
    main()
