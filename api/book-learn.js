const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

const PREFIX = 'book:learn:';
const VERSION_KEY = 'book:learn:version';
const RL_PREFIX = 'book:learn:rl:';
const EVENT_PREFIX = 'book:learn-event:';
const EVENT_TTL = 31536000;
const MAX_BATCH = 500;
const MAX_KEY = 231; // 77 plies * 3 chars
const MOVE_RE = /^[A-Za-z0-9_-]{3}$/;
const KEY_RE = /^(?:[A-Za-z0-9_-]{3})*$/;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, body) {
  cors(res);
  res.status(code).json(body);
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
}

function clientIp(req) {
  const x = req.headers['x-forwarded-for'];
  return String(x || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
}

async function rateLimit(req) {
  const k = RL_PREFIX + clientIp(req) + ':' + Math.floor(Date.now() / 60000);
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 70);
  return n <= 120;
}

async function getAllLearned() {
  const out = {};
  let cursor = '0';
  do {
    const r = await redis.scan(cursor, { match: PREFIX + '*', count: 100 });
    cursor = String(r[0]);
    const keys = r[1] || [];
    for (const key of keys) {
      if (key === VERSION_KEY || key.startsWith(RL_PREFIX)) continue;
      const pos = key.slice(PREFIX.length);
      if (!KEY_RE.test(pos)) continue;
      const h = await redis.hgetall(key);
      const moves = {};
      if (h) {
        for (const field of Object.keys(h)) {
          if (!field.endsWith(':s')) continue;
          const mv = field.slice(0, -2);
          if (!MOVE_RE.test(mv)) continue;
          const score = Number(h[field]) || 0;
          const count = Number(h[mv + ':n']) || 0;
          if (score !== 0 || count > 0) moves[mv] = [score, count];
        }
      }
      if (Object.keys(moves).length) out[pos] = moves;
    }
  } while (cursor !== '0');
  return out;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  try {
    if (req.method === 'GET') {
      const current = Number(await redis.get(VERSION_KEY) || 0);
      const since = Number(req.query?.version || 0);
      if (since === current && since > 0) return json(res, 200, { ok: true, changed: false, version: current });
      const positions = await getAllLearned();
      return json(res, 200, { ok: true, changed: true, version: current, positions });
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
    if (!(await rateLimit(req))) return json(res, 429, { ok: false, error: 'Rate limit' });

    const body = bodyOf(req);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > MAX_BATCH) return json(res, 400, { ok: false, error: 'items 1..500' });

    let accepted = 0;
    for (const it of items) {
      const key = String(it?.key || '');
      const move = String(it?.move || '');
      const id = String(it?.id || '');
      let delta = Number(it?.delta);
      if (!KEY_RE.test(key) || key.length > MAX_KEY || !MOVE_RE.test(move) || !Number.isInteger(delta)) continue;
      if (id && !/^[A-Za-z0-9_-]{8,120}$/.test(id)) continue;
      delta = Math.max(-3, Math.min(3, delta));
      if (delta === 0) continue;
      if (id) {
        const fresh = await redis.set(EVENT_PREFIX + id, '1', { nx: true, ex: EVENT_TTL });
        if (fresh !== 'OK') continue;
      }
      const redisKey = PREFIX + key;
      await redis.hincrby(redisKey, move + ':s', delta);
      await redis.hincrby(redisKey, move + ':n', 1);
      accepted++;
    }

    const version = accepted ? Number(await redis.incr(VERSION_KEY)) : Number(await redis.get(VERSION_KEY) || 0);
    return json(res, 200, { ok: true, accepted, version });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Server error' });
  }
};
