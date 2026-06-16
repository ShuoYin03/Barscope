#!/usr/bin/env python3
"""
Barscope · 爬虫状态上报客户端

通过微信 HTTP API 调用 crawlerControl 云函数，
将爬虫运行状态、进度、日志写入 Cloud DB。
"""

import json
import os
import time

import requests

_BASE = "https://api.weixin.qq.com"


class CrawlerDB:
    """管理爬虫与 Cloud DB 之间的状态同步。"""

    def __init__(self, config: dict):
        self._appid     = config.get("appid", "")
        self._appsecret = config.get("appsecret", "")
        self._env       = config.get("env", "")
        self._token: str        = ""
        self._token_expires: float = 0.0

    # ── Token ─────────────────────────────────────────────────────────────────

    def _get_token(self) -> str:
        if self._token and time.time() < self._token_expires - 60:
            return self._token
        try:
            resp = requests.get(
                f"{_BASE}/cgi-bin/token",
                params={
                    "grant_type": "client_credential",
                    "appid":  self._appid,
                    "secret": self._appsecret,
                },
                timeout=10,
            )
            data = resp.json()
            if "access_token" not in data:
                raise RuntimeError(f"token error: {data}")
            self._token         = data["access_token"]
            self._token_expires = time.time() + data.get("expires_in", 7200)
        except Exception as e:
            print(f"  [DB] token 获取失败: {e}")
        return self._token

    # ── Cloud function call ───────────────────────────────────────────────────

    def _call(self, **kwargs) -> bool:
        token = self._get_token()
        if not token:
            return False
        try:
            resp = requests.post(
                f"{_BASE}/tcb/invokecloudfunction",
                params={"access_token": token, "env": self._env, "name": "crawlerControl"},
                json=kwargs,
                timeout=15,
            )
            data = resp.json()
            if data.get("errcode", 0) != 0:
                print(f"  [DB] 调用失败: {data}")
                return False
            result = json.loads(data.get("resp_data", "{}"))
            return result.get("success", False)
        except Exception as e:
            print(f"  [DB] 请求异常: {e}")
            return False

    # ── Public API ────────────────────────────────────────────────────────────

    def claim_run(self) -> bool:
        """尝试认领一个 pending 状态的任务，改为 running。返回是否成功认领。"""
        return self._call(action="claimRun")

    def update_progress(
        self,
        total_artists: int = 0,
        processed: int = 0,
        albums_found: int = 0,
        candidates_found: int = 0,
    ) -> bool:
        return self._call(
            action="updateProgress",
            totalArtists=total_artists,
            processedArtists=processed,
            albumsFound=albums_found,
            candidatesFound=candidates_found,
        )

    def append_log(self, line: str) -> bool:
        return self._call(action="appendLog", line=line)

    def complete_run(self, new_albums: int = 0, new_candidates: int = 0, errors: list = None) -> bool:
        return self._call(
            action="completeRun",
            newAlbums=new_albums,
            newCandidates=new_candidates,
            errors=errors or [],
        )

    def fail_run(self, error: str = "") -> bool:
        return self._call(action="failRun", error=error)
