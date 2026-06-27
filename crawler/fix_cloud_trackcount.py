#!/usr/bin/env python3
"""
修复云端 albums 集合中缺少 trackCount 字段的记录。
- 从网易云获取实际曲目数
- trackCount < 3  → 删除（单曲/EP）
- trackCount >= 3 → 写入 trackCount 字段
- API 出错        → 跳过保留

用法：
  cd crawler
  python fix_cloud_trackcount.py            # 正式执行
  python fix_cloud_trackcount.py --dry-run  # 只分析，不写云端
"""

import argparse
import json
import sys
import time
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdout.reconfigure(encoding='utf-8')

CONFIG_JSON = 'config.json'
BASE        = 'https://api.weixin.qq.com'
NE_HEADERS  = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer':    'https://music.163.com/',
}
MIN_TRACKS  = 3
WORKERS     = 10


# ── 微信 HTTP API ─────────────────────────────────────────────────────────────

def get_token(cfg):
    r = requests.get(f'{BASE}/cgi-bin/token',
        params={'grant_type': 'client_credential',
                'appid': cfg['appid'], 'secret': cfg['appsecret']},
        timeout=10)
    d = r.json()
    if 'access_token' not in d:
        raise RuntimeError(f'token 失败: {d}')
    return d['access_token']

def db_query(token, env, query):
    r = requests.post(f'{BASE}/tcb/databasequery',
        params={'access_token': token},
        json={'env': env, 'query': query}, timeout=20)
    return r.json()

def db_update_doc(token, env, doc_id, data_str):
    q = f'db.collection("albums").doc("{doc_id}").update({{data:{data_str}}})'
    r = requests.post(f'{BASE}/tcb/databaseupdate',
        params={'access_token': token},
        json={'env': env, 'query': q}, timeout=15)
    return r.json()

def db_delete_doc(token, env, doc_id):
    q = f'db.collection("albums").doc("{doc_id}").remove()'
    r = requests.post(f'{BASE}/tcb/databasedelete',
        params={'access_token': token},
        json={'env': env, 'query': q}, timeout=15)
    return r.json()

def parse_records(res):
    data = res.get('data', [])
    if not data:
        return []
    return [json.loads(x) if isinstance(x, str) else x for x in data]


# ── 网易云查询 ────────────────────────────────────────────────────────────────

def ne_track_count(source_id: str) -> int:
    """返回曲目数，-1 表示 API 出错或风控。"""
    try:
        r = requests.get(
            f'https://music.163.com/api/v1/album/{source_id}',
            headers=NE_HEADERS, timeout=12)
        d = r.json()
        if d.get('code') == 200:
            album = d.get('album', {})
            size  = album.get('size') or len(album.get('songs') or [])
            return int(size)
    except Exception as e:
        print(f'  [!] Netease {source_id}: {e}')
    return -1


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='只分析，不操作云端')
    args = parser.parse_args()

    with open(CONFIG_JSON, encoding='utf-8') as f:
        cfg = json.load(f)

    token = get_token(cfg)
    env   = cfg['env']

    # ── Step 1：分批拉取所有无 trackCount 记录 ─────────────────────────────────
    print('正在获取缺少 trackCount 的记录...')
    all_records = []
    offset = 0
    while True:
        q = (f'db.collection("albums")'
             f'.where({{trackCount:_.exists(false)}})'
             f'.skip({offset}).limit(100).get()')
        res    = db_query(token, env, q)
        batch  = parse_records(res)
        total  = res.get('pager', {}).get('Total', 0)
        if not batch:
            break
        all_records.extend(batch)
        print(f'  {len(all_records)} / {total}')
        if len(all_records) >= total:
            break
        offset += 100
        time.sleep(0.15)

    print(f'\n共 {len(all_records)} 条记录需要处理\n')

    # 只处理网易云来源（有 sourceId 才能查曲目数）
    ne_recs    = [r for r in all_records
                  if r.get('source') == 'netease' and r.get('sourceId')]
    skip_recs  = [r for r in all_records if r not in ne_recs]
    print(f'  网易云来源: {len(ne_recs)} 条')
    print(f'  非网易云/无sourceId: {len(skip_recs)} 条 (跳过)')

    # ── Step 2：并发查网易云曲目数 ────────────────────────────────────────────
    print(f'\n并发查询网易云曲目数（{WORKERS} 线程）...')

    fetch_results: dict[str, tuple[str, str, int]] = {}  # doc_id → (sourceId, title, count)

    def _fetch(rec):
        count = ne_track_count(rec['sourceId'])
        return rec['_id'], rec['sourceId'], rec.get('title', ''), count

    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_fetch, r): r for r in ne_recs}
        for future in as_completed(futures):
            doc_id, sid, title, count = future.result()
            fetch_results[doc_id] = (sid, title, count)
            done += 1
            if done % 100 == 0:
                print(f'  {done} / {len(ne_recs)}')
        print(f'  {done} / {len(ne_recs)} ✓')

    to_delete = [(doc_id, sid, title)
                 for doc_id, (sid, title, count) in fetch_results.items()
                 if 0 < count < MIN_TRACKS]
    to_update = [(doc_id, sid, title, count)
                 for doc_id, (sid, title, count) in fetch_results.items()
                 if count >= MIN_TRACKS]
    api_error = [(doc_id, sid, title)
                 for doc_id, (sid, title, count) in fetch_results.items()
                 if count <= 0]

    print(f'\n分类结果:')
    print(f'  删除（单曲/EP，曲目<{MIN_TRACKS}）: {len(to_delete)} 张')
    print(f'  更新 trackCount（专辑）:          {len(to_update)} 张')
    print(f'  API 出错/风控跳过:                {len(api_error)} 张')

    if to_delete:
        print(f'\n删除示例（前10）:')
        for doc_id, sid, title in to_delete[:10]:
            count = fetch_results[doc_id][2]
            print(f'  [{count}首] {title}')

    if args.dry_run:
        print('\n[dry-run] 未操作云端。')
        return

    # ── Step 3：删除单曲/EP ────────────────────────────────────────────────────
    print(f'\n删除单曲/EP...')
    deleted = 0
    for i, (doc_id, sid, title) in enumerate(to_delete):
        res = db_delete_doc(token, env, doc_id)
        if res.get('errcode', 0) == 0:
            deleted += 1
        else:
            print(f'  [!] 删除失败《{title}》: {res}')
        if (i + 1) % 200 == 0:
            token = get_token(cfg)   # 刷新 token
            print(f'  {deleted} / {len(to_delete)}')
        time.sleep(0.04)

    # ── Step 4：更新 trackCount ────────────────────────────────────────────────
    print(f'\n更新 trackCount 字段...')
    updated = 0
    for i, (doc_id, sid, title, count) in enumerate(to_update):
        res = db_update_doc(token, env, doc_id, f'{{trackCount:{count}}}')
        if res.get('errcode', 0) == 0:
            updated += 1
        else:
            print(f'  [!] 更新失败《{title}》: {res}')
        if (i + 1) % 200 == 0:
            token = get_token(cfg)
            print(f'  {updated} / {len(to_update)}')
        time.sleep(0.04)

    print(f'\n完成！')
    print(f'  删除单曲/EP:     {deleted} 张')
    print(f'  更新 trackCount: {updated} 张')
    print(f'  API 出错保留:    {len(api_error)} 张')


if __name__ == '__main__':
    main()
