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

const QUOTA_BYTES = 100 * 1024 * 1024 * 1024; // 100GB
const MAX_FILES = 5000;
const FEED_PAGE_SIZE = 30;

// ── Keys ─────────────────────────────────────────────────────────────
const filesKey = (userId) => `kamialbum:files:${userId}`;
const prefsKey = (userId) => `kamialbum:prefs:${userId}`;
const likesKey = (fileId) => `kamialbum:likes:${fileId}`;
const commentsKey = (fileId) => `kamialbum:comments:${fileId}`;
const PUBLIC_FEED_KEY = 'kamialbum:publicfeed';
const USERS_SET_KEY = 'kamialbum:users';

// 5 kho Telegram — phải khớp đúng thứ tự với mảng BOT_TOKENS/CHAT_IDS bên Java.
const BOT_TOKENS = [
  process.env.TELEGRAM_BOT_TOKEN_0,
  process.env.TELEGRAM_BOT_TOKEN_1,
  process.env.TELEGRAM_BOT_TOKEN_2,
  process.env.TELEGRAM_BOT_TOKEN_3,
  process.env.TELEGRAM_BOT_TOKEN_4,
];

const CHAT_IDS = [
  "-1003238882382",
  "-1003661900869",
  "-1003949997099",
  "-1004465735490",
  "-1004345704771",
];

async function getFiles(userId) {
  if (!redis) return [];
  try {
    const data = await redis.get(filesKey(userId));
    if (!data) return [];
    const arr = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('getFiles error:', e);
    return [];
  }
}

async function saveFiles(userId, list) {
  if (!redis) return false;
  try {
    await redis.set(filesKey(userId), JSON.stringify(list));
    return true;
  } catch (e) {
    console.error('saveFiles error:', e);
    return false;
  }
}

async function getPrefs(userId) {
  if (!redis) return {};
  try {
    const data = await redis.get(prefsKey(userId));
    if (!data) return {};
    const obj = typeof data === 'string' ? JSON.parse(data) : data;
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    console.error('getPrefs error:', e);
    return {};
  }
}

async function savePrefs(userId, prefs) {
  if (!redis) return false;
  try {
    await redis.set(prefsKey(userId), JSON.stringify(prefs));
    return true;
  } catch (e) {
    console.error('savePrefs error:', e);
    return false;
  }
}

function albumIsPublic(prefs) {
  return prefs && prefs.albumVisibility === 'public';
}

function isEffectivelyPublic(file, prefs) {
  return albumIsPublic(prefs) && file.visibility === 'public';
}

function toPublicFile(it, ownerPrefs) {
  return {
    id: it.id,
    file_id: it.file_id,
    name: it.name,
    size: it.size,
    message_id: it.message_id,
    date: it.date,
    width: it.width || 0,
    height: it.height || 0,
    channel: it.channel || 0,
    visibility: it.visibility || 'private',
    effectivePublic: isEffectivelyPublic(it, ownerPrefs),
    canEdit: true,
  };
}

function toFeedItem(it, ownerId, ownerName) {
  return {
    id: it.id,
    file_id: it.file_id,
    name: it.name,
    size: it.size,
    message_id: it.message_id,
    date: it.date,
    width: it.width || 0,
    height: it.height || 0,
    channel: it.channel || 0,
    ownerId,
    ownerName: ownerName || 'Ẩn danh',
  };
}

async function syncFeedEntry(userId, file, ownerPrefs) {
  if (!redis) return;
  const member = `${userId}::${file.id}`;
  try {
    if (isEffectivelyPublic(file, ownerPrefs)) {
      await redis.zadd(PUBLIC_FEED_KEY, { score: Number(file.date) || 0, member });
    } else {
      await redis.zrem(PUBLIC_FEED_KEY, member);
    }
  } catch (e) {
    console.error('syncFeedEntry error:', e);
  }
}

async function syncAllFeedForUser(userId, list, prefs) {
  if (!redis) return;
  try {
    const pub = list.filter((f) => isEffectivelyPublic(f, prefs));
    const priv = list.filter((f) => !isEffectivelyPublic(f, prefs));
    const ops = [];
    if (pub.length) {
      const members = {};
      pub.forEach((f) => { members[`${userId}::${f.id}`] = Number(f.date) || 0; });
      ops.push(redis.zadd(PUBLIC_FEED_KEY, members));
    }
    if (priv.length) {
      ops.push(redis.zrem(PUBLIC_FEED_KEY, ...priv.map((f) => `${userId}::${f.id}`)));
    }
    await Promise.all(ops);
  } catch (e) {
    console.error('syncAllFeedForUser error:', e);
  }
}

async function removeFeedEntry(userId, fileId) {
  if (!redis) return;
  try {
    await redis.zrem(PUBLIC_FEED_KEY, `${userId}::${fileId}`);
  } catch (e) {
    console.error('removeFeedEntry error:', e);
  }
}

async function cascadeDeleteFile(fileId) {
  if (!redis) return;
  try {
    await Promise.all([
      redis.del(likesKey(fileId)),
      redis.del(commentsKey(fileId)),
    ]);
  } catch (e) {
    console.error('cascadeDeleteFile error:', e);
  }
}

async function getLikeInfo(fileId, userId) {
  if (!redis) return { count: 0, liked: false };
  try {
    const [count, liked] = await Promise.all([
      redis.scard(likesKey(fileId)),
      userId ? redis.sismember(likesKey(fileId), userId) : Promise.resolve(0),
    ]);
    return { count: Number(count) || 0, liked: !!liked };
  } catch (e) {
    console.error('getLikeInfo error:', e);
    return { count: 0, liked: false };
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

function pickBotToken(channel) {
  const idx = Number(channel);
  if (Number.isInteger(idx) && idx >= 0 && idx < BOT_TOKENS.length && BOT_TOKENS[idx]) {
    return BOT_TOKENS[idx];
  }
  return BOT_TOKENS[0];
}

// ── FIX: Server-side xóa message Telegram (fire-and-forget) ───────────
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

  // ── GET: proxy ảnh ───
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
      if (!upstream.ok) return res.status(502).send('lỗi tải ảnh gốc');
      const contentType = upstream.headers.get('content-type') || 'image/jpeg';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
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

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Thiếu userId' });
    }

    if (action === 'list') {
      const [files, prefs] = await Promise.all([getFiles(userId), getPrefs(userId)]);
      return res.status(200).json({
        success: true,
        files: files.map((f) => toPublicFile(f, prefs)),
        prefs,
        albumVisibility: prefs.albumVisibility || 'private',
        quota: QUOTA_BYTES,
        maxFiles: MAX_FILES,
      });
    }

    if (action === 'save') {
      const { files } = body;
      if (!Array.isArray(files)) {
        return res.status(400).json({ success: false, error: 'Thiếu files (phải là mảng)' });
      }
      if (files.length > MAX_FILES) {
        return res.status(400).json({ success: false, error: 'Vượt quá giới hạn 5000 file' });
      }
      const totalSize = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      if (totalSize > QUOTA_BYTES) {
        return res.status(400).json({ success: false, error: 'Vượt quá quota 100GB' });
      }
      const clean = files.map((f) => ({
        id: f.id,
        file_id: f.file_id || f.id,
        name: f.name ? String(f.name).slice(0, 300) : 'Unknown',
        size: Number(f.size) || 0,
        message_id: Number(f.message_id) || 0,
        date: Number(f.date) || Math.floor(Date.now() / 1000),
        width: Number(f.width) || 0,
        height: Number(f.height) || 0,
        channel: Number(f.channel) || 0,
        visibility: f.visibility === 'public' ? 'public' : 'private',
        ownerId: userId,
      }));
      const ok = await saveFiles(userId, clean);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      const prefs = await getPrefs(userId);
      await syncAllFeedForUser(userId, clean, prefs);
      return res.status(200).json({ success: true, count: clean.length });
    }

    if (action === 'add') {
      const { id, file_id, name, size, message_id, width, height, channel } = body;
      if (!id && !file_id) {
        return res.status(400).json({ success: false, error: 'Thiếu id/file_id' });
      }
      const list = await getFiles(userId);
      const fid = file_id || id;
      if (list.some((f) => f.file_id === fid)) {
        return res.status(200).json({ success: true, duplicate: true });
      }
      if (list.length >= MAX_FILES) {
        return res.status(400).json({ success: false, error: 'Đã đạt giới hạn 5000 file' });
      }
      const totalSize = list.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      const fsize = Number(size) || 0;
      if (totalSize + fsize > QUOTA_BYTES) {
        return res.status(400).json({ success: false, error: 'Vượt quá quota 100GB' });
      }
      const item = {
        id: fid,
        file_id: fid,
        name: name ? String(name).slice(0, 300) : 'Unknown',
        size: fsize,
        message_id: Number(message_id) || 0,
        date: Math.floor(Date.now() / 1000),
        width: Number(width) || 0,
        height: Number(height) || 0,
        channel: Number(channel) || 0,
        visibility: 'private',
        ownerId: userId,
      };
      list.unshift(item);
      const ok = await saveFiles(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      await redis.sadd(USERS_SET_KEY, userId);
      return res.status(200).json({ success: true, file: toPublicFile(item, await getPrefs(userId)) });
    }

    // ── FIX: remove — server cũng thử xóa Telegram (fire-and-forget) ──
    if (action === 'remove') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getFiles(userId);
      const target = list.find((f) => f.file_id === id || f.id === id);
      const next = list.filter((f) => f.file_id !== id && f.id !== id);
      await saveFiles(userId, next);
      if (target) {
        // Xóa Telegram song song, không đợi
        serverDeleteTelegram(target.channel || 0, target.message_id || 0);
        await Promise.all([
          removeFeedEntry(userId, target.id),
          cascadeDeleteFile(target.id),
        ]);
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'rename') {
      const { id, name } = body;
      if (!id || !name) return res.status(400).json({ success: false, error: 'Thiếu id/name' });
      const list = await getFiles(userId);
      const target = list.find((f) => f.file_id === id || f.id === id);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy file' });
      target.name = String(name).slice(0, 300);
      await saveFiles(userId, list);
      return res.status(200).json({ success: true });
    }

    if (action === 'togglePhotoVisibility') {
      const { id, visibility } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const vis = visibility === 'public' ? 'public' : 'private';
      const list = await getFiles(userId);
      const target = list.find((f) => f.file_id === id || f.id === id);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy ảnh' });
      target.visibility = vis;
      await saveFiles(userId, list);
      const prefs = await getPrefs(userId);
      await syncFeedEntry(userId, target, prefs);
      return res.status(200).json({
        success: true,
        visibility: vis,
        effectivePublic: isEffectivelyPublic(target, prefs),
      });
    }

    if (action === 'toggleAlbumVisibility') {
      const { visibility } = body;
      const vis = visibility === 'public' ? 'public' : 'private';
      const prefs = await getPrefs(userId);
      prefs.albumVisibility = vis;
      await savePrefs(userId, prefs);
      const list = await getFiles(userId);
      await syncAllFeedForUser(userId, list, prefs);
      return res.status(200).json({ success: true, albumVisibility: vis });
    }

    if (action === 'feedPublic') {
      const { cursor } = body;
      const start = Number(cursor) || 0;
      const end = start + FEED_PAGE_SIZE - 1;
      const members = await redis.zrange(PUBLIC_FEED_KEY, start, end, { rev: true });
      if (!members || members.length === 0) {
        return res.status(200).json({ success: true, items: [], nextCursor: null });
      }
      const byOwner = {};
      members.forEach((m) => {
        const idx = m.indexOf('::');
        const oid = m.slice(0, idx);
        const fid = m.slice(idx + 2);
        (byOwner[oid] = byOwner[oid] || []).push(fid);
      });
      const ownerIds = Object.keys(byOwner);
      const ownerData = await Promise.all(
        ownerIds.map(async (oid) => {
          const [list, prefs] = await Promise.all([getFiles(oid), getPrefs(oid)]);
          return { oid, list, prefs };
        })
      );
      const fileMap = {};
      ownerData.forEach(({ oid, list, prefs }) => {
        const name = prefs.displayName || null;
        list.forEach((f) => {
          if (isEffectivelyPublic(f, prefs)) {
            fileMap[`${oid}::${f.id}`] = toFeedItem(f, oid, name);
          }
        });
      });
      const items = members.map((m) => fileMap[m]).filter(Boolean);
      const withStats = await Promise.all(
        items.map(async (it) => {
          const like = await getLikeInfo(it.id, userId);
          const commentCount = await redis.llen(commentsKey(it.id)).catch(() => 0);
          return { ...it, likeCount: like.count, liked: like.liked, commentCount: Number(commentCount) || 0 };
        })
      );
      const nextCursor = members.length < FEED_PAGE_SIZE ? null : end + 1;
      return res.status(200).json({ success: true, items: withStats, nextCursor });
    }

    if (action === 'like') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      await redis.sadd(likesKey(id), userId);
      const info = await getLikeInfo(id, userId);
      return res.status(200).json({ success: true, likeCount: info.count, liked: true });
    }

    if (action === 'unlike') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      await redis.srem(likesKey(id), userId);
      const info = await getLikeInfo(id, userId);
      return res.status(200).json({ success: true, likeCount: info.count, liked: false });
    }

    if (action === 'comment') {
      const { id, text, displayName } = body;
      if (!id || !text || !String(text).trim()) {
        return res.status(400).json({ success: false, error: 'Thiếu id/text' });
      }
      const comment = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        userId,
        displayName: displayName ? String(displayName).slice(0, 60) : 'Ẩn danh',
        text: String(text).slice(0, 500),
        date: Math.floor(Date.now() / 1000),
      };
      await redis.rpush(commentsKey(id), JSON.stringify(comment));
      return res.status(200).json({ success: true, comment });
    }

    if (action === 'listComments') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const raw = await redis.lrange(commentsKey(id), 0, -1);
      const comments = (raw || []).map((c) => {
        try { return typeof c === 'string' ? JSON.parse(c) : c; } catch (e) { return null; }
      }).filter(Boolean);
      return res.status(200).json({ success: true, comments });
    }

    if (action === 'deleteComment') {
      const { id, commentId } = body;
      if (!id || !commentId) return res.status(400).json({ success: false, error: 'Thiếu id/commentId' });
      const raw = await redis.lrange(commentsKey(id), 0, -1);
      const list = (raw || []).map((c) => {
        try { return typeof c === 'string' ? JSON.parse(c) : c; } catch (e) { return null; }
      }).filter(Boolean);
      const target = list.find((c) => c.id === commentId);
      if (!target) return res.status(404).json({ success: false, error: 'Không tìm thấy bình luận' });
      if (target.userId !== userId) {
        return res.status(403).json({ success: false, error: 'Không có quyền xoá bình luận này' });
      }
      const next = list.filter((c) => c.id !== commentId);
      await redis.del(commentsKey(id));
      if (next.length) {
        await redis.rpush(commentsKey(id), ...next.map((c) => JSON.stringify(c)));
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'setPref') {
      const { key, value } = body;
      if (!key) return res.status(400).json({ success: false, error: 'Thiếu key' });
      const prefs = await getPrefs(userId);
      prefs[key] = value !== undefined ? String(value) : '';
      const ok = await savePrefs(userId, prefs);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true });
    }

    if (action === 'getPrefs') {
      const prefs = await getPrefs(userId);
      return res.status(200).json({ success: true, prefs });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
