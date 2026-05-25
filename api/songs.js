import { getRedis } from './_redis.js'

const redis = getRedis()

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { 
      offset = '0', 
      limit = '50', 
      search = '', 
      userId = '',
      sort = 'newest' // newest, oldest, name
    } = req.query

    const off = parseInt(offset) || 0
    const lim = Math.min(parseInt(limit) || 50, 200) // Max 200 per request

    let songs = []

    if (userId) {
      // Lấy bài của 1 user cụ thể
      const msgIds = await redis.smembers(`user:${userId}:songs`)
      for (const mid of msgIds) {
        const s = await redis.hgetall(`song:${mid}`)
        if (s && s.id) songs.push(s)
      }
      // Sort by date
      songs.sort((a, b) => (b.date || 0) - (a.date || 0))
    } else {
      // Lấy tất cả từ sorted set
      const rev = sort === 'oldest' ? false : true
      const songsData = await redis.zrange('songs', 0, -1, { rev: rev })

      songs = songsData.map(s => {
        try { 
          const parsed = JSON.parse(s)
          return parsed
        } catch(e) { 
          return null 
        }
      }).filter(Boolean)
    }

    // Search filter
    if (search) {
      const q = search.toLowerCase()
      songs = songs.filter(s => 
        (s.name || '').toLowerCase().includes(q) ||
        (s.userId || '').toLowerCase().includes(q)
      )
    }

    // Sort nếu là name
    if (sort === 'name') {
      songs.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    }

    const total = songs.length
    const paginated = songs.slice(off, off + lim)

    // Stats
    const totalSongs = await redis.get('stats:total_songs') || total

    return res.status(200).json({
      songs: paginated,
      total: total,
      offset: off,
      limit: lim,
      hasMore: (off + lim) < total,
      stats: {
        totalSongs: parseInt(totalSongs) || total
      }
    })

  } catch (e) {
    console.error('Songs error:', e)
    return res.status(500).json({ error: e.message })
  }
}
