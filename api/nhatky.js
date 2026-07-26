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

const MAX_ENTRIES = 200;
// Đồng bộ TTL với chat.js MEMORY_CONFIG.LONG_TERM_DAYS = 365
// Tài khoản bị xóa sau 365 ngày không hoạt động → dữ liệu nhật ký cũng tự xóa theo
const LONG_TERM_DAYS = 365;
const LONG_TERM_TTL = LONG_TERM_DAYS * 86400; // 31.536.000 giây

const diaryKey = (userId) => `kami:diary:${userId}`;

async function getDiary(userId) {
  if (!redis) return [];
  try {
    const data = await redis.get(diaryKey(userId));
    if (!data) return [];
    // Refresh TTL mỗi lần đọc — đồng bộ với chat.js getLongTermMemory()
    await redis.expire(diaryKey(userId), LONG_TERM_TTL);
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function saveDiary(userId, list) {
  if (!redis) return false;
  try {
    // Set TTL khi ghi — đồng bộ với chat.js setData/setHashData
    await redis.set(diaryKey(userId), JSON.stringify(list), { ex: LONG_TERM_TTL });
    return true;
  } catch (e) {
    return false;
  }
}

function sortDiary(list) {
  return list.sort((a, b) => {
    const fav1 = a.favorite ? 1 : 0;
    const fav2 = b.favorite ? 1 : 0;
    if (fav1 !== fav2) return fav2 - fav1;
    const d1 = a.createdAt || '0';
    const d2 = b.createdAt || '0';
    return d2.localeCompare(d1);
  });
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
      let entries = await getDiary(userId);
      entries = sortDiary(entries);
      return res.status(200).json({ success: true, entries, maxEntries: MAX_ENTRIES, ttlDays: LONG_TERM_DAYS });
    }

    if (action === 'add') {
      const { title, content, mood, favorite, date } = body;
      if (!title || !content)
        return res.status(400).json({ success: false, error: 'Thiếu title hoặc content' });
      let list = await getDiary(userId);
      if (list.length >= MAX_ENTRIES)
        return res.status(400).json({ success: false, error: `Đã đạt giới hạn ${MAX_ENTRIES} nhật ký` });
      const now = Date.now();
      const item = {
        id: String(now),
        userId,
        title: String(title).slice(0, 200),
        content: String(content).slice(0, 10000),
        mood: mood ? String(mood).slice(0, 10) : '😊',
        favorite: !!favorite,
        date: date ? String(date) : new Date().toLocaleString('vi-VN'),
        createdAt: String(now),
      };
      list.push(item);
      if (list.length > MAX_ENTRIES) list = list.slice(-MAX_ENTRIES);
      list = sortDiary(list);
      const ok = await saveDiary(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, entry: item });
    }

    if (action === 'remove') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      let list = await getDiary(userId);
      const next = list.filter((n) => n.id !== id);
      if (next.length === list.length) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
      const ok = await saveDiary(userId, next);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true });
    }

    if (action === 'update') {
      const { id, title, content, mood, date } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      let list = await getDiary(userId);
      const target = list.find((n) => n.id === id);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
      if (title !== undefined) target.title = String(title).slice(0, 200);
      if (content !== undefined) target.content = String(content).slice(0, 10000);
      if (mood !== undefined) target.mood = String(mood).slice(0, 10);
      if (date) target.date = String(date);
      target.createdAt = String(Date.now());
      list = sortDiary(list);
      const ok = await saveDiary(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true });
    }

    if (action === 'toggleFavorite') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      let list = await getDiary(userId);
      const idx = list.findIndex((n) => n.id === id);
      if (idx === -1) return res.status(404).json({ success: false, error: 'Không tìm thấy' });
      list[idx].favorite = !list[idx].favorite;
      list = sortDiary(list);
      const ok = await saveDiary(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, favorite: list[idx].favorite });
    }

    if (action === 'clearAll') {
      const ok = await saveDiary(userId, []);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
