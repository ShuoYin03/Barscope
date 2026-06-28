const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// Fetch all albums in batches (Cloud DB server limit is 1000/query)
async function getAllAlbums() {
  var all = []
  var batchSize = 1000
  var skip = 0
  while (true) {
    var res = await db.collection('albums')
      .orderBy('_id', 'asc')
      .skip(skip)
      .limit(batchSize)
      .get()
    all = all.concat(res.data)
    if (res.data.length < batchSize) break
    skip += batchSize
  }
  return all
}

exports.main = async (event) => {
  var dryRun = event.dryRun !== false  // default: dry run for safety

  try {
    var albums = await getAllAlbums()

    // Group by sourceId first (most reliable), then fallback to title+artist
    var groups = {}
    albums.forEach(function(a) {
      var key = a.sourceId
        ? 'src:' + String(a.sourceId)
        : 'ta:' + (a.title || '').toLowerCase() + '|||' + (a.artist || '').toLowerCase()
      if (!groups[key]) groups[key] = []
      groups[key].push(a)
    })

    // Collect IDs to delete (keep the first/_id-sorted one, delete the rest)
    var toDelete = []
    Object.keys(groups).forEach(function(key) {
      var group = groups[key]
      if (group.length <= 1) return
      // Keep index 0 (already sorted by _id asc = insertion order), delete rest
      for (var i = 1; i < group.length; i++) {
        toDelete.push({ _id: group[i]._id, title: group[i].title, artist: group[i].artist })
      }
    })

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        totalAlbums: albums.length,
        duplicatesToDelete: toDelete.length,
        preview: toDelete.slice(0, 20),
      }
    }

    // Actually delete
    var deleted = 0
    for (var i = 0; i < toDelete.length; i++) {
      await db.collection('albums').doc(toDelete[i]._id).remove()
      deleted++
    }

    return {
      success: true,
      dryRun: false,
      totalAlbums: albums.length,
      deleted: deleted,
    }
  } catch (err) {
    return { success: false, error: err.message }
  }
}
