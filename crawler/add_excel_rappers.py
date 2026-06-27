#!/usr/bin/env python3
"""
从 Excel 导入艺人到本地 rappers.json 和云端 artist_candidates。
- 移除原始种子艺人（24 个）
- 加入 Excel 中的艺人（去重）
- 云端：新艺人以 pending 写入，再批量改为 approved；已 declined 的也改为 approved
"""
import json, sys, time, requests, openpyxl

sys.stdout.reconfigure(encoding='utf-8')

EXCEL_PATH  = r'C:\Users\Shuo Yin\Documents\WeChat Files\wxid_zaty7aq2wz7y22\FileStorage\File\2026-06\artists(1)(1).xlsx'
RAPPERS_JSON = 'rappers.json'
CONFIG_JSON  = 'config.json'
BASE = 'https://api.weixin.qq.com'

SEED_IDS = {
    49779880, 30617566, 150257, 48351573, 12127564, 784257, 4479, 12276375,
    12193174, 188141, 31960441, 12236125, 865007, 12065096, 31561897, 12084497,
    12967449, 47409571, 12798895, 12119618, 12605500, 29304235, 187462, 47607639,
}

# ── 工具函数 ───────────────────────────────────────────────────────────────────

def get_token(cfg):
    r = requests.get(f'{BASE}/cgi-bin/token',
        params={'grant_type': 'client_credential', 'appid': cfg['appid'], 'secret': cfg['appsecret']},
        timeout=10)
    d = r.json()
    if 'access_token' not in d:
        raise RuntimeError(f'token 失败: {d}')
    return d['access_token']

def invoke_fn(token, env, name, body):
    r = requests.post(f'{BASE}/tcb/invokecloudfunction',
        params={'access_token': token, 'env': env, 'name': name},
        json=body, timeout=60)
    d = r.json()
    if d.get('errcode', 0) != 0:
        raise RuntimeError(f'云函数失败: {d}')
    return json.loads(d.get('resp_data', '{}'))

def db_query(token, env, query):
    r = requests.post(f'{BASE}/tcb/databasequery',
        params={'access_token': token}, json={'env': env, 'query': query}, timeout=15)
    return r.json()

def db_update(token, env, query):
    r = requests.post(f'{BASE}/tcb/databaseupdate',
        params={'access_token': token}, json={'env': env, 'query': query}, timeout=15)
    return r.json()

def parse_records(res):
    data = res.get('data', [])
    if not data:
        return []
    if isinstance(data[0], str):
        return [json.loads(x) for x in data]
    return data

# ── 1. 读 Excel（两个 sheet 合并去重）────────────────────────────────────────

wb = openpyxl.load_workbook(EXCEL_PATH)

seen_ids = set()
excel_artists = []

def add_artist(nid, name):
    try:
        nid = int(nid)
    except (ValueError, TypeError):
        return
    if not name or nid in seen_ids:
        return
    seen_ids.add(nid)
    excel_artists.append({'id': nid, 'name': str(name).strip()})

# artists sheet: col[2]=ID(str), col[3]=网易云返回名
for row in wb['artists'].iter_rows(min_row=2, values_only=True):
    add_artist(row[2], row[3])

# playlist_artists sheet: col[3]=ID(int), col[4]=艺人名
for row in wb['playlist_artists'].iter_rows(min_row=2, values_only=True):
    add_artist(row[3], row[4])

excel_ids = {a['id'] for a in excel_artists}
print(f'Excel 合并去重: {len(excel_artists)} 位艺人')

# ── 2. 更新本地 rappers.json ──────────────────────────────────────────────────

with open(RAPPERS_JSON, encoding='utf-8') as f:
    data = json.load(f)

before = len(data['rappers'])
data['rappers'] = [r for r in data['rappers'] if r.get('id') not in SEED_IDS]
removed = before - len(data['rappers'])
print(f'移除种子: {removed} 位，剩余 {len(data["rappers"])} 位')

existing_ids = {r['id'] for r in data['rappers']}
added_local = 0
for a in excel_artists:
    if a['id'] not in existing_ids:
        data['rappers'].append({'name': a['name'], 'id': a['id']})
        existing_ids.add(a['id'])
        added_local += 1

print(f'本地新增: {added_local} 位，合计 {len(data["rappers"])} 位')

with open(RAPPERS_JSON, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
print('rappers.json 已保存')

# ── 3. 云端更新 ────────────────────────────────────────────────────────────────

with open(CONFIG_JSON, encoding='utf-8') as f:
    cfg = json.load(f)
token = get_token(cfg)
env   = cfg['env']
print('\n云端更新...')

# Step A: upsert 所有 Excel 艺人为候选（已存在的自动跳过）
candidates = [{'name': a['name'], 'id': a['id'], 'foundFrom': 'excel_import', 'round': 0}
              for a in excel_artists]

# 分批 100 调用（云函数限制）
inserted_total = skipped_total = 0
for i in range(0, len(candidates), 100):
    batch = candidates[i:i+100]
    res = invoke_fn(token, env, 'manageCandidates', {'action': 'upsert_candidates', 'candidates': batch})
    inserted_total += res.get('inserted', 0)
    skipped_total  += res.get('skipped', 0)
    time.sleep(0.3)

print(f'  upsert_candidates: 新插入 {inserted_total}，已存在跳过 {skipped_total}')

# Step B: 把所有 pending 的改为 approved（刚才新插入的都是 pending）
res = db_update(token, env,
    'db.collection("artist_candidates").where({status:"pending"}).update({data:{status:"approved"}})')
print(f'  pending→approved: {res}')

# Step C: 把 Excel 里已 declined 的也改为 approved（分批 100 查询）
excel_id_list = list(excel_ids)
declined_docs = []
for i in range(0, len(excel_id_list), 100):
    chunk = excel_id_list[i:i+100]
    ids_str = ','.join(str(x) for x in chunk)
    q = f'db.collection("artist_candidates").where({{artistId:_.in([{ids_str}]),status:_.eq("declined")}}).limit(100).get()'
    res = db_query(token, env, q)
    declined_docs.extend(parse_records(res))
    time.sleep(0.1)

print(f'  Excel 艺人中已 declined 的: {len(declined_docs)} 位')

updated_declined = 0
for doc in declined_docs:
    doc_id = doc.get('_id')
    if not doc_id:
        continue
    q = f'db.collection("artist_candidates").doc("{doc_id}").update({{data:{{status:"approved"}}}})'
    res = db_update(token, env, q)
    if res.get('errcode', 0) == 0:
        updated_declined += 1
    time.sleep(0.05)

print(f'  declined→approved: {updated_declined} 位')
print('\n完成。')
