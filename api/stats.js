import { getRedis } from './_redis.js'

const redis = getRedis()

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const totalSongs = await redis.get('stats:total_songs') || '0'

    // Lấy tất cả songs để tính unique users
    const songsData = await redis.zrange('songs', 0, -1)
    const songs = songsData.map(s => {
      try { return JSON.parse(s) } catch(e) { return null }
    }).filter(Boolean)

    const uniqueUsers = new Set(songs.map(s => s.userId)).size
    const totalSize = songs.reduce((sum, s) => sum + (parseInt(s.size) || 0), 0)

    return res.status(200).json({
      totalSongs: songs.length,
      totalSongsCounter: parseInt(totalSongs),
      uniqueUsers: uniqueUsers,
      totalSizeBytes: totalSize,
      totalSizeMB: Math.round(totalSize / 1048576 * 10) / 10
    })

  } catch (e) {
    console.error('Stats error:', e)
    return res.status(500).json({ error: e.message })
  }
}
