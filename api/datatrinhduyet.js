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

const MAX_HIST = 100;
const MAX_BMS = 300;
const MAX_OFFLINE_PAGES = 200;
const TTL_SECONDS = 365 * 24 * 60 * 60; // 365 ngày không hoạt động thì tự xoá (Redis TTL)

// ── Key ──────────────────────────────────────────────────────────────
const dataKey = (userId) => `datatrinhduyet:data:${userId}`;

// 5 kho Telegram — dùng chung hạ tầng với KamiAlbum/KamiCloud, phải khớp đúng
// thứ tự với mảng BOT_TOKENS/CHAT_IDS bên Java của KamiBrowser.
const BOT_TOKENS = [
  process.env.TELEGRAM_BOT_TOKEN_0,
  process.env.TELEGRAM_BOT_TOKEN_1,
  process.env.TELEGRAM_BOT_TOKEN_2,
  process.env.TELEGRAM_BOT_TOKEN_3,
  process.env.TELEGRAM_BOT_TOKEN_4,
];
const CHAT_IDS = [
  '-1004458326128',
  '-1004394265697',
  '-1004384340797',
  '-1004315170042',
  '-1004392546391',
];

function pickBotToken(channel) {
  const idx = Number(channel);
  if (Number.isInteger(idx) && idx >= 0 && idx < BOT_TOKENS.length && BOT_TOKENS[idx]) {
    return BOT_TOKENS[idx];
  }
  return BOT_TOKENS[0];
}

function emptyState() {
  return { tabs: [], cur: 0, tabsUpdatedAt: 0, favs: [], hist: [], bms: [], offlinePages: [] };
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

const filePathCache = new Map();
const FILE_PATH_TTL_MS = 50 * 60 * 1000;

async function resolveTelegramFilePath(botToken, fileId) {
  const cached = filePathCache.get(fileId);
  if (cached && cached.expiresAt > Date.now()) return cached.path;
  const r = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const d = await r.json();
  if (!d.ok) throw new Error(d.description || 'getFile thất bại');
  filePathCache.set(fileId, { path: d.result.file_path, expiresAt: Date.now() + FILE_PATH_TTL_MS });
  return d.result.file_path;
}

// Server-side xoá message Telegram (fire-and-forget), giống KamiAlbum khi xoá file.
async function serverDeleteTelegram(channel, messageId) {
  try {
    const botToken = pickBotToken(channel);
    if (!botToken || !messageId) return;
    const chatId = CHAT_IDS[Number(channel)] || CHAT_IDS[0];
    await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch (e) {
    console.error('serverDeleteTelegram error:', e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: proxy tải nội dung file offline (.mht) từ Telegram ─────────
  if (req.method === 'GET' && req.query.proxy === '1') {
    try {
      const fid = req.query.fid;
      const channel = req.query.ch;
      if (!fid) return res.status(400).send('missing fid');
      const botToken = pickBotToken(channel);
      if (!botToken) return res.status(500).send('bot chưa cấu hình');
      const filePath = await resolveTelegramFilePath(botToken, fid);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
      const upstream = await fetch(fileUrl);
      if (!upstream.ok) return res.status(502).send('lỗi tải file gốc');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      const buf = Buffer.from(await upstream.arrayBuffer());
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(500).send('proxy error: ' + e.message);
    }
  }

  if (!REDIS_ENABLED || !redis)
    return res.status(503).json({ success: false, error: 'Redis chưa cấu hình' });

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { action, userId } = body;
    if (!userId) return res.status(400).json({ success: false, error: 'Thiếu userId' });

    // ── Nạp toàn bộ dữ liệu trình duyệt khi mở app ───────────────────
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
      state.tabsUpdatedAt = Date.now(); // mốc thời gian server dùng để so sánh last-write-wins giữa các máy
      await saveState(userId, state);
      return res.status(200).json({ success: true, tabsUpdatedAt: state.tabsUpdatedAt });
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

    // ── Trang lưu offline (nội dung .mht đã được client upload thẳng
    //    lên Telegram trước đó — ở đây chỉ lưu tham chiếu file_id) ────
    if (action === 'addOfflinePage') {
      const { title, url, file_id, message_id, channel } = body;
      if (!file_id) return res.status(400).json({ success: false, error: 'Thiếu file_id' });
      const state = await getState(userId);
      const record = {
        id: 'op_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
        title: title || url || 'Trang',
        url: url || '',
        file_id,
        message_id: message_id || null,
        channel: channel || 0,
        saved: Date.now(),
      };
      state.offlinePages = [record, ...state.offlinePages].slice(0, MAX_OFFLINE_PAGES);
      await saveState(userId, state);
      return res.status(200).json({ success: true, page: record, offlinePages: state.offlinePages });
    }
    if (action === 'removeOfflinePage') {
      const { id } = body;
      const state = await getState(userId);
      const target = state.offlinePages.find((p) => p.id === id);
      state.offlinePages = state.offlinePages.filter((p) => p.id !== id);
      await saveState(userId, state);
      if (target) serverDeleteTelegram(target.channel, target.message_id);
      return res.status(200).json({ success: true, offlinePages: state.offlinePages });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    console.error('handler error:', e);
    return res.status(500).json({ success: false, error: e.message || 'Lỗi server' });
  }
}
