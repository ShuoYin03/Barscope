# 代码库整改计划

> 生成于 2026-07-19，基于对全仓库（475 文件 / miniprogram · cloudfunctions · crawler · web · ios）的一次通读。
> 每项含：问题、影响、落地方式、状态。改完一项就把状态勾掉。

## 执行顺序建议

1. **第一批（纯删除，零风险）**：P2-2、P2-3、P2-4、P2-5、P2-6、P3-2、P3-4 —— 只删不改，能先砍掉几千行噪音
2. **第二批（改配置，收益立竿见影）**：P1-2、P1-3
3. **第三批（需决策）**：P1-1 爬虫架构 —— 先定"本地 pipeline 还留不留"
4. **第四批（大重构）**：P2-1 `_shared/`、P2-7 album-manager 拆分

---

# P1 — 会导致线上事故或数据错乱

## P1-1. 三个爬虫系统抢写同一个 `crawlerStatus/singleton`

- [x] 已废弃本地 pipeline 云端联动，`crawlerControl` 已删除

**问题**：`cloudCrawler`、`cloudCrawlerDailyTrigger`、`crawlerControl` 都在写同一份单例文档，只有新架构（`crawlerAutoControl` 状态机）有锁。`crawlerControl` 走老的"本地 pipeline 认领任务"路径（`crawler/db_client.py:62` 通过 HTTP 调 `claimRun`），`miniprogram/pages/crawler/index.ts:134` 还挂着手动 trigger 按钮。

**影响**：管理员手动触发本地爬虫时定时器同时在跑云端爬虫 → 两边互相把 `status` 改成 `done`/`running`，进度与日志交叉污染，`abort` 可能中止错误的那一个。

**决策**：废弃本地 pipeline 的云端联动。本地脚本就是本地脚本，跑完看终端输出，不再跟小程序/云端做状态同步。

**已完成**：
- 删除 `miniprogram/pages/crawler/index.ts` 里"裂变发现"/"同步决定"两个 `cloud:false` 入口及 `_triggerLocal`
- `crawler/pipeline.py` 去掉 `CrawlerDB` 依赖（认领任务/进度/日志/中止上报全部移除），`--mode` 直接由 CLI 指定，`--skip-db-check` 不再需要（已删）
- 删除 `crawler/db_client.py`
- `crawlerControl` 剩下的 `getStatus`/`abort`/`clearLog` 三个 action 并入 `cloudfunctions/cloudCrawler/index.js`（它本来就直接读写同一份 `crawlerStatus/singleton`），`miniprogram/pages/crawler/index.ts` 里对应的 3 处 `callFunction` 改名指向 `cloudCrawler`
- 删除 `cloudfunctions/crawlerControl/` 整个目录

现在 `crawlerStatus/singleton` 只有 `cloudCrawler` 一个云函数在读写，冲突问题彻底解决。

**遗留**：`TEST_REPORT.md` 里 2.7 节及 P1-7/P3-6 两条用例仍引用已删除的 `crawlerControl`，是历史测试报告，未随本次改动更新。

---

## P1-2. 48/57 个云函数没有 `config.json`，默认 3 秒超时

- [x] 已完成 —— 56 个云函数全部配了 `config.json`

**问题**：只有 9 个云函数配了 timeout（cleanupDuplicates、cloudCrawler、cloudCrawlerDailyTrigger、getAlbums、getArtistCollaborators、getArtists、getOnThisDay、manageAlbumOwnershipCorrections、manageNewcomerVote）。

**影响**：超时后前端只显示"网络错误"，写到一半的批处理不回滚。

**处理**：逐个读代码判断实际复杂度，分三档：

| timeout | 依据 | 函数 |
|---|---|---|
| 60s（硬顶） | 明确的批处理/全量操作 | `getRecentHotAlbums`、`manageCandidates`、~~`rescreenAlbums`~~（后已删除，见下）、`backfillReleaseDates`、`updateAlbumTracks`、`exportApprovedRappers` |
| 30s | 对 reviews/候选做多页聚合，或 admin 批量操作 | `getReviews`、`manageArtistBrands`、`getUserProfile`、`getAnnualReviewerLeaderboard`、`manageAlbumCandidates`、`submitReview`、`deleteReview` |
| 20s | 有界单次查询/写入，无全量扫描 | 其余 34 个 |

**遗留（不是本次改动范围）**：`getRecentHotAlbums`（`index.js:20` 全量拉取近 30 天所有 reviews 再内存聚合）和 `manageCandidates`（800 行，含 `backfill_album_letters`/`rebuild_multi_artist_index`/`apply_release_type_rules` 等批处理 action）光加 timeout 只是缓解，60s 硬顶下数据量继续增长还是会超时，根治需要改增量统计/落聚合表（前者）、分片续跑（后者）——这两个是更大的改动，留到后续单独处理。

---

## P1-3. `wx-server-sdk: "latest"` — 34 个云函数依赖未锁版本

- [x] 已完成 —— 56 个云函数全部锁定 `~2.6.3`

**问题**：22 个锁了 `~2.6.3`，34 个写的 `latest`。云函数在部署时安装依赖，同一份代码不同时间部署跑的是不同 SDK。

**影响**：上游一个 breaking change 让一半函数挂掉，且无法复现。

**处理**：脚本批量把 34 个 `"latest"` 替换成 `"~2.6.3"`（与已锁定的 22 个保持一致，它们本来就是同一个版本号，无需再协调分歧）。逐个 `JSON.parse` 校验过格式，`grep` 确认仓库里不再有任何 `wx-server-sdk` 写 `"latest"` 的地方。

---

## P1-4. `/api/cloud-function` 代理带 admin 凭据，需核实下游函数的匿名分支

- [ ] 待核实

**问题**：`web/app/api/cloud-function/route.ts:8` 的白名单思路正确，但白名单内的函数（`getReviews`、`getArtist` 等 8 个）在小程序侧靠 `cloud.getWXContext().OPENID` 判权限；从 Node SDK 调进去 `OPENID` 为空。

**待核实**：这 8 个函数在 `OPENID` 为空时是否确实只返回公开数据，而不是走了"没有 openId 就当匿名放行"的分支。**本次 review 未逐个验证，上线前必须自行核对。**

**白名单**：`getAlbums`、`getLatestAlbums`、`getReviews`、`getCharts`、`getCatalogStats`、`getArtists`、`getArtist`、`getOnThisDay`

---

## P1-5. `catch (e) {}` 吞掉写库失败

- [ ] 待实施

**问题**：`cloudfunctions/cloudCrawler/index.js:180` 的 `upsertAlbums` 把"抓详情 + 判定 + 写 albums"整段包在 `try { ... } catch (e) {}` 里。

**影响**：任何一张专辑写失败都静默跳过，`inserted` 计数不变，日志无痕迹 —— 爬虫每天漏数据不会被发现。

**处理**：至少 `errors.push(e.message)` 汇总进 `lastRunSummary`。

**同类位置**：
- `cloudfunctions/backfillReleaseDates/index.js:29`
- `cloudfunctions/getAnnualReviewerLeaderboard/index.js:90`
- `miniprogram/pages/artist-brands/index.ts:51`

---

# P2 — 明确的重复设计 / 该删的冗余

## P2-1. `isAdmin` 被复制了 16 份

- [ ] 待实施

**问题**：16 个云函数各自定义 `async function isAdmin(openId)`，函数体一致（`users.where({openId, type:'admin'})`）。同类：`ensureCollection` 14 份、`isCollectionMissing` 14 份。

**影响**：改一次鉴权逻辑要改 16 处，漏一个就是权限漏洞。

**处理**：微信云函数无跨函数共享模块，标准做法是建 `cloudfunctions/_shared/` + 部署脚本复制进各函数目录。`cloudfunctions/syncAlbumTracks/ownership.js` 已经是"函数内独立模块"的写法，照此扩展。

一并收进 `_shared/` 的还有 P3-3 的日期工具。

---

## P2-2. `artistBrandMap` 三份副本，其中一份是死代码

- [ ] 待实施

**问题**：
- `cloudfunctions/getArtist/artistBrandMap.js` 与 `cloudfunctions/getArtists/artistBrandMap.js` **字节完全相同**（md5 一致，170+ artistId 硬编码映射）
- `miniprogram/data/artistBrandMap.ts` 是第三份，**miniprogram 内零引用** → 直接删

**更根本的问题**：已有 `manageArtistBrands` 云函数 + `artist_brand_suggestions` 集合做 DB 驱动的厂牌管理，`getArtists/index.js:65` 的逻辑是"DB 里有就用 DB，没有才 fallback 到硬编码 map"。两套真相并存，硬编码那份无人维护。

**处理**：
1. 删 `miniprogram/data/artistBrandMap.ts`
2. 一次性把 map 灌进 DB
3. 删掉两个 `artistBrandMap.js` 和 `getArtists/index.js` 里的 fallback 分支
4. `getArtists/index.js:68` 的 `HIGHER_BROTHERS_IDS` 硬编码特判一起进 DB

---

## P2-3. `utils/api.ts` 是被抛弃的抽象层

- [ ] 待决策 → 待实施

**问题**：`miniprogram/utils/api.ts` 写了一层 `cloudCall` + 类型化 `api.getAlbums/getCharts/...`，**全项目零引用**。同时代码里散着 **151 处裸的 `wx.cloud.callFunction`**，每处手写 `success`/`fail` 回调 + `wx.showToast({title:'网络错误'})`（该字符串出现 40 次）。

**现状是最差的**：既有抽象层的维护成本，又没有抽象层的收益。

**两个选项**（倾向后者）：
- 删掉 `api.ts`
- **补全并强制走它** —— 统一的 `cloudCall` 能顺手解决：重复 toast、统一超时处理、以及 P1-2 的超时失败可观测性

---

## P2-4. `utils/theme.js` 是 `theme.ts` 的手工副本

- [ ] 待实施

`theme.js`（CommonJS）与 `theme.ts`（ESM）内容一致。48 处 `getThemeClass()` 全部 import `theme`（走 .ts），`theme.js` 零引用。

**处理**：删 `miniprogram/utils/theme.js`。

---

## P2-5. 三个未注册页面 + 一个未使用组件

- [ ] 待实施

不在 `miniprogram/app.json` 的 pages 数组里，永远进不去：

- `miniprogram/pages/index/` —— 脚手架模板残留
- `miniprogram/pages/logs/` —— 脚手架模板残留（`logs.ts` 还留着 `// const util = require(...)` 注释）
- `miniprogram/pages/release-date-backfill/`
- `miniprogram/utils/util.ts` —— 只被 `logs.ts` 引用，一起删
- `miniprogram/components/article-blocks/` —— 零引用，4 个文件

---

## P2-6. `ios/Barscope/` 是被 Soundive 取代的旧原型

- [x] 已实施

**问题**：`ios/Barscope/` 有 4 个 Swift 文件但**无 xcodeproj**，`ios/README.md` 还在教人"手动在 Xcode 新建项目再把文件拖进去"。而 `ios/Soundive/` 有完整 xcodeproj 和平行功能结构（HomeView 两边都有）。README 描述的是已废弃的那个。

**处理**：
1. 删 `ios/Barscope/`
2. 重写 `ios/README.md` 指向 Soundive
3. `.gitignore` 加 `**/xcuserdata/` —— 现有 `*.xcuserstate` 规则没排除目录本身，`xcschememanagement.plist` 和 `UserInterfaceState.xcuserstate` 都已被 tracked，需 `git rm --cached`

---

## P2-7. `album-manager/index.ts` 944 行，五份复制粘贴的列表视图

- [ ] 待实施

**问题**：`all` / `multi` / `uncategorized` / `title` / `artists` 五个视图，各有一整套 `xxxList / xxxLoading / xxxPage / xxxPageSize / xxxTotal / xxxHasMore / xxxSelectMode / xxxSelectedCount` 状态字段与 `_loadXxx` / `onXxxReachBottom` / `onXxxCardTap` / `onXxxSelectAll` 处理函数。

**已经开始互相委托**（复制粘贴到无法维护的典型症状）：
- `index.ts:293` — `onUncategorizedBatchOwnership() { this.onAllBatchOwnership() }`
- `index.ts:941` — `onMultiBatchSetType() { this._batchSetReleaseType() }`

**处理**：抽 `createListSection(name, fetcher)` 工厂，五视图共用一份分页/多选逻辑。预计砍掉 400+ 行。

**连带**：`cloudfunctions/manageCandidates/index.js` 800 行 / 24 个 action，按领域拆成 2-3 个函数（候选审核 / 专辑批处理 / 索引重建）。

---

## P2-8. `rescreenAlbums` 是 `cloudCrawler` 插入时逻辑的逐字节重复，且触发页面没有入口

- [x] 已删除

**问题**：`rescreenAlbums/index.js` 的 `inspectTracks`/`normalizeName` 和 `cloudCrawler` 插入新专辑时用的 `inspectAlbumTracks`/`normalizeTrackName` 是完全相同的判定逻辑（同样的正则、同样的阈值、同样的文案），但 `cloudCrawler` 插入专辑时不会写 `qualityRuleV2At` 标记，导致每次重新筛选都会把新爬进来、其实已经检查过的专辑重新拉一遍网易云详情重新判一次。触发它的小程序页面 `pages/album-quality-screen/index` 虽然注册在 `app.json` 里，但全仓库没有任何地方 `navigateTo` 到它——是个有路径但没入口的死页面。

**处理**：删除 `cloudfunctions/rescreenAlbums/`、`miniprogram/pages/album-quality-screen/`，从 `app.json` 的 pages 移除注册，`qualityRuleV2At`/`qualityScreenStatus`/`qualityScreenRetries` 这几个标记字段不再被任何代码写入或读取（已有专辑文档上残留的字段不影响，属于无害死字段，不必单独清理）。

`crawler/rescreen_albums_local.py`（`rescreenAlbums` 云函数被网易云限流时用的本地替代版，逻辑和标记字段跟云函数版完全一致）一并删除。三处标记字段现在全仓库零引用。

---

# P3 — 值得收拾但不紧急

## P3-1. `CLAUDE.md` 被 `.gitignore` 排除

- [ ] 待实施

项目约定（如"必须先验证外部 API 字段"）没进版本库，换机器或多人协作即丢失。建议从 `.gitignore` 移除并 tracked。

---

## P3-2. `crawler/rappers.json` 1.6MB 数据文件在 git 里

- [ ] 待实施

`albums_raw.json`（2.3MB）已 ignore，`rappers.json` 没有。它是爬虫可变状态（pipeline 每次运行都改），每次跑完产生巨大 diff。

**处理**：同样 ignore，或把状态挪到云端集合。
一并清理：`crawler/_lost_titles.json`、`crawler/_still_there_titles.json`（一次性调试产物）。

---

## P3-3. 时区/日期工具三处重复

- [ ] 待实施

`bjTodayISO()`（东八区偏移 `8*60*60*1000`）在 `getLatestAlbums`、`getOnThisDay`、`getReviews` 各写一遍；`normalizeDay` 在 `getLatestAlbums` 里。

**处理**：随 P2-1 一起收进 `cloudfunctions/_shared/`。

---

## P3-4. `crawler/` 下 10 个一次性脚本混在主流程里

- [ ] 待实施

`fix_cloud_trackcount.py`、`clear_pending.py`、`migrate_covers.py`、`migrate_singles.py`、`backfill_artist_ids.py`、`backfill_owner_artist_ids.py`、`check_banzou.py`、`add_excel_rappers.py`、`capture_artist_api.py`、`inspect_artist.py`

这些历史迁移/排查脚本与 `pipeline.py`、`spider_netease.py`、`upload.py` 等常驻组件平铺，看不出哪些还能跑、哪些依赖的字段早已变更。

**处理**：挪到 `crawler/oneoff/`，内附 README 标注每个脚本的适用日期与状态。

---

## P3-5. `web/` 三个组件是 client component，导致请求瀑布

- [ ] 待实施

`web/components/album-grid.tsx`、`latest-reviews.tsx`、`recent-releases.tsx` 都是 `'use client'` + 客户端 `callFunction` 打自家 `/api/cloud-function`。

`callFunctionServer` 已存在但只有 `route.ts` 一个调用方 —— 服务端能力没用起来。

**处理**：改成 server component 直接调 `callFunctionServer`，省掉一整轮 RTT 和首屏 loading 态。

---

## P3-6. `package.json` 还是脚手架名字 + 测试覆盖几乎为零

- [ ] 待实施

- 根 `package.json` 的 `name` 是 `miniprogram-ts-sass-quickstart`，`description`/`author`/`license` 全空
- `test` script 只覆盖 `cloudfunctions/**/*.test.js`
- 全项目仅 2 个测试文件：`submitReview/moderation.test.js`、`syncAlbumTracks/ownership.test.js`
- miniprogram 与 web 零测试
