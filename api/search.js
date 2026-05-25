import { getRedis } from './_redis.js'

const redis = getRedis()

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { q = '', limit = '50' } = req.query
    if (!q || q.length < 1) {
      return res.status(400).json({ error: 'Query too short' })
    }

    const lim = Math.min(parseInt(limit) || 50, 100)
    const query = q.toLowerCase().trim()

    // Lấy tất cả songs
    const songsData = await redis.zrange('songs', 0, -1, { rev: true })

    const allSongs = songsData.map(s => {
      try { return JSON.parse(s) } catch(e) { return null }
    }).filter(Boolean)

    // Search: name, userId
    const results = allSongs.filter(s => {
      const name = (s.name || '').toLowerCase()
      const uid = (s.userId || '').toLowerCase()
      return name.includes(query) || uid.includes(query)
    })

    return res.status(200).json({
      songs: results.slice(0, lim),
      total: results.length,
      query: q
    })

  } catch (e) {
    console.error('Search error:', e)
    return res.status(500).json({ error: e.message })
  }
}
