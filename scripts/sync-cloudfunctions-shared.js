// 把 shared/cloudfunctions/ 下的公共代码同步复制进每个云函数的 _shared/ 目录。
// 微信开发者工具上传云函数时只打包该函数文件夹本身，不会带上文件夹外的文件，
// 所以公共代码不能靠 require('../../shared/...') 跨函数目录引用，只能在部署前
// 把真实文件复制进每个函数目录里。
//
// 用法：node scripts/sync-cloudfunctions-shared.js
// 改了 shared/cloudfunctions/ 下的源文件后，必须重新运行这个脚本，再上传对应云函数。

const fs = require('fs')
const path = require('path')

const SHARED_DIR = path.join(__dirname, '..', 'shared', 'cloudfunctions')
const CLOUDFUNCTIONS_DIR = path.join(__dirname, '..', 'cloudfunctions')

// 文件名 -> 需要同步进去的云函数目录列表
const TARGETS = {
  'auth.js': [
    'backfillReleaseDates',
    'cleanupDuplicates',
    'cloudCrawler',
    'cloudCrawlerDailyTrigger',
    'exportApprovedRappers',
    'fastCompareQQAlbums',
    'manageAlbumCandidates',
    'manageAlbumOwnershipCorrections',
    'manageAlbumTypeCorrections',
    'manageArtistBrands',
    'manageArtistCorrections',
    'manageCandidates',
    'manageCrawlerReports',
    'manageDataDiagnostics',
    'manageFeaturePlaylists',
    'manageInterviews',
    'manageQQAlbumBackfill',
    'manageQQAlbumCache',
    'manageTrackCorrections',
    'submitArtistVerification',
    'updateAlbumCover',
    'updateAlbumMetadata',
    'updateAlbumTracks',
    'reviewModeration',
  ],
  'contentModeration.js': [
    'submitReview',
    'replyReview',
    'login',
    'manageInterviews',
  ],
}

const HEADER = '// 自动生成，请勿手改。源文件在 shared/cloudfunctions/，改完运行 node scripts/sync-cloudfunctions-shared.js 重新同步。\n'

let count = 0
for (const [file, targets] of Object.entries(TARGETS)) {
  const srcPath = path.join(SHARED_DIR, file)
  const content = HEADER + fs.readFileSync(srcPath, 'utf8')
  for (const fn of targets) {
    const destDir = path.join(CLOUDFUNCTIONS_DIR, fn, '_shared')
    fs.mkdirSync(destDir, { recursive: true })
    const destPath = path.join(destDir, file)
    fs.writeFileSync(destPath, content, 'utf8')
    count += 1
    console.log(`已同步 -> cloudfunctions/${fn}/_shared/${file}`)
  }
}

console.log(`\n完成，共同步 ${count} 个文件。`)
