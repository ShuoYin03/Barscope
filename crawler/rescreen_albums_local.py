#!/usr/bin/env python3
"""
Beatween · 本地版专辑质量重筛（rescreenAlbums 云函数的本地替代）

背景：微信云函数所在的腾讯云出口 IP 被网易云临时限流，云端「重新筛选专辑」
（cloudfunctions/rescreenAlbums）大批量请求失败。本脚本用本地网络直接跑同样的
判定逻辑，标记字段（qualityRuleV2At / qualityScreenStatus / qualityScreenRetries）
和云函数共用，两边可以互相接力，不冲突。

规则（和 cloudfunctions/rescreenAlbums/index.js 保持一致）：
  - 曲目名剔除「伴奏」后剩余正式曲目数 < 3  → 移入候选区（album_candidates），从 albums 删除
  - 全专曲目名称去版本后缀后完全相同        → 同上
  - 请求失败（超时/无曲目）                → 记录重试次数，达到上限后标记 exhausted，不再重试
  - 通过检查                              → 标记 qualityScreenStatus=passed_v2

用法：
  cd crawler
  python rescreen_albums_local.py            # 正式执行
  python rescreen_albums_local.py --dry-run  # 只分析，不写云端
  python rescreen_albums_local.py --limit 50 # 只处理前 N 条（测试用）
"""

import argparse
import json
import re
import sys
import time
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.stdout.reconfigure(encoding='utf-8')

CONFIG_JSON  = 'config.json'
BASE         = 'https://api.weixin.qq.com'
NE_HEADERS   = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer':    'https://music.163.com/',
}
WORKERS      = 6
MAX_RETRIES  = 2

VERSION_KEYWORDS = re.compile(r'(伴奏|instrumental|inst\.?|off\s*vocal|karaoke|纯音乐|伴奏版|伴奏带)', re.IGNORECASE)
BRACKET = re.compile(r'[（(【\[][^）)】\]]*[）)】\]]')


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


SERVER_DATE = '__SERVER_DATE_SENTINEL__'


def _to_data_literal(data: dict) -> str:
    """把 dict 序列化成合法 JS 对象字面量；SERVER_DATE 哨兵值替换成 db.serverDate() 调用。
    用 json.dumps 而不是手工拼字符串，是为了让标题/艺人名里的引号、反斜杠、unicode 都被正确转义。"""
    raw = json.dumps(data, ensure_ascii=False)
    return raw.replace(f'"{SERVER_DATE}"', 'db.serverDate()')


def db_update_doc(token, env, collection, doc_id, data: dict):
    q = f'db.collection("{collection}").doc("{doc_id}").update({{data:{_to_data_literal(data)}}})'
    r = requests.post(f'{BASE}/tcb/databaseupdate',
        params={'access_token': token},
        json={'env': env, 'query': q}, timeout=15)
    return r.json()


def db_delete_doc(token, env, collection, doc_id):
    q = f'db.collection("{collection}").doc("{doc_id}").remove()'
    r = requests.post(f'{BASE}/tcb/databasedelete',
        params={'access_token': token},
        json={'env': env, 'query': q}, timeout=15)
    return r.json()


def db_add_doc(token, env, collection, data: dict):
    q = f'db.collection("{collection}").add({{data:{_to_data_literal(data)}}})'
    r = requests.post(f'{BASE}/tcb/databaseadd',
        params={'access_token': token},
        json={'env': env, 'query': q}, timeout=15)
    return r.json()


def parse_records(res):
    data = res.get('data', [])
    if not data:
        return []
    return [json.loads(x) if isinstance(x, str) else x for x in data]


# ── 判定逻辑（和 rescreenAlbums/index.js 的 inspectTracks 一致）───────────────────

def normalize_name(name: str) -> str:
    value = BRACKET.sub('', name or '')
    value = VERSION_KEYWORDS.sub('', value)
    value = re.sub(r'[\s\-_.·]', '', value)
    return value.lower()


def inspect_tracks(songs: list):
    names = [str(s.get('name') or '').strip() for s in songs if str(s.get('name') or '').strip()]
    accompaniment = [n for n in names if '伴奏' in n]
    real_count = len(names) - len(accompaniment)
    normalized = [normalize_name(n) for n in names if normalize_name(n)]
    all_same = len(normalized) >= 2 and len(set(normalized)) == 1
    if real_count < 3:
        return {'bad': True, 'reason': '剔除伴奏曲目后正式曲目不足3首', 'example': accompaniment[:4]}
    if all_same:
        return {'bad': True, 'reason': '全专曲目名称重复', 'example': names[:4]}
    return {'bad': False}


def ne_fetch_album_songs(source_id: str):
    """返回 (songs, error)。error 非空表示请求失败/无数据。"""
    try:
        r = requests.get(f'https://music.163.com/api/v1/album/{source_id}',
                          headers=NE_HEADERS, timeout=12)
        d = r.json()
        if d.get('code') == 200 and d.get('songs'):
            return d['songs'], None
        return [], f'no_songs(code={d.get("code")})'
    except Exception as e:
        return [], f'request_error({e})'


# ── 主流程 ────────────────────────────────────────────────────────────────────

def fetch_pending_albums(token, env, limit):
    print('正在拉取待筛选专辑（未筛过 / 之前请求失败待重试）...')
    all_records = []
    offset = 0
    while limit is None or len(all_records) < limit:
        q = ('db.collection("albums")'
             '.where(_.or(['
             '{qualityRuleV2At:_.exists(false)},'
             '{qualityScreenStatus:_.in(["failed_request_v2","failed_no_tracks"])}'
             ']))'
             '.field({_id:true,sourceId:true,title:true,artist:true,primaryArtist:true,'
             'neteaseArtistId:true,releaseYear:true,releaseDate:true,coverUrl:true,'
             'trackCount:true,genres:true,qualityScreenRetries:true})'
             f'.skip({offset}).limit(100).get()')
        res   = db_query(token, env, q)
        batch = parse_records(res)
        total = res.get('pager', {}).get('Total', 0)
        if not batch:
            break
        all_records.extend(batch)
        print(f'  {len(all_records)} / {total}')
        if len(all_records) >= total:
            break
        offset += 100
        time.sleep(0.1)
    if limit is not None:
        all_records = all_records[:limit]
    return all_records


def process_album(album, token, env, dry_run):
    source_id = str(album.get('sourceId') or '')
    title     = album.get('title', '')
    if not re.fullmatch(r'\d+', source_id):
        if not dry_run:
            db_update_doc(token, env, 'albums', album['_id'],
                          {'qualityRuleV2At': SERVER_DATE, 'qualityScreenStatus': 'skipped_no_source_id'})
        return {'checked': 1, 'moved': 0, 'failed': 0, 'skipped': 1}

    songs, err = ne_fetch_album_songs(source_id)
    if err:
        retries = int(album.get('qualityScreenRetries') or 0) + 1
        status  = 'failed_no_tracks' if 'no_songs' in err else 'failed_request_v2'
        if retries >= MAX_RETRIES:
            status += '_exhausted'
        if not dry_run:
            db_update_doc(token, env, 'albums', album['_id'],
                          {'qualityRuleV2At': SERVER_DATE, 'qualityScreenStatus': status, 'qualityScreenRetries': retries})
        return {'checked': 1, 'moved': 0, 'failed': 1, 'skipped': 0}

    verdict = inspect_tracks(songs)
    if not verdict['bad']:
        if not dry_run:
            db_update_doc(token, env, 'albums', album['_id'],
                          {'qualityRuleV2At': SERVER_DATE, 'qualityScreenStatus': 'passed_v2'})
        return {'checked': 1, 'moved': 0, 'failed': 0, 'skipped': 0}

    print(f'  → 判定不合格《{title}》: {verdict["reason"]} {verdict["example"]}')
    if dry_run:
        return {'checked': 1, 'moved': 1, 'failed': 0, 'skipped': 0}

    existing_res = db_query(token, env,
        f'db.collection("album_candidates").where({{sourceId:"{source_id}"}}).limit(1).get()')
    if existing_res.get('errcode', 0) != 0:
        print(f'    [!] 查询候选区失败，跳过本条，不删除原专辑: {existing_res.get("errmsg")}')
        return {'checked': 1, 'moved': 0, 'failed': 1, 'skipped': 0}

    already_candidate = bool(parse_records(existing_res))
    if not already_candidate:
        add_res = db_add_doc(token, env, 'album_candidates', {
            'sourceId': source_id,
            'title': title,
            'artist': album.get('artist', ''),
            'primaryArtist': album.get('primaryArtist', ''),
            'neteaseArtistId': album.get('neteaseArtistId', ''),
            'releaseYear': album.get('releaseYear', 0),
            'releaseDate': album.get('releaseDate', ''),
            'coverUrl': album.get('coverUrl', ''),
            'trackCount': album.get('trackCount') or len(songs),
            'genres': album.get('genres') or [],
            'source': 'netease',
            'crawlSource': 'quality-rescreen-v2-local',
            'candidateReason': verdict['reason'],
            'duplicateTrackExample': verdict['example'],
            'status': 'pending',
            'addedAt': SERVER_DATE,
            'decidedAt': None,
        })
        if add_res.get('errcode', 0) != 0:
            # Write into album_candidates did NOT succeed — must not delete the source
            # album, or the record is lost with no backup. Leave it untouched for retry.
            print(f'    [!] 写入候选区失败，不删除原专辑《{title}》: {add_res.get("errmsg")}')
            return {'checked': 1, 'moved': 0, 'failed': 1, 'skipped': 0}

    del_res = db_delete_doc(token, env, 'albums', album['_id'])
    if del_res.get('errcode', 0) != 0 or not del_res.get('deleted'):
        print(f'    [!] 候选区已写入，但删除原专辑失败《{title}》（会产生重复）: {del_res}')
        return {'checked': 1, 'moved': 0, 'failed': 1, 'skipped': 0}

    return {'checked': 1, 'moved': 1, 'failed': 0, 'skipped': 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='只分析，不写云端')
    parser.add_argument('--limit', type=int, default=None, help='只处理前 N 条（测试用）')
    args = parser.parse_args()

    with open(CONFIG_JSON, encoding='utf-8') as f:
        cfg = json.load(f)

    token = get_token(cfg)
    env   = cfg['env']

    albums = fetch_pending_albums(token, env, args.limit)
    print(f'\n共 {len(albums)} 张待处理\n')
    if not albums:
        print('没有需要筛选的专辑，结束。')
        return

    if args.dry_run:
        print('[dry-run] 只做曲目检查，不写云端\n')

    totals = {'checked': 0, 'moved': 0, 'failed': 0, 'skipped': 0}
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(process_album, a, token, env, args.dry_run): a for a in albums}
        for future in as_completed(futures):
            r = future.result()
            for k in totals:
                totals[k] += r[k]
            done += 1
            if done % 50 == 0:
                print(f'  进度 {done} / {len(albums)}')
                token = get_token(cfg)

    print(f'''
━━━ 完成 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  已检查:   {totals["checked"]}
  移入候选: {totals["moved"]}
  请求失败: {totals["failed"]}
  跳过:     {totals["skipped"]}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
''')


if __name__ == '__main__':
    main()
