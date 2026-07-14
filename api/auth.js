import { Redis } from '@upstash/redis';
import crypto from 'crypto';

let redis = null;
const REDIS_ENABLED = process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN;

if (REDIS_ENABLED) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  } catch (error) {
    console.error('❌ Redis initialization error:', error);
  }
}

// TTL constants (đồng bộ với chat.js)
const AUTH_TTL_SECONDS = 365 * 86400;      // 365 ngày - giống user:profile
const SESSION_TTL_SECONDS = 30 * 86400;    // 30 ngày - giống chat history
const MAPPING_TTL_SECONDS = 365 * 86400;   // 365 ngày - giống auth:user

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'kami_salt_2024').digest('hex');
}

function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

async function setData(key, value, ttl = null) {
  if (redis) {
    return ttl ? await redis.set(key, value, { ex: ttl }) : await redis.set(key, value);
  }
  return false;
}

async function getData(key) {
  if (redis) {
    return await redis.get(key);
  }
  return null;
}

async function setHashData(key, data, ttl = null) {
  if (redis) {
    await redis.hset(key, data);
    if (ttl) await redis.expire(key, ttl);
    return true;
  }
  return false;
}

async function getHashData(key) {
  if (redis) {
    return await redis.hgetall(key);
  }
  return {};
}

async function setExpire(key, ttl) {
  if (redis) {
    return await redis.expire(key, ttl);
  }
  return true;
}

// ============ AUTH HANDLER ============

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;

  // === POST /api/auth === Đăng nhập / Đăng ký
  if (req.method === 'POST' && !action) {
    const { username, password } = req.body;

    if (!username || !username.match(/^[a-zA-Z0-9_]{3,20}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Tên truy cập không hợp lệ (3-20 ký tự, chỉ chữ, số, _)'
      });
    }

    const usernameLower = username.toLowerCase();
    const userKey = `auth:user:${usernameLower}`;
    const existingUser = await getHashData(userKey);

    // === ĐĂNG NHẬP ===
    if (existingUser && existingUser.userId) {
      if (existingUser.passwordHash && password) {
        const inputHash = hashPassword(password);
        if (inputHash !== existingUser.passwordHash) {
          return res.status(401).json({
            success: false,
            error: 'Mật khẩu không đúng'
          });
        }
      }

      // Cập nhật lastLogin + refresh TTL
      await setHashData(userKey, {
        ...existingUser,
        lastLogin: Date.now().toString()
      }, AUTH_TTL_SECONDS);

      // Refresh TTL cho mapping userid -> username
      await setExpire(`auth:userid:${existingUser.userId}`, MAPPING_TTL_SECONDS);

      return res.status(200).json({
        success: true,
        userId: existingUser.userId,
        username: existingUser.username,
        message: 'Đăng nhập thành công!',
        isNew: false
      });
    }

    // === ĐĂNG KÝ MỚI ===
    const newUserId = generateUserId();
    const passwordHash = password ? hashPassword(password) : '';

    await setHashData(userKey, {
      userId: newUserId,
      username: usernameLower,
      displayName: username,
      passwordHash: passwordHash,
      createdAt: Date.now().toString(),
      lastLogin: Date.now().toString(),
      deviceCount: '1'
    }, AUTH_TTL_SECONDS);

    // Tạo mapping userId -> username với TTL 365 ngày
    await setData(`auth:userid:${newUserId}`, usernameLower, MAPPING_TTL_SECONDS);

    return res.status(200).json({
      success: true,
      userId: newUserId,
      username: usernameLower,
      message: 'Tạo tài khoản thành công!',
      isNew: true
    });
  }

  // === GET /api/auth/check?username=xxx === Kiểm tra session
  if (req.method === 'GET' && action === 'check') {
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu username'
      });
    }

    const usernameLower = username.toLowerCase();
    const userKey = `auth:user:${usernameLower}`;
    const userData = await getHashData(userKey);

    if (!userData || !userData.userId) {
      return res.status(404).json({
        success: false,
        error: 'Tài khoản không tồn tại',
        valid: false
      });
    }

    // Refresh TTL khi check session (giữ account active)
    await setExpire(userKey, AUTH_TTL_SECONDS);
    await setExpire(`auth:userid:${userData.userId}`, MAPPING_TTL_SECONDS);

    return res.status(200).json({
      success: true,
      valid: true,
      userId: userData.userId,
      username: userData.username,
      lastLogin: userData.lastLogin
    });
  }

  // === POST /api/auth/change-password === Đổi mật khẩu
  if (req.method === 'POST' && action === 'change-password') {
    const { username, oldPassword, newPassword } = req.body;

    if (!username || !oldPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu thông tin'
      });
    }

    const usernameLower = username.toLowerCase();
    const userKey = `auth:user:${usernameLower}`;
    const userData = await getHashData(userKey);

    if (!userData || !userData.userId) {
      return res.status(404).json({
        success: false,
        error: 'Tài khoản không tồn tại'
      });
    }

    const oldHash = hashPassword(oldPassword);
    if (userData.passwordHash && userData.passwordHash !== oldHash) {
      return res.status(401).json({
        success: false,
        error: 'Mật khẩu cũ không đúng'
      });
    }

    const newHash = hashPassword(newPassword);
    await setHashData(userKey, {
      ...userData,
      passwordHash: newHash
    }, AUTH_TTL_SECONDS);

    return res.status(200).json({
      success: true,
      message: 'Đổi mật khẩu thành công!'
    });
  }

  // === GET /api/auth/profile?username=xxx === Lấy thông tin profile
  if (req.method === 'GET' && action === 'profile') {
    const { username } = req.query;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Thiếu username'
      });
    }

    const usernameLower = username.toLowerCase();
    const userKey = `auth:user:${usernameLower}`;
    const userData = await getHashData(userKey);

    if (!userData || !userData.userId) {
      return res.status(404).json({
        success: false,
        error: 'Không tìm thấy tài khoản'
      });
    }

    const { passwordHash, ...safeData } = userData;

    return res.status(200).json({
      success: true,
      profile: safeData
    });
  }

  return res.status(405).json({
    success: false,
    error: 'Method not allowed'
  });
}
