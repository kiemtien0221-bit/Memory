import { Redis } from '@upstash/redis';

// Cho phép payload lớn hơn mặc định 1MB vì nội dung trang offline (.mht dạng base64) đi qua đây.
export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    responseLimit: '10mb',
  },
};

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

const MAX_HIST = 100;
const MAX_BMS = 300;
const MAX_OFFLINE_PAGES = 200;
const MAX_FILE_BASE64_CHARS = 8 * 1024 * 1024; // content đã được client gzip trước khi base64, nên ~8MB base64 ứng với file .mht gốc lớn hơn nhiều
const TTL_SECONDS = 365 * 24 * 60 * 60; // 365 ngày không hoạt động thì tự xoá (Redis TTL)

// ── Key ──────────────────────────────────────────────────────────────
const dataKey = (userId) => `datatrinhduyet:data:${userId}`;
const fileKey = (userId, pageId) => `datatrinhduyet:file:${userId}:${pageId}`;

function emptyState() {
  return { tabs: [], cur: 0, favs: [], hist: [], bms: [], offlinePages: [] };
}

async function getState(userId) {
  if (!redis) return emptyState();
  try {
    const data = await redis.get(dataKey(userId));
    if (!data) return emptyState();
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    if (!obj || typeof obj !== 'object') return emptyState();
    return { ...emptyState(), ...obj };
  } catch (e) {
    console.error('getState error:', e);
    return emptyState();
  }
}

// Lưu + tự làm mới TTL 365 ngày mỗi khi có hoạt động (đọc hoặc ghi).
async function saveState(userId, state) {
  if (!redis) return false;
  try {
    await redis.set(dataKey(userId), JSON.stringify(state), { ex: TTL_SECONDS });
    return true;
  } catch (e) {
    console.error('saveState error:', e);
    return false;
  }
}

async function touchTtl(userId) {
  if (!redis) return;
  try {
    await redis.expire(dataKey(userId), TTL_SECONDS);
  } catch (e) {
    console.error('touchTtl error:', e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { action, userId } = body;
    if (!userId) return res.status(400).json({ success: false, error: 'Thiếu userId' });

    // ── Nạp toàn bộ dữ liệu trình duyệt khi mở app (không kèm nội dung
    //    file offline — phần đó tải riêng qua getOfflinePageContent) ──
    if (action === 'load') {
      const state = await getState(userId);
      await touchTtl(userId);
      return res.status(200).json({ success: true, ...state });
    }

    // ── Tab đang mở + tab đang active ────────────────────────────────
    if (action === 'saveTabs') {
      const { tabs, cur } = body;
      const state = await getState(userId);
      state.tabs = Array.isArray(tabs) ? tabs : [];
      state.cur = Number.isInteger(cur) ? cur : 0;
      await saveState(userId, state);
      return res.status(200).json({ success: true });
    }

    // ── Trang tắt màn hình chủ ────────────────────────────────────────
    if (action === 'saveFavs') {
      const { favs } = body;
      const state = await getState(userId);
      state.favs = Array.isArray(favs) ? favs : [];
      await saveState(userId, state);
      return res.status(200).json({ success: true });
    }

    // ── Lịch sử ──────────────────────────────────────────────────────
    if (action === 'addHistory') {
      const { title, url } = body;
      if (!url) return res.status(400).json({ success: false, error: 'Thiếu url' });
      const state = await getState(userId);
      state.hist = [{ title: title || url, url }, ...state.hist].slice(0, MAX_HIST);
      await saveState(userId, state);
      return res.status(200).json({ success: true, hist: state.hist });
    }
    if (action === 'removeHistory') {
      const { index } = body;
      const state = await getState(userId);
      state.hist = state.hist.filter((_, i) => i !== index);
      await saveState(userId, state);
      return res.status(200).json({ success: true, hist: state.hist });
    }
    if (action === 'clearHistory') {
      const state = await getState(userId);
      state.hist = [];
      await saveState(userId, state);
      return res.status(200).json({ success: true });
    }

    // ── Bookmark ─────────────────────────────────────────────────────
    if (action === 'addBookmark') {
      const { title, url } = body;
      if (!url) return res.status(400).json({ success: false, error: 'Thiếu url' });
      const state = await getState(userId);
      state.bms = [{ title: title || url, url }, ...state.bms].slice(0, MAX_BMS);
      await saveState(userId, state);
      return res.status(200).json({ success: true, bms: state.bms });
    }
    if (action === 'removeBookmark') {
      const { index } = body;
      const state = await getState(userId);
      state.bms = state.bms.filter((_, i) => i !== index);
      await saveState(userId, state);
      return res.status(200).json({ success: true, bms: state.bms });
    }

    // ── Trang lưu offline: nội dung .mht (base64) lưu ở key riêng để
    //    "load" luôn nhẹ; metadata (không kèm content) nằm trong state ──
    if (action === 'addOfflinePage') {
      const { title, url, content } = body;
      if (!content) return res.status(400).json({ success: false, error: 'Thiếu content' });
      if (content.length > MAX_FILE_BASE64_CHARS) {
        return res.status(413).json({ success: false, error: 'File quá lớn để đồng bộ' });
      }
      const state = await getState(userId);
      const id = 'op_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const sizeBytes = Math.floor((content.length * 3) / 4);
      try {
        await redis.set(fileKey(userId, id), content, { ex: TTL_SECONDS });
      } catch (e) {
        console.error('save file content error:', e);
        return res.status(500).json({ success: false, error: 'Lỗi lưu nội dung file' });
      }
      const record = { id, title: title || url || 'Trang', url: url || '', size: sizeBytes, saved: Date.now() };
      state.offlinePages = [record, ...state.offlinePages].slice(0, MAX_OFFLINE_PAGES);
      // Nếu vượt giới hạn số trang, dọn luôn nội dung file của các bản ghi bị loại ra.
      await saveState(userId, state);
      return res.status(200).json({ success: true, page: record, offlinePages: state.offlinePages });
    }

    if (action === 'getOfflinePageContent') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      try {
        const content = await redis.get(fileKey(userId, id));
        if (!content) return res.status(404).json({ success: false, error: 'Không tìm thấy nội dung' });
        await touchTtl(userId);
        return res.status(200).json({ success: true, content });
      } catch (e) {
        console.error('getOfflinePageContent error:', e);
        return res.status(500).json({ success: false, error: 'Lỗi tải nội dung' });
      }
    }

    if (action === 'removeOfflinePage') {
      const { id } = body;
      const state = await getState(userId);
      state.offlinePages = state.offlinePages.filter((p) => p.id !== id);
      await saveState(userId, state);
      try {
        await redis.del(fileKey(userId, id));
      } catch (e) {
        console.error('del file content error:', e);
      }
      return res.status(200).json({ success: true, offlinePages: state.offlinePages });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    console.error('handler error:', e);
    return res.status(500).json({ success: false, error: e.message || 'Lỗi server' });
  }
}
