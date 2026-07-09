#!/usr/bin/env python3
"""
修复云端 albums 集合中缺失的 artistIds 字段（合作歌手 ID 列表）。

背景：
  爬虫入库时曾经只把「主要歌手」的网易云 ID 写进 neteaseArtistId 字段，
  合作/特邀歌手（如《最高》里马思唯、KnowKnow、PSY.P、Melo）没有各自的 ID
  被记录下来，导致这些歌手的个人页查专辑（按 artistId 精确匹配 neteaseArtistId）
  漏掉了他们合作参与的专辑。

  本脚本对存量的网易云来源专辑重新调用专辑详情接口，取出完整 artists[] 数组，
  把每位歌手的 id 写入新增字段 artistIds（数组），getAlbums 云函数据此改为
  「neteaseArtistId 匹配 或 artistIds 数组包含」来查询。

用法：
  cd crawler
  python backfill_artist_ids.py            # 正式执行，覆盖全部网易云专辑
  python backfill_artist_ids.py --dry-run  # 只分析，不写云端
  python backfill_artist_ids.py --limit 50 # 只处理前 N 条（测试用）
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

def parse_records(res):
    data = res.get('data', [])
    if not data:
        return []
    return [json.loads(x) if isinstance(x, str) else x for x in data]


# ── 网易云查询 ────────────────────────────────────────────────────────────────

def ne_artist_ids(source_id: str):
    """返回该专辑全部歌手的网易云 ID 列表；None 表示 API 出错或风控。"""
    try:
        r = requests.get(
            f'https://music.163.com/api/v1/album/{source_id}',
            headers=NE_HEADERS, timeout=12)
        d = r.json()
        if d.get('code') == 200:
            artists = d.get('album', {}).get('artists') or []
            ids = []
            seen = set()
            for a in artists:
                aid = a.get('id')
                if aid and str(aid) not in seen:
                    seen.add(str(aid))
                    ids.append(str(aid))
            return ids
    except Exception as e:
        print(f'  [!] Netease {source_id}: {e}')
    return None


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='只分析，不操作云端')
    parser.add_argument('--limit', type=int, default=0, help='只处理前 N 条（测试用）')
    args = parser.parse_args()

    with open(CONFIG_JSON, encoding='utf-8') as f:
        cfg = json.load(f)

    token = get_token(cfg)
    env   = cfg['env']

    # ── Step 1：分批拉取所有网易云来源的专辑 ───────────────────────────────────
    print('正在获取全部网易云来源专辑...')
    all_records = []
    offset = 0
    while True:
        q = (f'db.collection("albums")'
             f'.where({{source:"netease",sourceId:_.neq("")}})'
             f'.field({{_id:true,sourceId:true,title:true,artist:true,artistIds:true}})'
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

    if args.limit:
        all_records = all_records[:args.limit]

    print(f'\n共 {len(all_records)} 条网易云专辑需要处理\n')

    # ── Step 2：并发查网易云 artists 列表 ──────────────────────────────────────
    print(f'并发查询网易云专辑详情（{WORKERS} 线程）...')

    fetch_results = {}  # doc_id -> (sourceId, title, ids or None)

    def _fetch(rec):
        ids = ne_artist_ids(rec['sourceId'])
        return rec['_id'], rec['sourceId'], rec.get('title', ''), ids

    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(_fetch, r): r for r in all_records}
        for future in as_completed(futures):
            doc_id, sid, title, ids = future.result()
            fetch_results[doc_id] = (sid, title, ids)
            done += 1
            if done % 100 == 0:
                print(f'  {done} / {len(all_records)}')
        print(f'  {done} / {len(all_records)} ✓')

    existing_by_id = {r['_id']: (r.get('artistIds') or []) for r in all_records}

    to_update = []  # (doc_id, title, new_ids)
    unchanged  = 0
    api_error  = []
    for doc_id, (sid, title, ids) in fetch_results.items():
        if ids is None:
            api_error.append((doc_id, sid, title))
            continue
        if not ids:
            continue
        if sorted(ids) == sorted(existing_by_id.get(doc_id, [])):
            unchanged += 1
            continue
        to_update.append((doc_id, title, ids))

    print(f'\n分类结果:')
    print(f'  需要写入 artistIds:  {len(to_update)} 张')
    print(f'  已是最新，跳过:      {unchanged} 张')
    print(f'  API 出错/风控跳过:   {len(api_error)} 张')

    if to_update:
        print(f'\n更新示例（前10）:')
        for doc_id, title, ids in to_update[:10]:
            print(f'  《{title}》 -> {ids}')

    if args.dry_run:
        print('\n[dry-run] 未操作云端。')
        return

    # ── Step 3：写入 artistIds ─────────────────────────────────────────────────
    print(f'\n写入 artistIds 字段...')
    updated = 0
    write_errors = []
    for i, (doc_id, title, ids) in enumerate(to_update):
        data_str = f'{{artistIds:{json.dumps(ids, ensure_ascii=False)}}}'
        try:
            res = db_update_doc(token, env, doc_id, data_str)
        except Exception as e:
            print(f'  [!] 网络异常《{title}》: {e}')
            write_errors.append((doc_id, title))
            time.sleep(1)
            continue
        if res.get('errcode', 0) == 0:
            updated += 1
        else:
            print(f'  [!] 更新失败《{title}》: {res}')
            write_errors.append((doc_id, title))
        if (i + 1) % 200 == 0:
            try:
                token = get_token(cfg)  # 刷新 token
            except Exception as e:
                print(f'  [!] 刷新 token 失败，沿用旧 token: {e}')
            print(f'  {updated} / {len(to_update)}')
        time.sleep(0.04)

    print(f'\n完成！')
    print(f'  写入 artistIds: {updated} 张')
    print(f'  写入失败/网络异常: {len(write_errors)} 张')
    print(f'  API 出错保留:   {len(api_error)} 张')
    if write_errors:
        print('  失败示例（前10）：')
        for doc_id, title in write_errors[:10]:
            print(f'    《{title}》')


if __name__ == '__main__':
    main()
