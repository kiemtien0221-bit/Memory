import { Redis } from '@upstash/redis';

const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;
let redis = null;
if (REDIS_ENABLED) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  } catch (e) {
    console.error('Redis init error:', e);
  }
}

const MAX_NOTES = 100;
// Đồng bộ TTL với chat.js MEMORY_CONFIG.LONG_TERM_DAYS = 365
// Tài khoản bị xóa sau 365 ngày không hoạt động → dữ liệu notes cũng tự xóa theo
const LONG_TERM_DAYS = 365;
const LONG_TERM_TTL = LONG_TERM_DAYS * 86400; // 31.536.000 giây

const notesKey = (userId) => `kami:notes:${userId}`;

async function getNotes(userId) {
  if (!redis) return [];
  try {
    const data = await redis.get(notesKey(userId));
    if (!data) return [];
    // Refresh TTL mỗi lần đọc — đồng bộ với chat.js getLongTermMemory()
    await redis.expire(notesKey(userId), LONG_TERM_TTL);
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function saveNotes(userId, list) {
  if (!redis) return false;
  try {
    // Set TTL khi ghi — đồng bộ với chat.js setData/setHashData
    await redis.set(notesKey(userId), JSON.stringify(list), { ex: LONG_TERM_TTL });
    return true;
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });
  if (req.method !== 'POST')
    return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const body = req.body || {};
    const { action, userId } = body;
    if (!userId) return res.status(400).json({ success: false, error: 'Thiếu userId' });

    if (action === 'list') {
      const notes = await getNotes(userId);
      return res.status(200).json({ success: true, notes, maxNotes: MAX_NOTES, ttlDays: LONG_TERM_DAYS });
    }

    if (action === 'save') {
      const { notes } = body;
      if (!Array.isArray(notes))
        return res.status(400).json({ success: false, error: 'Thiếu notes' });
      if (notes.length > MAX_NOTES)
        return res.status(400).json({ success: false, error: 'Vượt quá 100 ghi chú' });
      const clean = notes.map((n) => ({
        id: String(n.id || Date.now() + Math.random()),
        content: n.content ? String(n.content).slice(0, 5000) : '',
        pinned: !!n.pinned,
        time: n.time ? String(n.time) : '',
        ownerId: userId,
      }));
      const ok = await saveNotes(userId, clean);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, count: clean.length });
    }

    if (action === 'add') {
      const { id, content, pinned, time } = body;
      const list = await getNotes(userId);
      if (list.length >= MAX_NOTES)
        return res.status(400).json({ success: false, error: 'Đã đạt giới hạn 100 ghi chú' });
      const item = {
        id: id ? String(id) : String(Date.now()),
        content: content ? String(content).slice(0, 5000) : '',
        pinned: !!pinned,
        time: time ? String(time) : '',
        ownerId: userId,
      };
      if (item.pinned) list.unshift(item);
      else {
        let insertPos = 0;
        for (let i = 0; i < list.length; i++) {
          if (list[i].pinned) insertPos = i + 1;
        }
        list.splice(insertPos, 0, item);
      }
      const ok = await saveNotes(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, note: item });
    }

    if (action === 'remove') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getNotes(userId);
      const next = list.filter((n) => n.id !== id);
      await saveNotes(userId, next);
      return res.status(200).json({ success: true });
    }

    if (action === 'update') {
      const { id, content, time } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getNotes(userId);
      const target = list.find((n) => n.id === id);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
      if (content !== undefined) target.content = String(content).slice(0, 5000);
      if (time) target.time = String(time);
      const ok = await saveNotes(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true });
    }

    if (action === 'togglePin') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getNotes(userId);
      const idx = list.findIndex((n) => n.id === id);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
      list[idx].pinned = !list[idx].pinned;
      const pinned = list.filter((n) => n.pinned);
      const unpinned = list.filter((n) => !n.pinned);
      const ok = await saveNotes(userId, [...pinned, ...unpinned]);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, pinned: list[idx].pinned });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
