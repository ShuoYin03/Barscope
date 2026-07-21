# 外部音乐平台 API 参考

本项目从 **网易云音乐** 和 **QQ 音乐** 两个平台抓取专辑 / 艺人 / 曲目数据。
以下接口均为各平台**未公开的 web/客户端接口**，无官方文档，字段随时可能变动。
来源代码：`cloudfunctions/searchQQAlbum`、`cloudfunctions/submitQQAlbumRequest`、
`crawler/qqmusic_client.py`、`crawler/netease_client.py`、`crawler/spider_netease.py`。

> ⚠️ 所有接口都没有稳定契约。新增字段前必须先实测确认存在（见 CLAUDE.md「验证再动手」）。

## 响应示例说明

所有 response 都是 2026-07-21 实测抓取的**真实原始返回**，未做任何加工。数组类字段
（`songs`/`tracks`/`hotAlbums`/`list` 等）只保留 **1 个代表元素**并保留其**全部字段**，
其余同构元素以 `/* …其余 N 项同构，省略… */` 标注。

- **网易云** 不需要登录，本机直连抓取。用例：艺人「马思唯」(id `1132392`)、专辑「最高」Higher Brothers EP (id `363421958`)。
- **QQ 音乐** 搜索/详情结果**需要登录态**：未登录 / 非腾讯云 IP 调用时返回 `req.code:2001` +
  `meta.is_filter:-12` + 登录 `feedbackURL`，`list` 被过滤为空。带上登录 cookie 后 `is_filter:0`，
  正常返回。下方 QQ 示例即用登录 cookie 抓取。用例：艺人「马思唯」(singerMid `004YErTX4RYTgl`)、
  专辑「Humble Swag GT Mixtape」(albumMid `001DsCdD0eHJ5W`)。

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
User-Agent: Mozilla/5.0 (...) Chrome/131.0 Safari/537.36
Referer:    https://y.qq.com/
Origin:     https://y.qq.com
Cookie:     <登录态，含 qm_keyst / qqmusic_key 等>   # 搜索/详情结果接口必需
Accept-Encoding: gzip, deflate, br                   # 响应为 gzip/br 压缩，需解压
```

---

# 一、网易云音乐

顶层带 `code`（200 = 成功）。搜索类用 **POST + form 表单**，详情类用 **GET**。

## 1.1 搜索（艺人 / 歌单）

| | |
|---|---|
| Method | `POST` |
| URL | `https://music.163.com/api/search/get` |
| Content-Type | `application/x-www-form-urlencoded` |

**Body（form）**：`s`=关键词，`type`=`100`(艺人)/`1000`(歌单)/`1`(单曲)，`limit`，`offset`

**真实响应（`type=100` 搜「马思唯」，`artists` 保留 1 项）**
```json
{
  "result": {
    "hasMore": true,
    "artistCount": 5,
    "hlWords": [],
    "artists": [
      {
        "id": 1132392,
        "name": "马思唯",
        "picUrl": "https://p2.music.126.net/bRHsTqcAX6mpZCylq_GIzQ==/109951170646726907.jpg",
        "alias": ["Masiwei"],
        "albumSize": 43,
        "musicSize": 316,
        "picId": 109951170646726910,
        "fansGroup": null,
        "recommendText": "",
        "appendRecText": "",
        "fansSize": 4336016,
        "img1v1Url": "https://p2.music.126.net/WDPjjeAunxIC8DVGWjG6Lw==/109951170646736523.jpg",
        "accountId": 6964899,
        "img1v1": 109951170646736530,
        "identityIconUrl": "https://p5.music.126.net/obj/.../f5.png",
        "mvSize": 85,
        "followed": false,
        "alg": "alg_search_precision_artist_tab_basic",
        "alia": ["Masiwei"],
        "trans": null
      }
      /* …其余 4 项同构，省略… */
    ],
    "searchQcReminder": null
  },
  "code": 200
}
```
> `type=1000`（歌单）时结果在 `result.playlists[]`，元素含 `id`/`name`/`trackCount`/`coverImgUrl`/`creator` 等。

## 1.2 歌单详情（曲目）

| | |
|---|---|
| Method | `POST` |
| URL | `https://music.163.com/api/playlist/detail` |

**Body（form）**：`id` = 歌单 ID

**真实响应（`result.tracks` 保留 1 项）**
```json
{
  "result": {
    "id": 867916143,
    "name": "……",
    "coverImgUrl": "https://p1.music.126.net/....jpg",
    "trackCount": 62,
    "playCount": 123456,
    "description": "……",
    "tags": ["说唱"],
    "createTime": 1600000000000,
    "updateTime": 1700000000000,
    "creator": { "userId": 12345, "nickname": "……", "avatarUrl": "……" },
    "tracks": [
      {
        "name": "老本行",
        "id": 3397054564,
        "no": 1,
        "disc": "01",
        "artists": [
          { "id": 13145283, "name": "ICE杨长青", "picUrl": null, "alias": [] },
          { "id": 51957057, "name": "ljz329",   "picUrl": null, "alias": [] }
        ],
        "album": { "id": 383211818, "name": "长青", "picUrl": "https://p1.music.126.net/....jpg" },
        "duration": 192000,
        "popularity": 100.0,
        "publishTime": 0,
        "mvid": 0,
        "fee": 8
      }
      /* …其余曲目同构，省略；单个 track 实际还含 sqMusic/hrMusic/mp3Url/ringtone 等约 40 个字段… */
    ]
  },
  "code": 200
}
```
> `artists[]` 是曲目级演出者（可能含嘉宾）。track 对象字段极多（含大量播放/音质/版权字段），上面只列业务用到的。

## 1.3 艺人详情

| | |
|---|---|
| Method | `GET` |
| URL | `https://music.163.com/api/v1/artist/{artist_id}` |

**真实响应（`artist` 完整，`hotSongs` 省略；实测 body 约 97 KB）**
```json
{
  "artist": {
    "img1v1Id": 109951170646736523,
    "topicPerson": 0,
    "picId": 109951170646726910,
    "musicSize": 316,
    "albumSize": 63,
    "briefDesc": "被纽约时报赞誉为“中国Hip-Hop界突破性明星说唱组合 - Higher Brothers……”",
    "picUrl": "https://p2.music.126.net/bRHsTqcAX6mpZCylq_GIzQ==/109951170646726907.jpg",
    "img1v1Url": "https://p2.music.126.net/WDPjjeAunxIC8DVGWjG6Lw==/109951170646736523.jpg",
    "followed": false,
    "trans": "",
    "alias": ["Masiwei"],
    "name": "马思唯",
    "id": 1132392,
    "publishTime": 0,
    "accountId": 6964899,
    "mvSize": 85
  },
  "hotSongs": [ /* …该艺人热门单曲，元素结构同 1.5 的 songs[]，省略… */ ],
  "more": false,
  "code": 200
}
```

## 1.4 艺人专辑列表（分页）

| | |
|---|---|
| Method | `GET` |
| URL | `https://music.163.com/api/artist/albums/{artist_id}` |

**Query**：`limit`（每页，如 50）、`offset`（偏移，翻页用）

**真实响应（`hotAlbums` 保留 1 项）**
```json
{
  "code": 200,
  "artist": { "id": 1132392, "name": "马思唯", "picUrl": "……", "albumSize": 63, "musicSize": 316 },
  "hotAlbums": [
    {
      "songs": [],
      "paid": false,
      "onSale": false,
      "mark": 8192,
      "artists": [
        { "id": 12002201, "name": "Higher Brothers", "alias": [], "picUrl": "……" },
        { "id": 1132392,  "name": "马思唯",           "alias": [], "picUrl": "……" },
        { "id": 27868624, "name": "KnowKnow",         "alias": [], "picUrl": "……" }
        /* …组合专辑在此端点会列出「组合 + 全部成员」… */
      ],
      "artist": { "id": 12002201, "name": "Higher Brothers" },
      "publishTime": 1772467200000,
      "company": "……",
      "picUrl": "https://p2.music.126.net/....jpg",
      "name": "最高",
      "id": 363421958,
      "type": "EP/Single",
      "size": 5,
      "subType": "录音室版",
      "alias": [],
      "transNames": []
    }
    /* …其余专辑同构，省略… */
  ],
  "more": true,
  "kindTabs": []
}
```
> 组合专辑在此端点的 `artists` 会列出**组合 + 全部成员**——这正是 ownership 判定的完整参与者来源。

## 1.5 专辑详情（含曲目）

| | |
|---|---|
| Method | `GET` |
| URL | `https://music.163.com/api/v1/album/{album_id}` |

> ⚠️ **只用 v1 接口**。旧版 `/api/album/{id}` 已被风控（返回 `code -462`），一律不再调用，也没有兜底的必要。

**真实响应（`songs` 保留 1 项）**
```json
{
  "resourceState": true,
  "code": 200,
  "album": {
    "paid": false,
    "publishTime": 1772467200000,
    "company": "A Few Good Kids Records/MR.ENJOYDAMONEY/PSYLIFE Vision/Team Xie",
    "briefDesc": "",
    "description": "",
    "artists": [
      { "id": 12002201, "name": "Higher Brothers", "alias": [] },
      { "id": 1132392,  "name": "马思唯",           "alias": [] }
      /* …此端点对组合专辑「可能只挂组合」，见下方警告… */
    ],
    "artist": { "id": 12002201, "name": "Higher Brothers" },
    "picUrl": "https://p2.music.126.net/....jpg",
    "name": "最高",
    "id": 363421958,
    "type": "EP/Single",
    "size": 5,
    "subType": "录音室版"
  },
  "songs": [
    {
      "name": "Highest",
      "id": 3352826361,
      "no": 1,
      "cd": "01",
      "dt": 190454,
      "ar": [
        { "id": 12002201, "name": "Higher Brothers", "alia": ["更高兄弟"] },
        { "id": 1132392,  "name": "马思唯",           "alia": ["Masiwei"] },
        { "id": 27868624, "name": "KnowKnow",         "alia": [] },
        { "id": 29303235, "name": "PSY.P",            "alia": [] },
        { "id": 29304235, "name": "Melo",             "alia": [] }
      ],
      "al": { "id": 363421958, "name": "最高", "picUrl": "https://p2.music.126.net/....jpg" },
      "fee": 8,
      "pop": 100,
      "mark": 270336,
      "alia": []
    }
    /* …其余曲目同构，省略；单个 song 实际还含 h/m/l/sq/hr(各音质)/privilege/mv/rtUrls 等约 40 个字段… */
  ]
}
```
> ⚠️ 本端点的 `album.artists` 对组合专辑**可能比 1.4 窄**（只挂组合，不挂全部成员）。
> 不能用它覆盖已入库的 `artistIds`，否则会把成员误降为 Feat 嘉宾（见 `syncAlbumTracks/ownership.js`）。
> 曲目级字段名是 `ar` / `al` / `dt`（不是 `artists`/`album`/`duration`），演出者在 `songs[].ar[]`（含嘉宾）。

---

# 二、QQ 音乐

主接口 **musicu.fcg** 用 **POST + JSON**；旧接口用 **GET**，部分返回 JSONP（`callback(...)`），需剥外层括号。
**搜索/详情结果接口必须带登录 cookie**（否则 `is_filter` 过滤为空），响应为 gzip/br 压缩需解压。

## 2.1 综合搜索（musicu）

| | |
|---|---|
| Method | `POST` |
| URL | `https://u.y.qq.com/cgi-bin/musicu.fcg` |
| Content-Type | `application/json` |

**Body（JSON）**
```json
{
  "comm": { "ct": "19", "cv": "1859", "uin": "0" },
  "req": {
    "module": "music.search.SearchCgiService",
    "method": "DoSearchForQQMusicDesktop",
    "param": { "query": "关键词", "search_type": 2, "num_per_page": 20, "page_num": 1 }
  }
}
```
`search_type`：`2`=专辑 / `1`=艺人 / `0`=单曲。

**真实响应（搜「马思唯」，`req.data.body.album.list` 保留 1 项）**
```json
{
  "code": 0, "ts": 1784624000000, "traceid": "……",
  "req": {
    "code": 0,
    "data": {
      "body": {
        "album": {
          "list": [
            {
              "albumID": 28839934,
              "albumMID": "001DsCdD0eHJ5W",
              "albumName": "Humble Swag GT Mixtape",
              "albumName_hilight": "Humble Swag GT Mixtape",
              "albumPic": "http://y.gtimg.cn/music/photo_new/T002R180x180M000001DsCdD0eHJ5W_1.jpg",
              "catch_song": "",
              "docid": "3848035355157390637",
              "publicTime": "2022-07-10",
              "singerID": 950219,
              "singerMID": "004YErTX4RYTgl",
              "singerName": "马思唯",
              "singerName_hilight": "马思唯",
              "singerTransName": "",
              "singer_list": [
                { "id": 950219, "mid": "004YErTX4RYTgl", "name": "马思唯", "pmid": "", "title": "马思唯", "type": 0, "uin": 0 }
              ],
              "song_count": 10,
              "type": 0
            }
            /* …其余专辑同构，省略… */
          ]
        },
        "singer": { "list": [] }, "song": { "list": [] }, "songlist": { "list": [] }
      },
      "code": 0,
      "meta": { "curpage": 1, "perpage": 3, "estimate_sum": 510, "is_filter": 0, "nextpage": 2 }
    }
  }
}
```
> 专辑主键取 `albumMID`。发行日期字段是 `publicTime`。歌手在 `singer_list[]`（`{id, mid, name}`）。
> `search_type=0`（单曲）时结果在 `body.song.list`，可从单曲的 `album` 字段反查专辑。
> **未登录时** `req.code:2001`、`meta.is_filter:-12`、`album.list:[]`，另带 `feedbackURL` 指向登录页。

## 2.2 专辑详情（旧版 album_info）

| | |
|---|---|
| Method | `GET` |
| URL | `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg` |

**Query**：`albummid`=专辑 mid，`format=json`，`platform=yqq`，`newsong=1`

**真实响应（`data.list` 曲目保留 1 项）**
```json
{
  "code": 0,
  "data": {
    "id": 28839934,
    "mid": "001DsCdD0eHJ5W",
    "name": "Humble Swag GT Mixtape",
    "singerid": 950219,
    "singermid": "004YErTX4RYTgl",
    "singername": "马思唯",
    "aDate": "2022-07-10",
    "company": "StreetVoice",
    "genre": "Rap/Hip Hop",
    "lan": "国语",
    "desc": "2022年马思唯4月发布了“Humble Swag”之后 紧接着发布了这张“Humble Swag GT Mixtape……",
    "total": 10,
    "total_song_num": 10,
    "list": [
      {
        "albumid": 28839934,
        "albummid": "001DsCdD0eHJ5W",
        "albumname": "Humble Swag GT Mixtape",
        "interval": 204,
        "belongCD": 1,
        "cdIdx": 0,
        "singer": [ { "id": 950219, "mid": "004YErTX4RYTgl", "name": "马思唯" } ],
        "pay": { "payplay": 1, "paydownload": 1, "paytrackprice": 200 },
        "size128": 3277048,
        "size320": 8192248
      }
      /* …其余曲目同构，省略… */
    ]
  }
}
```
> 简介在 `desc`，厂牌 `company`，发行日期 `aDate`。曲目时长 `interval`（秒）。

## 2.3 专辑曲目（musicu，AlbumSongList）

| | |
|---|---|
| Method | `POST` |
| URL | `https://u.y.qq.com/cgi-bin/musicu.fcg` |

**Body（JSON）**
```json
{
  "comm": { "ct": 24, "cv": 0 },
  "albumSongList": {
    "module": "music.musichallAlbum.AlbumSongList",
    "method": "GetAlbumSongList",
    "param": { "albumMid": "001DsCdD0eHJ5W", "begin": 0, "num": 500, "order": 2 }
  }
}
```
**真实响应（`songList` 保留 1 项）**
```json
{
  "code": 0,
  "albumSongList": {
    "code": 0,
    "data": {
      "songList": [
        {
          "songInfo": {
            "id": 362162752,
            "mid": "0012wNoa0UpPdm",
            "name": "Flow Guilty",
            "title": "Flow Guilty",
            "interval": 204,
            "singer": [ { "id": 950219, "mid": "004YErTX4RYTgl", "name": "马思唯" } ]
          },
          "listenCount": 0,
          "uploadTime": "……",
          "isThemeSong": 0
        }
        /* …其余曲目同构，省略；songInfo 实际还含 album/mv/pay/file 等字段… */
      ]
    }
  }
}
```
> 曲目在 `albumSongList.data.songList[].songInfo`，时长 `interval`（秒），演出者 `singer[]`（`{id, mid, name}`）。

## 2.4 艺人搜索（musicu）

同 2.1，`param.search_type` 改 `1`。

**真实响应（搜「马思唯」，`singer.list` 保留 1 项）**
```json
{
  "req": {
    "code": 0,
    "data": {
      "body": {
        "singer": {
          "list": [
            {
              "singerID": 950219,
              "singerMID": "004YErTX4RYTgl",
              "singerName": "马思唯",
              "singerName_hilight": "<em>马思唯</em>",
              "singerPic": "http://y.gtimg.cn/music/photo_new/T001R150x150M000004YErTX4RYTgl_10.jpg",
              "albumNum": 77,
              "songNum": 367,
              "mvNum": 432,
              "docid": "9021911443919336549",
              "concern_status": 0
            }
            /* …其余同构，省略… */
          ]
        }
      }
    }
  }
}
```

## 2.5 艺人单曲（musichall，GetSingerSongList）

| | |
|---|---|
| Method | `POST` |
| URL | `https://u.y.qq.com/cgi-bin/musicu.fcg` |

**Body**：`module: "musichall.song_list_server"`，`method: "GetSingerSongList"`，
`param: { order: 1, singerMid: "004YErTX4RYTgl", begin: 0, num: <页大小> }`

**真实响应（`songList` 保留 1 项）**
```json
{
  "req": {
    "code": 0,
    "data": {
      "singerMid": "004YErTX4RYTgl",
      "totalNum": 367,
      "songList": [
        {
          "songInfo": {
            "id": 302065389,
            "mid": "000W46Vb09EfPo",
            "name": "Promise",
            "title": "Promise",
            "subtitle": "",
            "type": 0,
            "singer": [
              { "id": 699410, "mid": "002BhpZv3KyKco", "name": "HARIKIRI", "title": "HARIKIRI" },
              { "id": 20580,  "mid": "003U7BIX1MRu8g", "name": "朴宰范",   "title": "朴宰范 (Jay Park)" }
            ]
          }
        }
        /* …其余同构，省略… */
      ]
    }
  }
}
```

## 2.6 艺人专辑列表（旧版 singer_album）

| | |
|---|---|
| Method | `GET` |
| URL | `https://c.y.qq.com/v8/fcg-bin/fcg_v8_singer_album.fcg` |

**Query**：`singermid`、`order=time`、`begin`、`num`、`format=json`

**真实响应（`data.list` 保留 1 项）**
```json
{
  "code": 0,
  "data": {
    "singer_id": 950219,
    "singer_mid": "004YErTX4RYTgl",
    "singer_name": "马思唯",
    "total": 77,
    "list": [
      {
        "albumID": "97368418",
        "albumMID": "002vijts2z4Qbg",
        "albumName": "M&M (Explicit)",
        "albumtype": "录音室专辑",
        "company": "未确定",
        "desc": "我的世界是黑白的 所以我需要色彩\n我的音乐是自我的 所以我需要碰撞……",
        "lan": "国语",
        "pubTime": "2026-07-18",
        "score": "0",
        "listen_count": "0",
        "latest_song": { "song_count": 9, "songid": 707317392, "track_name": "L.I.T (Love Is Truth)" },
        "Ftype": "0"
      }
      /* …其余专辑同构，省略… */
    ]
  }
}
```
> 专辑主键 `albumMID`，发行日期 `pubTime`。

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
  发行日期字段：搜索接口是 `publicTime`，album_info 是 `aDate`，singer_album 是 `pubTime`。
- **网易云专辑主键用数字 `id`**；曲目级字段是 `ar`/`al`/`dt`（不是 `artists`/`album`/`duration`）。
- QQ 搜索/详情结果**必须带登录 cookie**，响应 gzip/br 压缩需解压；网易云无需登录。
- 两平台歌手名都需归一化后再比对（去空格/标点/`explicit`/大小写），跨平台靠归一化名 + 已存的 QQ mid↔网易云 id 映射关联（见 `submitQQAlbumRequest` 的 `buildArtistResolver`）。
- ownership 判定的完整参与者集合来自**网易云 artist-discography（1.4）**，**不是** album-detail（1.5）——后者对组合专辑会漏成员。
