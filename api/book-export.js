const { Redis } = require('@upstash/redis');
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

const PREFIX = 'book:learn:';
const VERSION_KEY = 'book:learn:version';
const ADMIN_KEY = process.env.BOOK_ADMIN_KEY || '';

function json(res, code, body) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Book-Admin-Key');
  res.status(code).json(body);
}

function authorized(req) {
  if (!ADMIN_KEY) return true;
  return String(req.headers['x-book-admin-key'] || '') === ADMIN_KEY;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'Method not allowed' });
  if (!authorized(req)) return json(res, 401, { ok: false, error: 'Unauthorized - set BOOK_ADMIN_KEY' });
  try {
    const positions = {};
    let cursor = '0';
    do {
      const r = await redis.scan(cursor, { match: PREFIX + '*', count: 100 });
      cursor = String(r[0]);
      for (const key of (r[1] || [])) {
        if (key === VERSION_KEY) continue;
        const pos = key.slice(PREFIX.length);
        const h = await redis.hgetall(key);
        const moves = {};
        if (h) {
          for (const f of Object.keys(h)) {
            if (!f.endsWith(':s')) continue;
            const mv = f.slice(0, -2);
            moves[mv] = [Number(h[f]) || 0, Number(h[mv + ':n']) || 0];
          }
        }
        if (Object.keys(moves).length) positions[pos] = moves;
      }
    } while (cursor !== '0');

    const version = Number(await redis.get(VERSION_KEY) || 0);
    return json(res, 200, {
      ok: true,
      format: 'kami-xiangqi-learn-v1',
      exportedAt: new Date().toISOString(),
      version,
      positions
    });
  } catch (e) {
    console.error(e);
    return json(res, 500, { ok: false, error: 'Export failed' });
  }
};
