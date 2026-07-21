# Beatween 测试报告

**生成日期：** 2026-06-17  
**项目版本：** master（初始提交后）  
**报告范围：** 云函数（15个）+ Python爬虫 + 小程序前端

---

## 一、总体覆盖率

| 模块 | 文件数 | 已有自动化测试 | 覆盖率 | 有无测试框架 |
|------|--------|---------------|--------|-------------|
| 云函数（JS） | 15 | 0 | **0%** | 无（无 jest/vitest 配置） |
| Python 爬虫 | 8 | 1（探索性脚本） | **~5%** | 无（无 pytest） |
| 小程序页面（TS） | 11 | 0 | **0%** | 无 |
| 小程序组件（TS） | 7 | 0 | **0%** | 无 |
| **合计** | **41** | **1** | **<2%** | — |

### 现有唯一测试文件：`crawler/test_spider.py`

**本质：** 这是一个**手动探索性脚本**，不是真正的测试。

| 检查项 | 状态 |
|--------|------|
| 使用 pytest / unittest 断言框架 | ✗ 无 |
| 有明确的 pass/fail 标准 | ✗ 只打印结果 |
| 可 CI 自动运行 | ✗ 依赖外网真实 API |
| 覆盖数据解析逻辑 | ✗ 只测 HTTP 连通性 |
| 覆盖边界条件 | ✗ 无 |

**结论：** 该脚本验证"网易云和 QQ 音乐 API 能否联通"，不属于代码逻辑测试。项目**实际测试覆盖率为 0%**。

---

## 二、云函数逐项分析

### 2.1 `submitReview` ⚠️ 发现 BUG

**正常流程覆盖：** 0%  
**边界条件覆盖：** 0%

#### 🐛 avgScore 重复计算 BUG（`submitReview/index.js` 第 51–58 行）

```js
// 第 34-48 行：先 add 了新评论
await db.collection('reviews').add({ data: { ..., rating } })

// 第 51-58 行：再查询 allReviews（此时已包含刚插入的那条）
const { data: allReviews } = await db.collection('reviews').where({ albumId }).get()
const sum   = allReviews.reduce((acc, r) => acc + (r.rating || 0), 0) + rating  // ← rating 被加了两次
const count = allReviews.length + 1                                               // ← 数量也多算了 1
const avgScore = Math.round(sum / count * 10) / 10
```

**场景复现：**  
已有评论 `[6, 8]`，新提交 `rating=10`。  
- 期望：`(6+8+10)/3 = 8.0`  
- 实际计算：`sum=(6+8+10)+10=34`，`count=3+1=4`，`avgScore=34/4=8.5` ← **偏高**

每次提交评论，avgScore 都会被向当前新评分方向拉偏。专辑评分越多，误差越大。

**修复方案：** 在 `add` 之前查 allReviews，或改为 `allReviews.reduce(...) / allReviews.length`（不再 +rating/+1）。

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | 正常提交（albumId/rating/content 齐全，用户已登录） | `{success: true}` |
| N2 | 第一条评论后 avgScore 计算 | avgScore = rating 的值 |
| N3 | 第二条评论后 avgScore 计算 | `(r1+r2)/2` 精度到小数点后 1 位 |
| N4 | Critic 用户提交 | `isPinned: true` |
| N5 | 普通用户提交 | `isPinned: false` |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | `rating = 0` | `{success: false, error: '评分范围 1-10'}` |
| E2 | `rating = 11` | `{success: false, error: '评分范围 1-10'}` |
| E3 | `rating = -1` | `{success: false, error: '评分范围 1-10'}` |
| E4 | `rating = null` | `{success: false, error: '参数不完整'}` |
| E5 | `content` 为空字符串 | `{success: false, error: '参数不完整'}` |
| E6 | `content` 全是空格（trim 后为空） | `{success: false}` 或拒绝 |
| E7 | 同一用户对同一专辑二次提交 | `{success: false, error: '你已经评论过...'}` |
| E8 | 用户不存在（OPENID 未注册） | `{success: false, error: '请先登录'}` |
| E9 | `albumId` 缺失 | `{success: false, error: '参数不完整'}` |
| E10 | avgScore 大量评论后精度保持 1 位小数 | 无浮点漂移 |

---

### 2.2 `getReviews` ⚠️ 发现问题

**正常流程覆盖：** 0%  
**边界条件覆盖：** 0%

#### `formatTimeAgo` 未来时间 bug（第 50–58 行）

```js
function formatTimeAgo(date) {
  var diff = Date.now() - new Date(date).getTime()  // 未来时间时 diff < 0
  var days = Math.floor(diff / 86400000)            // days = -1
  if (days === 0) return '今天'
  if (days === 1) return '昨天'                      // days=-1 不命中
  if (days < 7) return days + '天前'                // 返回 "-1天前" ← 错误
  ...
}
```

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | `albumId` 模式查询 | 返回该专辑评论，按 isPinned→likes→createdAt 排序 |
| N2 | `userId` 模式查询 | 返回该用户评论，按 createdAt 排序 |
| N3 | `recent` 模式 | 返回全局最新评论 |
| N4 | Critic 评论排在普通评论前 | isPinned 排序有效 |
| N5 | score 格式 | 返回 `"8/10"` 而非 `8` |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | 三个参数都缺 | `{success: false, error: 'albumId or userId or recent required'}` |
| E2 | `formatTimeAgo(null)` | 返回 `''` |
| E3 | `formatTimeAgo` 未来时间 | 返回 `'今天'` 或合理值，不返回 `'-1天前'` |
| E4 | `page=0` | skip 为负，不崩溃 |
| E5 | 空专辑（无评论） | 返回空数组，不报错 |

---

### 2.3 `getAlbums`

**正常流程覆盖：** 0%  

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | 按 `id` 查单张专辑 | 返回正确的 album 文档 |
| N2 | `keyword` 搜索 title | 返回命中结果（title 匹配） |
| N3 | `keyword` 搜索 artist | 返回命中结果（artist 匹配） |
| N4 | `keyword` + `genre` 联合过滤 | 只返回同时满足的结果 |
| N5 | 分页列表（page=1） | 返回前 N 条 |
| N6 | `sortBy=releaseYear` | 按年份倒序 |
| N7 | `genre` 过滤 | 只返回该风格专辑 |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | `keyword` 含正则特殊字符（如 `C+`） | 不崩溃（DB RegExp 无需转义，但需验证） |
| E2 | `id` 不存在 | 云函数抛异常，返回 `{success: false}` |
| E3 | `page=0` | skip 为负，DB 行为验证 |
| E4 | 未 approved 的专辑 | 不出现在列表中 |

---

### 2.4 `getCharts`

**正常流程覆盖：** 0%  

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | DB 有 avgScore > 0 的专辑 | 按 avgScore 降序排列 |
| N2 | DB 无评分专辑 | fallback 按 releaseYear 排序 |
| N3 | `scoreFill` 计算 | `score/10*100%`，最大 `100%` |
| N4 | rank 从 1 开始递增 | rank=1,2,3... |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | avgScore = 10（满分） | scoreFill = `'100%'` |
| E2 | avgScore = 0 | scoreFill = `'0%'` |
| E3 | `limit` 参数传 0 | 返回空列表，不崩溃 |

---

### 2.5 `login`

**正常流程覆盖：** 0%  

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | 新用户首次登录 | 创建用户，`isNew: true`，`type: 'normal'` |
| N2 | 已有用户登录 | 返回已有用户，`isNew: false` |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | 同一 OPENID 并发两次登录 | 不重复创建用户 |
| E2 | `nickName` 缺失 | 默认为 `'说唱迷'` |

---

### 2.6 `manageUsers`

**正常流程覆盖：** 0%  

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | Admin 执行 `listUsers` | 返回用户列表，带分页 |
| N2 | `listUsers` + `keyword` | 按昵称模糊搜索 |
| N3 | Admin 执行 `grantCritic` | 目标用户 `type → 'critic'` |
| N4 | Admin 执行 `revokeCritic` | 目标用户 `type → 'normal'` |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | 非 Admin 调用任何 action | `{success: false, error: '无权限'}` |
| E2 | `grantCritic` 传不存在的 openId | 不报错（DB update 影响 0 行），返回 `{success: true}` |
| E3 | `grantCritic` 缺少 openId 参数 | `{success: false, error: '缺少 openId'}` |
| E4 | `action` 为未知字符串 | `{success: false, error: '未知 action'}` |
| E5 | `formatDate` 传无效日期 | 返回 `''`，不抛异常 |

---

### 2.7 `manageCandidates`

**正常流程覆盖：** 0%  

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | `upsert_candidates`（新艺人） | 插入，返回 `{inserted: N, skipped: 0}` |
| N2 | `upsert_candidates`（已存在艺人） | 跳过，返回 `{inserted: 0, skipped: N}` |
| N3 | Admin `list`（status=pending） | 返回待审核列表 |
| N4 | Admin `decide`（approve） | 候选状态 → `'approved'`，触发专辑同步 |
| N5 | Admin `decide`（decline） | 候选状态 → `'declined'` |
| N6 | `get_decisions` | 返回所有 approved/declined 艺人 |
| N7 | `stats` | 返回 `{pending, approved, declined}` 计数 |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | `upsert_candidates`（空数组） | `{inserted: 0, skipped: 0}` |
| E2 | `decide`（空 decisions 数组） | `{success: true, updated: 0}` |
| E3 | `normalizeAlbum` 中 `size=0` | track_count 视为未知，允许通过（当前行为） |
| E4 | 非 Admin 调用 `list` / `decide` / `stats` | `{success: false, error: 'unauthorized'}` |
| E5 | `refresh_albums` 传不存在的 candidateId | `{success: false, error: 'not found'}` |

---

### 2.8 `uploadAlbums`

| # | 场景 | 预期 |
|---|------|------|
| N1 | 全新专辑批量插入 | inserted=N，updated=0，skipped=0 |
| N2 | 已存在专辑 upsert 模式 | updated=N，inserted=0 |
| N3 | 已存在专辑 insert_only 模式 | skipped=N |
| E1 | albums 为空数组 | `{inserted:0,updated:0,skipped:0,errors:0,total:0}` |
| E2 | 缺少 sourceId 的条目 | 被 skipped，不崩溃 |
| E3 | 缺少 title 或 artist 的条目 | 被 skipped |

---

### 2.9 `likeReview` / `addFavorite` / `removeFavorite` / `getFavorites`

所有收藏和点赞函数：覆盖率 0%。

| # | 云函数 | 场景 | 预期 |
|---|--------|------|------|
| N1 | likeReview | 有效 reviewId | likes + 1，`{success: true}` |
| N2 | addFavorite | 正常收藏 | `{success: true, alreadyFavorited: false}` |
| N3 | addFavorite | 重复收藏（幂等） | `{success: true, alreadyFavorited: true}` |
| N4 | removeFavorite | 正常取消 | `{success: true}` |
| N5 | getFavorites | 查收藏列表 | 返回该用户所有收藏 |
| E1 | likeReview | reviewId 缺失 | `{success: false, error: 'reviewId required'}` |
| E2 | likeReview | reviewId 不存在（DB 报错） | `{success: false}` |
| E3 | addFavorite | albumId 缺失 | `{success: false, error: 'albumId required'}` |

---

## 三、Python 爬虫逐项分析

### 3.1 `normalize_album`（`spider_netease.py`）

这是爬虫最核心的纯函数，**完全可以用 pytest 单元测试**，不依赖网络。

#### 需要测试的 Normal Case

| # | 场景 | 预期 |
|---|------|------|
| N1 | 标准单艺人专辑 | 返回包含所有字段的字典 |
| N2 | 多艺人专辑（artists 字段长度 > 1） | artist 用 " / " 拼接 |
| N3 | `publishTime` 为毫秒时间戳 | releaseYear 正确解析 |
| N4 | `size=5`（正常专辑） | 通过过滤，trackCount=5 |

#### 需要测试的 Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | `size=1`（单曲） | 返回 `None` |
| E2 | `size=2`（EP 两曲） | 返回 `None` |
| E3 | `size=3`（最小合格数） | **通过**，返回字典 |
| E4 | `size=0`（未知曲目数） | 通过（不过滤），trackCount=0 |
| E5 | `title` 包含 `'现场版'` | 返回 `None` |
| E6 | `title` 包含 `'中国有嘻哈'` | 返回 `None` |
| E7 | `publishTime=0` | year=0，年份 < 1990 被过滤，返回 `None` |
| E8 | `publishTime=None` | year=0，同上，返回 `None` |
| E9 | `picUrl` 为空字符串 | 返回 `None` |
| E10 | `name`（title）为空 | 返回 `None` |
| E11 | `artist.name` 为空且无 fallback | 返回 `None` |
| E12 | releaseYear 为未来年份（当前年+2） | 返回 `None` |

---

### 3.2 `ms_to_year`（`spider_netease.py`）

纯函数，无依赖。

| # | 场景 | 预期 |
|---|------|------|
| N1 | `1483200000000`（2017年） | `2017` |
| E1 | `0` | `1970`（或需确认是否为无效值） |
| E2 | `None` | 返回 `0`，不抛异常 |
| E3 | 负数时间戳 | 返回 `0`，不抛异常 |
| E4 | 字符串 `"abc"` | 返回 `0`，不抛异常 |

---

### 3.3 `merge_and_save_albums`（`spider_netease.py`）

需 mock 文件系统，但逻辑可独立测试。

| # | 场景 | 预期 |
|---|------|------|
| N1 | 全新专辑写入空文件 | 写入所有条目 |
| N2 | 追加不重复专辑 | existing + new_albums，按 sourceId 去重 |
| N3 | dry_run=True | 不写文件，只打印统计 |
| E1 | new_albums 包含 existing 中已有的 sourceId | 重复项被丢弃 |
| E2 | OUTPUT_FILE 不存在 | 视为空列表，不崩溃 |

---

### 3.4 `formatDate`（`manageUsers/index.js`）

工具函数，可直接单元测试（从 `manageUsers` 中提取）。

| # | 场景 | 预期 |
|---|------|------|
| N1 | 有效 Date 对象 | `'YYYY-MM-DD'` 格式 |
| E1 | `null` | 返回 `''` |
| E2 | 无效日期字符串 | 返回 `''` |

---

## 四、小程序前端

小程序页面和组件运行在微信 runtime，难以进行标准单元测试。但以下逻辑**可以提取为纯函数**并测试：

### 4.1 可提取的纯函数

| 函数 | 所在文件 | 说明 |
|------|---------|------|
| `mapAlbum(raw)` | `album-detail/index.ts` | avgScore 映射、scoreFill 计算 |
| scoreFill 计算 | `home/index.ts`, `discover/index.ts` | `Math.round(score/10*100)+'%'` |

#### `mapAlbum` Edge Case

| # | 场景 | 预期 |
|---|------|------|
| E1 | `avgScore=undefined` | 默认 0，scoreFill=`'0%'` |
| E2 | `avgScore=10` | scoreFill=`'100%'` |
| E3 | `avgScore=7.55` | 四舍五入到 `7.6` |
| E4 | `title/artist=undefined` | 降级为空字符串，不崩溃 |

---

## 五、待编写测试清单（按优先级排序）

### P0 — 必须立刻修复 + 测试（已发现 Bug）

| 编号 | 类型 | 文件 | 测试项 |
|------|------|------|--------|
| P0-1 | Bug 修复验证 | `cloudfunctions/submitReview/index.js:51-58` | avgScore 重复计算：2条评论后验证 avgScore 是否正确 |
| P0-2 | Bug 修复验证 | `cloudfunctions/getReviews/index.js:50-58` | `formatTimeAgo` 传入未来时间时不返回负数天数 |

### P1 — 核心业务逻辑（高风险）

| 编号 | 类型 | 文件 | 测试项 |
|------|------|------|--------|
| P1-1 | 单元测试 | `spider_netease.py` | `normalize_album` 单曲过滤（size=1,2 → None；size=3 → 通过） |
| P1-2 | 单元测试 | `spider_netease.py` | `normalize_album` SKIP_KEYWORDS 过滤 |
| P1-3 | 单元测试 | `spider_netease.py` | `normalize_album` 年份校验（0、过去、未来） |
| P1-4 | 集成测试 | `cloudfunctions/submitReview` | 重复提交同一用户同一专辑被拒绝 |
| P1-5 | 集成测试 | `cloudfunctions/submitReview` | rating 范围校验（0、11、-1、null） |
| P1-6 | 集成测试 | `cloudfunctions/manageUsers` | 非 Admin 调用返回 `无权限` |

### P2 — 重要边界条件

| 编号 | 类型 | 文件 | 测试项 |
|------|------|------|--------|
| P2-1 | 单元测试 | `spider_netease.py` | `ms_to_year` 对 None、0、负数的处理 |
| P2-2 | 单元测试 | `spider_netease.py` | `merge_and_save_albums` dry_run 不写文件 |
| P2-3 | 单元测试 | `spider_netease.py` | `merge_and_save_albums` sourceId 去重 |
| P2-4 | 集成测试 | `cloudfunctions/getAlbums` | keyword 含正则特殊字符不崩溃 |
| P2-5 | 集成测试 | `cloudfunctions/getCharts` | 无评分时 fallback 按年份排序 |
| P2-6 | 集成测试 | `cloudfunctions/uploadAlbums` | 缺 sourceId/title/artist 的条目被跳过而非崩溃 |
| P2-7 | 集成测试 | `cloudfunctions/manageCandidates` | `upsert_candidates` 重复艺人幂等性 |
| P2-8 | 单元测试 | `album-detail/index.ts:mapAlbum` | avgScore=undefined、10、7.55 的映射 |

### P3 — 完整性覆盖

| 编号 | 类型 | 文件 | 测试项 |
|------|------|------|--------|
| P3-1 | 集成测试 | `cloudfunctions/login` | 新用户创建、老用户返回、并发不重复创建 |
| P3-2 | 集成测试 | `cloudfunctions/getReviews` | 三种查询模式（albumId/userId/recent）均正常返回 |
| P3-3 | 集成测试 | `cloudfunctions/getReviews` | Critic 评论排在普通评论前 |
| P3-4 | 集成测试 | `cloudfunctions/likeReview` | likes 原子递增，reviewId 缺失返回错误 |
| P3-5 | 集成测试 | `cloudfunctions/addFavorite` | 重复收藏幂等，不重复插入 |
| P3-6 | 集成测试 | `cloudfunctions/manageUsers` | `grantCritic` → `revokeCritic` 完整流程 |
| P3-7 | 集成测试 | `cloudfunctions/getAlbums` | 未 approved 的专辑不出现在列表中 |
| P3-8 | 单元测试 | `manageUsers/index.js:formatDate` | 有效日期、null、无效字符串 |

---

## 六、推荐测试基础设施

### 云函数（JavaScript）

推荐使用 **Jest** + `wx-server-sdk` mock：

```bash
npm install --save-dev jest @jest/globals
```

在各云函数目录创建 `__tests__/index.test.js`，mock `wx-server-sdk` 的 DB 操作。

```js
// cloudfunctions/submitReview/__tests__/index.test.js 示例结构
jest.mock('wx-server-sdk', () => ({ /* mock db */ }))
const { main } = require('../index')

test('rating 0 被拒绝', async () => {
  const res = await main({ albumId: 'a1', rating: 0, content: '好' })
  expect(res).toEqual({ success: false, error: '评分范围 1-10' })
})
```

### Python 爬虫

推荐使用 **pytest** + `tmp_path` fixture（内置）：

```bash
pip install pytest
pytest crawler/tests/
```

纯函数（`normalize_album`、`ms_to_year`、`merge_and_save_albums`）不需要 mock，直接调用即可。

### 小程序前端

将可提取的纯函数（如 `mapAlbum`）移至独立工具文件，再用 Jest 测试。 UI 级别的测试（页面渲染、事件响应）需依赖微信开发者工具自动化或 E2E 工具（成本高，暂不优先）。

---

## 七、总结

| 问题类型 | 数量 | 最高优先级 |
|---------|------|-----------|
| 确认 Bug | 2 | `submitReview` avgScore 计算错误（每次提交偏高） |
| 需覆盖的 Normal Case | ~45 | — |
| 需覆盖的 Edge Case | ~55 | — |
| 完全没有测试的云函数 | 15/15 | — |
| 可立即编写的纯函数单元测试（无需 mock） | `normalize_album`、`ms_to_year`、`merge_and_save_albums`、`mapAlbum`、`formatDate` | — |
