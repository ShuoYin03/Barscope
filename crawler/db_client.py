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

    def _invoke(self, **kwargs):
        """调用云函数，返回结果 dict（失败返回 None）。"""
        token = self._get_token()
        if not token:
            return None
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
                return None
            return json.loads(data.get("resp_data", "{}"))
        except Exception as e:
            print(f"  [DB] 请求异常: {e}")
            return None

    def _call(self, **kwargs) -> bool:
        result = self._invoke(**kwargs)
        return bool(result and result.get("success"))

    # ── Public API ────────────────────────────────────────────────────────────

    def claim_run(self):
        """
        尝试认领一个 pending 任务，改为 running。
        成功返回 {"mode": ..., "param": ...}，无 pending / 失败返回 None。
        """
        result = self._invoke(action="claimRun")
        if not result or not result.get("success"):
            return None
        return {
            "mode":  result.get("mode", "fission"),
            "param": result.get("param", ""),
        }

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

    def is_aborted(self) -> bool:
        """查询云端是否请求了中止（用户在小程序点了「中止」）。"""
        result = self._invoke(action="isAborted")
        return bool(result and result.get("abort"))

    def abort_run(self, new_albums: int = 0, new_candidates: int = 0) -> bool:
        """把当前运行标记为「已中止」。"""
        return self._call(action="abortRun", newAlbums=new_albums, newCandidates=new_candidates)
