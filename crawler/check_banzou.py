#!/usr/bin/env python3
"""
统计有多少张专辑里存在歌曲名包含「伴奏」两个字。

用法：
  cd crawler
  python check_banzou.py
"""

import json
import sys
import time
import requests

sys.stdout.reconfigure(encoding='utf-8')

CONFIG_JSON = 'config.json'
BASE        = 'https://api.weixin.qq.com'
KEYWORD     = '伴奏'


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


def parse_records(res):
    data = res.get('data', [])
    if not data:
        return []
    return [json.loads(x) if isinstance(x, str) else x for x in data]


def main():
    with open(CONFIG_JSON, encoding='utf-8') as f:
        cfg = json.load(f)

    token = get_token(cfg)
    env   = cfg['env']

    print('正在拉取所有含 tracks 字段的专辑...')
    all_records = []
    offset = 0
    while True:
        q = (f'db.collection("albums")'
             f'.where({{tracks:_.exists(true)}})'
             f'.field({{title:true,artist:true,tracks:true}})'
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
        if (offset // 100) % 50 == 0:
            token = get_token(cfg)

    print(f'\n共 {len(all_records)} 张专辑含 tracks 字段\n')

    hits = []
    for rec in all_records:
        tracks = rec.get('tracks') or []
        matched = [t.get('name', '') for t in tracks if KEYWORD in (t.get('name') or '')]
        if matched:
            hits.append((rec.get('title', ''), rec.get('artist', ''), matched))

    print(f'包含「{KEYWORD}」曲目的专辑数: {len(hits)}\n')
    for title, artist, matched in hits:
        print(f'  《{title}》- {artist}: {matched}')


if __name__ == '__main__':
    main()
