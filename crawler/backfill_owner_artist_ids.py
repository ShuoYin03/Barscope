#!/usr/bin/env python3
"""
回填云端 albums 集合缺失的 ownerArtistIds 字段（专辑「所有者」ID 集合）。

背景：
  引入所有者/参与者分离模型后，专辑归属（挂在谁的个人主页 + Feat 判定基准）改由
  新字段 ownerArtistIds 决定，artistIds 退化为「全体参与者」（驱动 hero 的 +N tag）。
  存量专辑没有 ownerArtistIds，读取侧暂时靠回退（缺字段则按 artistIds/neteaseArtistId
  归属）兜底，但字段长期稀疏；且已修正专辑（user-admin-correction）在 syncAlbumTracks
  里会跳过归属块，永远不会被自动补上该字段。

  本脚本对所有缺 ownerArtistIds 的专辑做一次性、行为中性的回填：
      ownerArtistIds = artistIds        （非空时）
                     = [neteaseArtistId] （artistIds 为空但有 neteaseArtistId）
                     = 跳过              （两者都没有）
  回填值 == 读取侧回退现在算出的值，所以不改变任何归属行为，只是把它落成显式字段。

  注意：本脚本不会把「被错误归给全部合作者」的合辑（如 The Collections）收敛成单主人——
  那是编辑判断，应走正常纠错流程，不由脚本猜测。

用法：
  cd crawler
  python backfill_owner_artist_ids.py            # 正式执行
  python backfill_owner_artist_ids.py --dry-run  # 只分析，不写云端
  python backfill_owner_artist_ids.py --limit 50 # 只处理前 N 条（测试用）
"""

import argparse
import json
import sys
import time
import requests

sys.stdout.reconfigure(encoding='utf-8')

CONFIG_JSON = 'config.json'
BASE        = 'https://api.weixin.qq.com'


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
    return [json.loads(x) if isinstance(x, str) else x for x in data]


# ── 主流程 ────────────────────────────────────────────────────────────────────

def resolve_owner_ids(rec):
    """回退口径一致：artistIds 非空则用之，否则退到 [neteaseArtistId]，都没有则 None。"""
    ids = [str(x) for x in (rec.get('artistIds') or []) if str(x).strip()]
    if ids:
        return ids
    ne = str(rec.get('neteaseArtistId') or '').strip()
    return [ne] if ne else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true', help='只分析，不操作云端')
    parser.add_argument('--limit', type=int, default=0, help='只处理前 N 条（测试用）')
    args = parser.parse_args()

    with open(CONFIG_JSON, encoding='utf-8') as f:
        cfg = json.load(f)

    token = get_token(cfg)
    env   = cfg['env']

    # ── Step 1：分批拉取全部专辑 ───────────────────────────────────────────────
    print('正在获取全部专辑...')
    all_records = []
    offset = 0
    while True:
        q = (f'db.collection("albums")'
             f'.field({{_id:true,title:true,artistIds:true,neteaseArtistId:true,'
             f'ownerArtistIds:true,ownershipSource:true}})'
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
        time.sleep(0.15)

    if args.limit:
        all_records = all_records[:args.limit]

    print(f'\n共 {len(all_records)} 条专辑\n')

    # ── Step 2：分类 ───────────────────────────────────────────────────────────
    to_update  = []   # (doc_id, title, owner_ids, is_correction)
    already     = 0   # 已有 ownerArtistIds，跳过
    no_id       = []  # 无 artistIds 也无 neteaseArtistId，无法回填
    for rec in all_records:
        existing = rec.get('ownerArtistIds')
        if isinstance(existing, list) and existing:
            already += 1
            continue
        owner_ids = resolve_owner_ids(rec)
        if not owner_ids:
            no_id.append(rec.get('title', ''))
            continue
        is_corr = rec.get('ownershipSource') == 'user-admin-correction'
        to_update.append((rec['_id'], rec.get('title', ''), owner_ids, is_corr))

    corr_count = sum(1 for x in to_update if x[3])
    print('分类结果:')
    print(f'  需要回填 ownerArtistIds: {len(to_update)} 张（其中已修正专辑 {corr_count} 张）')
    print(f'  已有该字段，跳过:        {already} 张')
    print(f'  无 id 可回填，跳过:      {len(no_id)} 张')

    if to_update:
        print('\n回填示例（前10）:')
        for doc_id, title, ids, is_corr in to_update[:10]:
            tag = ' [已修正]' if is_corr else ''
            print(f'  《{title}》{tag} -> {ids}')
    if no_id:
        print('\n无 id 示例（前10）:')
        for title in no_id[:10]:
            print(f'  《{title}》')

    if args.dry_run:
        print('\n[dry-run] 未操作云端。')
        return

    # ── 备份：写库前把全部记录快照落盘（含 _id 及所有相关字段，可据此回滚）──────────
    import os
    os.makedirs('backups', exist_ok=True)
    stamp = time.strftime('%Y%m%d_%H%M%S')
    backup_path = os.path.join('backups', f'owner_backfill_{stamp}.json')
    with open(backup_path, 'w', encoding='utf-8') as bf:
        json.dump({
            'takenAt': stamp,
            'note': '回填 ownerArtistIds 前的快照。回滚：对 toUpdateIds 中的 _id 移除 ownerArtistIds 字段。',
            'toUpdateIds': [x[0] for x in to_update],
            'records': all_records,
        }, bf, ensure_ascii=False, indent=2)
    print(f'\n已备份 {len(all_records)} 条记录到 {backup_path}')

    # ── Step 3：写入 ownerArtistIds ────────────────────────────────────────────
    print('\n写入 ownerArtistIds 字段...')
    updated = 0
    write_errors = []
    for i, (doc_id, title, ids, _is_corr) in enumerate(to_update):
        data_str = f'{{ownerArtistIds:{json.dumps(ids, ensure_ascii=False)}}}'
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

    print('\n完成！')
    print(f'  回填 ownerArtistIds: {updated} 张')
    print(f'  写入失败/网络异常:   {len(write_errors)} 张')
    if write_errors:
        print('  失败示例（前10）：')
        for doc_id, title in write_errors[:10]:
            print(f'    《{title}》')


if __name__ == '__main__':
    main()
