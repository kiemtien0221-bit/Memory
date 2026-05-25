import { getRedis } from './_redis.js'

const redis = getRedis()
const BOT_TOKEN = process.env.BOT_TOKEN
const CHANNEL_ID = process.env.CHANNEL_ID

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '2mb'
    }
  }
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const body = req.body
    console.log('Webhook received:', JSON.stringify(body, null, 2))

    // Xử lý cả message (bot chat) và channel_post (channel)
    const msg = body.message || body.channel_post || body.edited_message || body.edited_channel_post
    if (!msg) {
      console.log('No message found in webhook')
      return res.status(200).json({ ok: true, message: 'No message' })
    }

    const doc = msg.document || msg.audio || msg.video || msg.voice
    if (!doc) {
      console.log('No document/audio found')
      return res.status(200).json({ ok: true, message: 'Not a file' })
    }

    // Chỉ nhận MP3
    const fileName = doc.file_name || (msg.audio ? (msg.audio.title || 'audio.mp3') : 'unknown.mp3')
    const mimeType = doc.mime_type || ''

    if (!fileName.toLowerCase().endsWith('.mp3') && !mimeType.includes('audio/mpeg') && !mimeType.includes('audio/mp3')) {
      console.log('Not MP3:', fileName, mimeType)
      return res.status(200).json({ ok: true, message: 'Not MP3' })
    }

    // Parse caption
    const caption = msg.caption || ''
    const uidMatch = caption.match(/USER:([^\s|]+)/)
    const nameMatch = caption.match(/NAME:(.+?)(?:\||$)/)

    const userId = uidMatch ? uidMatch[1] : `user_${msg.from?.id || msg.sender_chat?.id || 'unknown'}`
    const songName = nameMatch ? nameMatch[1].trim() : fileName

    const song = {
      id: doc.file_id,
      file_id: doc.file_id,
      name: songName,
      size: doc.file_size || 0,
      date: msg.date,
      message_id: msg.message_id,
      userId: userId,
      chat_id: msg.chat?.id || CHANNEL_ID,
      added_at: Date.now(),
      mime_type: mimeType || 'audio/mpeg'
    }

    // Lưu vào Redis:
    // 1. Sorted Set "songs" để sort theo date (mới nhất trước)
    // 2. Hash "song:{message_id}" để dễ tìm kiếm/xóa
    // 3. Set "user:{userId}:songs" để lấy bài của user nhanh

    const member = JSON.stringify(song)

    await redis.zadd('songs', { score: msg.date, member: member })
    await redis.hset(`song:${msg.message_id}`, song)
    await redis.sadd(`user:${userId}:songs`, msg.message_id)

    // Cập nhật counter tổng
    await redis.incr('stats:total_songs')

    console.log('✅ Saved song:', song.name, 'by', userId, 'mid:', msg.message_id)

    return res.status(200).json({ 
      ok: true, 
      saved: song.name,
      message_id: msg.message_id
    })

  } catch (e) {
    console.error('❌ Webhook error:', e)
    return res.status(500).json({ error: e.message, stack: e.stack })
  }
}
