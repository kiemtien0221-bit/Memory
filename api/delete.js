import { getRedis } from './_redis.js'

const redis = getRedis()

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const { message_id, userId } = req.body
    if (!message_id) return res.status(400).json({ error: 'Missing message_id' })

    // Lấy song info
    const song = await redis.hgetall(`song:${message_id}`)

    if (!song || !song.id) {
      return res.status(404).json({ error: 'Song not found' })
    }

    // Kiểm tra quyền (chỉ chủ sở hữu hoặc admin mới xóa)
    // Admin check: userId === 'admin' hoặc có secret key
    const isAdmin = userId === process.env.ADMIN_USER_ID

    if (song.userId !== userId && !isAdmin) {
      return res.status(403).json({ error: 'Not your song' })
    }

    // Xóa khỏi sorted set
    const member = JSON.stringify(song)
    await redis.zrem('songs', member)

    // Xóa hash
    await redis.del(`song:${message_id}`)

    // Xóa khỏi user set
    await redis.srem(`user:${song.userId}:songs`, message_id)

    // Decrement counter
    await redis.decr('stats:total_songs')

    return res.status(200).json({ 
      ok: true, 
      deleted: message_id,
      name: song.name 
    })

  } catch (e) {
    console.error('Delete error:', e)
    return res.status(500).json({ error: e.message })
  }
}
