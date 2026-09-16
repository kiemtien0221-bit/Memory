const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

const PREFIX = 'book:learn:';
const VERSION_KEY = 'book:learn:version';
const ADMIN_KEY = process.env.BOOK_ADMIN_KEY || '';
const KEY_RE = /^(?:[A-Za-z0-9_-]{3})*$/;
const MOVE_RE = /^[A-Za-z0-9_-]{3}$/;
const MAX_KEY = 231;

function json(res, code, body) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Book-Admin-Key');
  res.status(code).json(body);
}

function authorized(req) {
  if (!ADMIN_KEY) return false;
  return String(req.headers['x-book-admin-key'] || '') === ADMIN_KEY;
}

function bodyOf(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (_) { return {}; }
}

async function allKeys() {
  const out = [];
  let cursor = '0';
  do {
    const r = await redis.scan(cursor, { match: PREFIX + '*', count: 100 });
    cursor = String(r[0]);
    for (const k of (r[1] || [])) if (k !== VERSION_KEY) out.push(k);
  } while (cursor !== '0');
  return out;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized - set BOOK_ADMIN_KEY' });

  try {
    const body = bodyOf(req);
    if (body.format !== 'kami-xiangqi-learn-v1' || !body.positions || typeof body.positions !== 'object') {
      return json(res, 400, { ok: false, error: 'Invalid backup format' });
    }

    const rows = [];
    let moveCount = 0;
    for (const key of Object.keys(body.positions)) {
      if (!KEY_RE.test(key) || key.length > MAX_KEY) return json(res, 400, { ok: false, error: 'Invalid position key' });
      const moves = body.positions[key];
      if (!moves || typeof moves !== 'object') return json(res, 400, { ok: false, error: 'Invalid moves' });
      for (const move of Object.keys(moves)) {
        if (!MOVE_RE.test(move)) return json(res, 400, { ok: false, error: 'Invalid move' });
        const pair = moves[move];
        if (!Array.isArray(pair) || pair.length < 2) return json(res, 400, { ok: false, error: 'Invalid score/count' });
        const score = Number(pair[0]), count = Number(pair[1]);
        if (!Number.isInteger(score) || !Number.isInteger(count) || Math.abs(score) > 1000000000 || count < 0 || count > 1000000000) {
          return json(res, 400, { ok: false, error: 'Invalid score/count range' });
        }
        rows.push([key, move, score, count]);
        moveCount++;
        if (moveCount > 100000) return json(res, 413, { ok: false, error: 'Backup too large' });
      }
    }

    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    if (mode === 'replace') {
      const keys = await allKeys();
      for (const k of keys) await redis.del(k);
    }

    for (const [key, move, score, count] of rows) {
      const k = PREFIX + key;
      if (mode === 'replace') {
        if (score !== 0) await redis.hset(k, { [move + ':s']: score });
        if (count !== 0) await redis.hset(k, { [move + ':n']: count });
      } else {
        if (score !== 0) await redis.hincrby(k, move + ':s', score);
        if (count !== 0) await redis.hincrby(k, move + ':n', count);
      }
    }

    const version = Number(await redis.incr(VERSION_KEY));
    return json(res, 200, { ok: true, mode, positions: Object.keys(body.positions).length, moves: moveCount, version });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Import failed' });
  }
};
