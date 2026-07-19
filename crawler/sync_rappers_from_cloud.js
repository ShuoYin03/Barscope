#!/usr/bin/env node
// 直接用 CloudBase Node SDK（同 web/ 项目那套 SecretId/SecretKey）读取云数据库里
// artist_candidates 集合中 status='approved' 的记录，覆盖写回 rappers.json 的
// "rappers" 数组，让本地爬虫种子文件跟线上真实数据库对齐。
// candidates / excluded / excluded_ids 三个字段不动，只刷新 rappers。
//
// 用法：
//   cd crawler
//   npm install @cloudbase/node-sdk
//   CLOUDBASE_SECRET_ID=xxx CLOUDBASE_SECRET_KEY=xxx node sync_rappers_from_cloud.js

const fs = require('fs')
const path = require('path')
const cloudbase = require('@cloudbase/node-sdk')

const ENV_ID = 'dev021031-d3guj7zom3f13f9e8'
const RAPPERS_PATH = path.join(__dirname, 'rappers.json')

async function main() {
  const secretId = process.env.CLOUDBASE_SECRET_ID
  const secretKey = process.env.CLOUDBASE_SECRET_KEY
  if (!secretId || !secretKey) {
    console.error('缺少 CLOUDBASE_SECRET_ID / CLOUDBASE_SECRET_KEY 环境变量')
    process.exit(1)
  }

  const app = cloudbase.init({ env: ENV_ID, secretId, secretKey })
  const db = app.database()

  const pageSize = 100
  const all = []
  for (let skip = 0; ; skip += pageSize) {
    const r = await db.collection('artist_candidates')
      .where({ status: 'approved' })
      .field({ artistName: true, artistId: true })
      .skip(skip)
      .limit(pageSize)
      .get()
    all.push(...r.data)
    if (r.data.length < pageSize) break
  }

  const rappers = all
    .filter((x) => x.artistName && x.artistId)
    .map((x) => ({ name: x.artistName, id: x.artistId }))

  const raw = fs.readFileSync(RAPPERS_PATH, 'utf-8')
  const data = JSON.parse(raw)
  const before = (data.rappers || []).length
  data.rappers = rappers

  fs.writeFileSync(RAPPERS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8')
  console.log(`rappers.json 已更新：${before} -> ${rappers.length}`)
}

main().catch((err) => {
  console.error('同步失败:', err.message)
  process.exit(1)
})
