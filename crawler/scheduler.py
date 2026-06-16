#!/usr/bin/env python3
"""
Barscope · 爬虫定时调度器

读取 Cloud DB 中的 crawlerStatus.schedule 配置，
按设定的间隔（daily/weekly）自动写入 pending 触发请求，
pipeline.py 检测到 pending 后认领并执行。

用法：
  python scheduler.py           # 前台运行，每5分钟检查一次
  python scheduler.py --once    # 只检查一次（用于 Windows Task Scheduler）

Windows Task Scheduler 配置建议：
  触发器：每5分钟重复
  操作：  python E:\\...\\crawler\\scheduler.py --once
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta

import requests

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore
except AttributeError:
    pass

BASE_DIR    = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
_BASE       = "https://api.weixin.qq.com"

_token: str        = ""
_token_expires: float = 0.0


def get_token(appid: str, appsecret: str) -> str:
    global _token, _token_expires
    if _token and time.time() < _token_expires - 60:
        return _token
    resp = requests.get(
        f"{_BASE}/cgi-bin/token",
        params={"grant_type": "client_credential", "appid": appid, "secret": appsecret},
        timeout=10,
    )
    data = resp.json()
    _token         = data.get("access_token", "")
    _token_expires = time.time() + data.get("expires_in", 7200)
    return _token


def call_control(token: str, env: str, **kwargs) -> dict:
    resp = requests.post(
        f"{_BASE}/tcb/invokecloudfunction",
        params={"access_token": token, "env": env, "name": "crawlerControl"},
        json=kwargs,
        timeout=15,
    )
    data = resp.json()
    if data.get("errcode", 0) != 0:
        raise RuntimeError(f"API error: {data}")
    return json.loads(data.get("resp_data", "{}"))


def check_and_trigger(cfg: dict):
    appid     = cfg["appid"]
    appsecret = cfg["appsecret"]
    env       = cfg["env"]

    token = get_token(appid, appsecret)

    # Get current status
    res = call_control(token, env, action="getStatus")
    if not res.get("success"):
        print(f"[scheduler] getStatus failed: {res}")
        return

    status_doc = res.get("status", {})
    current    = status_doc.get("status", "idle")
    schedule   = status_doc.get("schedule", {})

    if not schedule.get("enabled"):
        print("[scheduler] 定时任务未启用")
        return

    # Already running or pending
    if current in ("running", "pending"):
        print(f"[scheduler] 爬虫正在运行（{current}），跳过")
        return

    interval   = schedule.get("interval", "weekly")
    completed  = status_doc.get("completedAt")
    next_run   = schedule.get("nextRun")

    now = datetime.utcnow()

    # Determine if it's time to run
    should_run = False
    if not completed:
        should_run = True  # Never run before
    elif next_run:
        try:
            next_dt = datetime.fromisoformat(next_run.replace("Z", "+00:00").replace("+00:00", ""))
            should_run = now >= next_dt
        except Exception:
            should_run = True
    else:
        # Compute next run from completedAt
        try:
            if isinstance(completed, str):
                done_dt = datetime.fromisoformat(completed.replace("Z", "").replace("+00:00", ""))
            else:
                done_dt = datetime.utcfromtimestamp(completed.get("$date", 0) / 1000)
            delta = timedelta(days=1 if interval == "daily" else 7)
            should_run = now >= done_dt + delta
        except Exception:
            should_run = True

    if should_run:
        print(f"[scheduler] 触发爬虫（间隔: {interval}）")
        call_control(token, env, action="trigger")
    else:
        print(f"[scheduler] 未到执行时间（interval={interval}）")


def main():
    parser = argparse.ArgumentParser(description="Barscope 定时调度器")
    parser.add_argument("--once",     action="store_true", help="只检查一次后退出")
    parser.add_argument("--interval", type=int, default=300, help="轮询间隔秒数（默认300）")
    args = parser.parse_args()

    if not os.path.exists(CONFIG_FILE):
        print("[scheduler] 找不到 config.json")
        return

    cfg = json.load(open(CONFIG_FILE, encoding="utf-8"))

    if args.once:
        check_and_trigger(cfg)
        return

    print(f"[scheduler] 启动，轮询间隔 {args.interval}s")
    while True:
        try:
            check_and_trigger(cfg)
        except Exception as e:
            print(f"[scheduler] 出错: {e}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
