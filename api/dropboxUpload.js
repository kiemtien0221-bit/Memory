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

const QUOTA_BYTES = 100 * 1024 * 1024;   // 100MB/user
const MAX_FILES   = 5000;

const filesKey = (userId) => `dropbox:files:${userId}`;

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

function toPublicFile(it) {
  return {
    id: it.id,
    name: it.name,
    size: it.size,
    dropboxPath: it.dropboxPath,
    uploadDate: it.uploadDate,
    canEdit: true,
  };
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

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Thiếu userId' });
    }

    // ── Danh sách file ──────────────────────────────────────────────
    if (action === 'list') {
      const files = await getFiles(userId);
      return res.status(200).json({
        success: true,
        files: files.map(toPublicFile),
        quota: QUOTA_BYTES,
        maxFiles: MAX_FILES,
      });
    }

    // ── Ghi đè toàn bộ danh sách ────────────────────────────────────
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
        return res.status(400).json({ success: false, error: 'Vượt quá quota 100MB' });
      }
      const clean = files.map((f) => ({
        id: f.id,
        name: f.name ? String(f.name).slice(0, 300) : 'Unknown',
        dropboxPath: f.dropboxPath ? String(f.dropboxPath).slice(0, 500) : '',
        size: Number(f.size) || 0,
        uploadDate: f.uploadDate ? String(f.uploadDate) : '',
        ownerId: userId,
      }));
      const ok = await saveFiles(userId, clean);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, count: clean.length });
    }

    // ── Thêm 1 file ─────────────────────────────────────────────────
    if (action === 'add') {
      const { id, name, dropboxPath, size, uploadDate } = body;
      if (!id) {
        return res.status(400).json({ success: false, error: 'Thiếu id' });
      }
      const list = await getFiles(userId);
      if (list.some((f) => f.id === id)) {
        return res.status(200).json({ success: true, duplicate: true });
      }
      if (list.length >= MAX_FILES) {
        return res.status(400).json({ success: false, error: 'Đã đạt giới hạn 5000 file' });
      }
      const totalSize = list.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      const fsize = Number(size) || 0;
      if (totalSize + fsize > QUOTA_BYTES) {
        return res.status(400).json({ success: false, error: 'Vượt quá quota 100MB' });
      }
      const item = {
        id,
        name: name ? String(name).slice(0, 300) : 'Unknown',
        dropboxPath: dropboxPath ? String(dropboxPath).slice(0, 500) : '',
        size: fsize,
        uploadDate: uploadDate ? String(uploadDate) : '',
        ownerId: userId,
      };
      list.unshift(item);
      const ok = await saveFiles(userId, list);
      if (!ok) return res.status(500).json({ success: false, error: 'Lưu thất bại' });
      return res.status(200).json({ success: true, file: toPublicFile(item) });
    }

    // ── Xoá 1 file ──────────────────────────────────────────────────
    if (action === 'remove') {
      const { id } = body;
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });
      const list = await getFiles(userId);
      const next = list.filter((f) => f.id !== id);
      await saveFiles(userId, next);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Action không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
