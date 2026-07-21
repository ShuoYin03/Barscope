# 外部音乐平台 API 参考

本项目从 **网易云音乐** 和 **QQ 音乐** 两个平台抓取专辑 / 艺人 / 曲目数据。
以下接口均为各平台**未公开的 web/客户端接口**，无官方文档，字段随时可能变动。
来源代码：`cloudfunctions/searchQQAlbum`、`cloudfunctions/submitQQAlbumRequest`、
`crawler/qqmusic_client.py`、`crawler/netease_client.py`、`crawler/spider_netease.py`。

> ⚠️ 所有接口都没有稳定契约。新增字段前必须先实测确认存在（见 CLAUDE.md「验证再动手」）。

---

## 通用请求头

**网易云**
```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36
Referer:    https://music.163.com/
Accept:     application/json,text/plain,*/*
```

**QQ 音乐**
```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36
Referer:    https://y.qq.com/
Origin:     https://y.qq.com
```

---

# 一、网易云音乐

所有响应体顶层带 `code`（200 = 成功）。搜索类接口用 **POST + form 表单**，详情类用 **GET**。

## 1.1 搜索（艺人 / 歌单）

| | |
|---|---|
| Method | `POST` |
| URL | `https://music.163.com/api/search/get` |
| Content-Type | `application/x-www-form-urlencoded` |

**Body（form）**

| 参数 | 说明 | 例 |
|---|---|---|
| `s` | 关键词 | `马思唯` |
| `type` | 搜索类型：`100`=艺人 / `1000`=歌单 / `1`=单曲 | `100` |
| `limit` | 每页数量 | `10` |
| `offset` | 偏移 | `0` |

**Response**
```jsonc
{
  "code": 200,
  "result": {
    "artists":   [ { "id": 1132392, "name": "马思唯", "picUrl": "...", "albumSize": 12 } ],
    "playlists": [ { "id": 123, "name": "...", "trackCount": 30 } ]
  }
}
```

## 1.2 歌单详情（曲目）

| | |
|---|---|
| Method | `POST` |
| URL | `https://music.163.com/api/playlist/detail` |

**Body（form）**：`id` = 歌单 ID

**Response**：`result.tracks[]`，每项含 `id` / `name` / `ar`（艺人数组）/ `al`（专辑）。

## 1.3 艺人详情

| | |
|---|---|
| Method | `GET` |
| URL | `https://music.163.com/api/v1/artist/{artist_id}` |

**Response**
```jsonc
{
  "code": 200,
  "artist": { "id": 1132392, "name": "...", "picUrl": "...", "briefDesc": "...", "albumSize": 12 },
  "hotSongs": [ { "id": ..., "name": ..., "ar": [...] } ]   // 该艺人热门单曲
}
```

## 1.4 艺人专辑列表（分页）

| | |
|---|---|
| Method | `GET` |
| URL | `https://music.163.com/api/artist/albums/{artist_id}` |

**Query**

| 参数 | 说明 |
|---|---|
| `limit` | 每页数量（如 50） |
| `offset` | 偏移，翻页用 |

**Response**：`hotAlbums[]`，每项 `id` / `name` / `picUrl` / `publishTime`(ms 时间戳) / `artists[]` / `size`(曲目数)。
> 组合专辑在此端点会列出**组合 + 全部成员**，这正是 ownership 的完整参与者来源。

## 1.5 专辑详情（含曲目）

| | |
|---|---|
| Method | `GET` |
| URL（首选） | `https://music.163.com/api/v1/album/{album_id}` |
| URL（兜底） | `https://music.163.com/api/album/{album_id}` |

> ⚠️ 旧版 `/api/album/{id}` 已被风控（返回 `code -462`），必须优先用 **v1** 接口，仅在 v1 失败时兜底。

**Response**
```jsonc
{
  "code": 200,
  "album": {
    "id": ...,
    "name": "...",
    "description": "...",       // 简介（也可能在 briefDesc / copywriter）
    "company": "...",           // 厂牌
    "publishTime": 1609459200000,  // ms 时间戳 → releaseDate/releaseYear
    "size": 12,                 // 曲目数
    "artists": [ { "id": ..., "name": "..." } ],  // 专辑级艺人（可能比 discography 窄！）
    "songs":   [ { "id": ..., "name": "...", "ar": [...], "dt": 210000 } ]
  }
}
```
> ⚠️ 本端点的 `artists` 对组合专辑**只挂组合、不挂成员**，与 1.4 不一致。
> 不能用它覆盖已入库的 `artistIds`，否则会把成员误降为 Feat 嘉宾（见 `ownership.js`）。

---

# 二、QQ 音乐

主接口 **musicu.fcg** 用 **POST + JSON**（一个信封里可放多个 module 请求）；
旧接口用 **GET**，部分返回 JSONP（`callback(...)`），需剥掉外层括号再 `JSON.parse`。

## 2.1 综合搜索（musicu，首选）

| | |
|---|---|
| Method | `POST` |
| URL | `https://u.y.qq.com/cgi-bin/musicu.fcg` |
| Content-Type | `application/json` |

**Body（JSON）**
```jsonc
{
  "comm": { "ct": "19", "cv": "1859", "uin": "0" },
  "req": {
    "module": "music.search.SearchCgiService",
    "method": "DoSearchForQQMusicDesktop",
    "param": {
      "query": "关键词",
      "search_type": 2,        // 2=专辑, 1=艺人, 0=单曲
      "num_per_page": 20,
      "page_num": 1
    }
  }
}
```

**Response**（专辑）
```jsonc
{
  "req": { "data": { "body": { "album": { "list": [
    {
      "albumMID": "003hLetz4gRmoa",   // 专辑主键（下游一律用 mid）
      "albumID":  123456,
      "albumName": "...",
      "singerList": [ { "mid": "...", "name": "..." } ],
      "pub_time": "2021-01-01"
    }
  ] } } } }
}
```
> `search_type` 换 `1` 时结果在 `body.singer.list`，换 `0`（单曲）时在 `body.song.list`，
> 可从单曲的 `album` 字段反查专辑（submitQQAlbumRequest 的第三层兜底）。

## 2.2 综合搜索（旧版 client_search，兜底）

| | |
|---|---|
| Method | `GET` |
| URL | `https://c.y.qq.com/soso/fcgi-bin/client_search_cp` |

**Query**（关键几个，其余为固定值）

| 参数 | 值 | 说明 |
|---|---|---|
| `w` | 关键词 | |
| `t` | `8` | 8=专辑 |
| `p` | `1` | 页码 |
| `n` | `20` | 每页 |
| `new_json` | `1` | 返回结构化 JSON |
| `format` | `json` | |
| `cr` `catZhida` `aggr` `platform` … | 固定 | `ct=24, qqmusic_ver=1298, g_tk=5381, loginUin=0, hostUin=0, inCharset=utf8, outCharset=utf-8, notice=0, needNewCode=0, remoteplace=txt.yqq.album, searchid=<时间戳>` |

**Response**：`data.album.list[]`，字段同 2.1（`albumMID` / `albumName` / `singer`）。
> 结果里 `albumName` / 歌手名可能带 `<em>` 高亮标签，入库前需 `replace(/<[^>]+>/g,'')`。
> 响应可能是 JSONP，需先剥外层 `xxx( ... )`。

## 2.3 专辑详情（旧版 album_info）

| | |
|---|---|
| Method | `GET` |
| URL | `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg` |

**Query**：`albummid` = 专辑 mid，`format=json`，`platform=yqq`，`newsong=1`

**Response**：`data` 内含 `desc`(简介) / `company` / `aDate`/`ctime`(发行日期) / `list`(曲目)。
> 日期字段命名不固定，代码用正则从整个 payload 里捞 `(19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}`。

## 2.4 专辑曲目（musicu，AlbumSongList）

| | |
|---|---|
| Method | `POST` |
| URL | `https://u.y.qq.com/cgi-bin/musicu.fcg` |

**Body（JSON）**
```jsonc
{
  "comm": { "ct": 24, "cv": 0 },
  "albumSongList": {
    "module": "music.musichallAlbum.AlbumSongList",
    "method": "GetAlbumSongList",
    "param": { "albumMid": "003hLetz4gRmoa", "begin": 0, "num": 500, "order": 2 }
  }
}
```

**Response**：`albumSongList.data.songList[]`，每项 `songInfo`（或直接 `s`）含
`title`/`name` / `mid` / `interval`(秒) / `singer[]`（`{ mid, name }`）。

## 2.5 艺人搜索（musicu）

同 2.1，`param.search_type` 改 `1`，结果在 `req.data.body.singer.list[]`，
每项含 `singerMID` / `singerName` / `songNum` / `albumNum`。

## 2.6 艺人单曲（musich，GetSingerSongList）

| | |
|---|---|
| Method | `POST` |
| URL | `https://u.y.qq.com/cgi-bin/musicu.fcg` |

**Body**：`module: "musichall.song_list_server"`, `method: "GetSingerSongList"`,
`param: { order: 1, singerMid, begin: 0, num: <页大小> }`

## 2.7 艺人专辑列表（旧版 singer_album）

| | |
|---|---|
| Method | `GET` |
| URL | `https://c.y.qq.com/v8/fcg-bin/fcg_v8_singer_album.fcg` |

**Query**：`singermid`, `order=time`, `begin`, `num`, `format=json`

**Response**：`data.list[]`，每项 `albumMID` / `albumName` / `pubTime`。

---

## 图片 / 页面 URL 拼接（非 API，直接拼）

| 用途 | 模板 |
|---|---|
| QQ 专辑封面 | `https://y.qq.com/music/photo_new/T002R800x800M000{albumMid}.jpg` |
| QQ 专辑页 | `https://y.qq.com/n/ryqq_v2/albumDetail/{albumMid}` |
| 网易云图片 CDN | `https://p1.music.126.net/...` / `https://p2.music.126.net/...`（picUrl 直接给全 URL） |

---

## 关键约定小结

- **QQ 专辑主键统一用 `albumMid`**（字符串），不用数字 `albumID`。入库 `sourceKey` 为 `qq:{albumMid}`。
- **网易云专辑主键用数字 `id`**。
- 两平台歌手名都需归一化后再比对（去空格/标点/`explicit`/大小写），跨平台靠归一化名 + 已存的 QQ mid↔网易云 id 映射关联（见 `submitQQAlbumRequest` 的 `buildArtistResolver`）。
- ownership 判定的完整参与者集合来自**网易云 artist-discography（1.4）**，**不是** album-detail（1.5）—— 后者对组合专辑会漏成员。
