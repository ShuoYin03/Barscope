#!/usr/bin/env python3
"""
删除云端 artist_candidates 集合中所有 status=pending 的记录
"""
import json
import sys
import requests

BASE = "https://api.weixin.qq.com"

def load_config():
    with open("config.json", "r", encoding="utf-8") as f:
        return json.load(f)

def get_token(appid, appsecret):
    resp = requests.get(
        f"{BASE}/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=10,
    )
    data = resp.json()
    if "access_token" not in data:
        raise RuntimeError(f"获取 token 失败: {data}")
    return data["access_token"]

def db_delete(token, env, query):
    resp = requests.post(
        f"{BASE}/tcb/databasedelete",
        params={"access_token": token},
        json={"env": env, "query": query},
        timeout=30,
    )
    return resp.json()

def main():
    cfg   = load_config()
    env   = cfg["env"]
    token = get_token(cfg["appid"], cfg["appsecret"])
    print(f"token 获取成功，env: {env}")

    total_deleted = 0
    batch = 0
    while True:
        batch += 1
        query = 'db.collection("artist_candidates").where({status:_.eq("pending")}).limit(100).remove()'
        result = db_delete(token, env, query)

        if result.get("errcode", 0) != 0:
            print(f"删除出错: {result}")
            sys.exit(1)

        deleted = result.get("deleted", 0)
        total_deleted += deleted
        print(f"  批次 {batch}: 删除 {deleted} 条，累计 {total_deleted} 条")

        if deleted == 0:
            break

    print(f"\n完成，共删除 {total_deleted} 条 pending 记录")

if __name__ == "__main__":
    main()
