import Groq from 'groq-sdk';
import { Redis } from '@upstash/redis';

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

const memoryStore = new Map();

function maybeCleanupMemoryStore() {
  if (!REDIS_ENABLED && memoryStore.size > 1000 && Math.random() < 0.01) {
    const entries = [...memoryStore.entries()];
    memoryStore.clear();
    entries.slice(-500).forEach(([k, v]) => memoryStore.set(k, v));
    console.log('🧹 Cleaned memoryStore');
  }
}

class SimpleCache {
  constructor(ttl = 600000, maxSize = 100) {
    this.cache = new Map();
    this.ttl = ttl;
    this.maxSize = maxSize;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;
    const age = Date.now() - item.timestamp;
    if (age > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }
}

const SEARCH_CONFIG = {
  CACHE_TTL_MINUTES: 30,
  DETECTION_CACHE_TTL_MINUTES: 60
};

const searchCache = new SimpleCache(SEARCH_CONFIG.CACHE_TTL_MINUTES * 60000, 100);
const detectionCache = new SimpleCache(SEARCH_CONFIG.DETECTION_CACHE_TTL_MINUTES * 60000, 200);
const responseCache = new SimpleCache(5 * 60000, 50);

const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
  process.env.GROQ_API_KEY_7,
  process.env.GROQ_API_KEY_8,
  process.env.GROQ_API_KEY_9,
  process.env.GROQ_API_KEY_10
].filter(key => key);

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

const MEMORY_CONFIG = {
  SHORT_TERM_DAYS: 30,
  WORKING_MEMORY_LIMIT: 10,
  LONG_TERM_DAYS: 365,
  SUMMARY_THRESHOLD: 40,
  MAX_SUMMARIES: 30,
  MAX_MESSAGES: 1000,
  SUMMARY_CONTEXT_LIMIT: 15
};

const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ============ SUPABASE FORUM CONFIG ============
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let forumCategoriesCache = null;
let forumCategoriesCacheTime = 0;
const FORUM_CAT_CACHE_TTL = 10 * 60 * 1000;
const forumSearchCache = new SimpleCache(10 * 60000, 50);
const MAX_FORUM_CHARS = 2000;

function getSupabaseHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json'
  };
}

// ============ DYNAMIC CATEGORY SYSTEM ============
async function fetchForumCategories() {
  const now = Date.now();
  if (forumCategoriesCache && (now - forumCategoriesCacheTime) < FORUM_CAT_CACHE_TTL) {
    return forumCategoriesCache;
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('⚠ Supabase not configured for forum');
    return [];
  }
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/forum_categories?select=id,name,icon,description,keywords&order=sort_order.asc`,
      { headers: getSupabaseHeaders() }
    );
    if (!r.ok) throw new Error('Forum categories fetch failed');
    const data = await r.json();
    forumCategoriesCache = data || [];
    forumCategoriesCacheTime = now;
    console.log(`📚 Loaded ${forumCategoriesCache.length} forum categories`);
    return forumCategoriesCache;
  } catch (e) {
    console.error('❌ Forum categories error:', e.message);
    return [];
  }
}

function buildCategoryKeywordMap(categories) {
  const map = {};
  for (const cat of categories) {
    const keywords = cat.keywords || cat.name;
    const patterns = keywords.split(',').map(k => k.trim()).filter(k => k.length > 0);
    if (patterns.length > 0) {
      map[cat.id] = {
        ...cat,
        patterns: patterns.map(p => new RegExp(`\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'i'))
      };
    }
  }
  return map;
}

function quickForumDetect(message, categories) {
  const lower = message.toLowerCase();
  const keywordMap = buildCategoryKeywordMap(categories);

  for (const [catId, catData] of Object.entries(keywordMap)) {
    for (const pattern of catData.patterns) {
      if (pattern.test(lower)) {
        return { matchedCategory: catData, confidence: 0.75 };
      }
    }
  }
  return { matchedCategory: null, confidence: 0 };
}

async function matchForumCategory(message, groq, categories) {
  if (categories.length === 0) return { matchedCategory: null, confidence: 0 };

  const catList = categories.map(c => `${c.id}:${c.name}`).join(', ');

  try {
    const response = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Bạn là bộ lọc chủ đề. Người dùng đang hỏi một câu hỏi. Hãy xác định câu hỏi này có khớp với danh mục nào trong diễn đàn kiến thức không.\n\nCác danh mục diễn đàn: ${catList}\n\nTrả về JSON: {\"categoryId\": number|null, \"confidence\": number}\n- categoryId: ID danh mục khớp nhất, hoặc null nếu không khớp\n- confidence: 0-1, chỉ trả >0.7 nếu thực sự khớp chủ đề\n\nVí dụ: \"cách nấu cơm\" → mẹo vặt. \"Bitcoin là gì\" → kiến thức chung. \"chào bạn\" → null.`
        },
        {
          role: 'user',
          content: `Câu hỏi: "${message}"`
        }
      ],
      model: 'openai/gpt-oss-20b',
      temperature: 0,
      max_tokens: 100,
      response_format: { type: "json_object" },
      reasoning_effort: 'low',
      include_reasoning: false
    });

    const result = safeParseJSON(response.choices[0]?.message?.content || '{}');
    const matched = categories.find(c => c.id === result.categoryId);

    if (matched && result.confidence >= 0.7) {
      console.log(`🎯 Forum category matched: ${matched.name} (confidence: ${result.confidence})`);
      return { matchedCategory: matched, confidence: result.confidence };
    }
    return { matchedCategory: null, confidence: 0 };
  } catch (e) {
    console.error('Forum category match error:', e.message);
    return { matchedCategory: null, confidence: 0 };
  }
}

async function searchForumKnowledge(categoryId, queryText, maxResults = 5) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  const cacheKey = `forum:${categoryId}:${normalizeForCache(queryText || '')}`;
  const cached = forumSearchCache.get(cacheKey);
  if (cached) {
    console.log('💾 Forum search cache hit');
    return cached;
  }

  const cleanQuery = (queryText || '').trim();
  if (!cleanQuery) {
    console.log('⚠ Empty query, skip forum search');
    return null;
  }

  try {
    // Dùng RPC search_forum_content() có sẵn trong schema (FTS + ts_rank,
    // dùng GIN index idx_forum_posts_fts / idx_forum_comments_fts) thay vì
    // tự query ilike + tự chấm điểm ở JS — 1 round-trip, đã sắp theo rank.
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_forum_content`, {
      method: 'POST',
      headers: getSupabaseHeaders(),
      body: JSON.stringify({
        search_query: cleanQuery,
        p_category_id: categoryId || null,
        p_limit: maxResults
      })
    });

    if (!r.ok) {
      console.error('❌ Forum RPC search error:', await r.text());
      return null;
    }

    const rows = await r.json();
    if (!rows.length) {
      console.log(`⚠ No forum content match query: "${cleanQuery}"`);
      return null;
    }

    const result = {
      source: 'KamiForum',
      categoryId,
      items: rows.map(row => ({
        id: row.id,
        title: row.type === 'post' ? row.title : `💬 ${row.title}`,
        content: (row.content || '').slice(0, 500),
        author: row.author || row.username || 'Ẩn danh',
        date: row.created_at,
        type: row.type,
        viewCount: row.view_count || 0,
        commentCount: row.comment_count || 0
      }))
    };

    forumSearchCache.set(cacheKey, result);
    console.log(`✅ Forum knowledge (RPC): ${rows.length} items for "${cleanQuery}"`);
    return result;
  } catch (e) {
    console.error('❌ Forum search error:', e.message);
    return null;
  }
}

const DETECTION_PATTERNS = {
  never: /^(chào|hello|hi|xin chào|hey|cảm ơn|thank|thanks|tạm biệt|bye|goodbye|ok|okay|được|rồi|ừ|uhm)$/i,
  explicit: /(tìm kiếm|search|tra cứu|google|tìm đi|tìm lại|tìm giúp|tra giúp)/i,
  realtime: /(giá bitcoin|giá vàng|giá dầu|giá xăng|tỷ giá|thời tiết|nhiệt độ|tin tức mới nhất|tin tức hôm nay)/i,
  current: /(hiện nay|hiện tại|bây giờ|hôm nay|năm nay|mới nhất|gần đây|vừa rồi|ai là|là ai)/i,
  concept: /^.*(là gì|nghĩa là gì|định nghĩa|ý nghĩa|giải thích|cho.*biết về|nói về)/i,
  advice: /^(nên|có nên|tôi nên|làm sao|làm thế nào|bạn nghĩ|theo bạn|ý kiến)/i
};

const IS_DEV = process.env.NODE_ENV === 'development';
const stats = IS_DEV ? {
  search: { total: 0, cacheHits: 0 },
  perf: { responseCacheHits: 0, totalRequests: 0, totalResponseTime: 0 }
} : null;

function normalizeForCache(message) {
  return message
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:]/g, '')
    .replace(/\s+/g, ' ')
    .substring(0, 200);
}

function normalizeSearchResult(raw) {
  if (!raw) return null;
  return {
    source: raw.source || 'Unknown',
    content: raw.content || raw.results?.[0]?.content || '',
    results: raw.results || []
  };
}

async function setData(key, value, ttl = null) {
  if (redis) {
    return ttl ? await redis.set(key, value, { ex: ttl }) : await redis.set(key, value);
  } else {
    memoryStore.set(key, { value, expires: ttl ? Date.now() + ttl * 1000 : null });
    return true;
  }
}

async function getData(key) {
  if (redis) {
    return await redis.get(key);
  } else {
    const item = memoryStore.get(key);
    if (!item) return null;
    if (item.expires && Date.now() > item.expires) {
      memoryStore.delete(key);
      return null;
    }
    return item.value;
  }
}

async function setHashData(key, data, ttl = null) {
  if (redis) {
    await redis.hset(key, data);
    if (ttl) await redis.expire(key, ttl);
    return true;
  } else {
    memoryStore.set(key, { value: data, expires: ttl ? Date.now() + ttl * 1000 : null });
    return true;
  }
}

async function getHashData(key) {
  if (redis) {
    return await redis.hgetall(key);
  } else {
    const item = memoryStore.get(key);
    if (!item) return {};
    if (item.expires && Date.now() > item.expires) {
      memoryStore.delete(key);
      return {};
    }
    return item.value || {};
  }
}

async function setExpire(key, ttl) {
  if (redis) {
    return await redis.expire(key, ttl);
  }
  return true;
}

function safeParseJSON(text, fallback = {}) {
  try {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/```json\n?/g, '');
    cleaned = cleaned.replace(/```\n?/g, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    }
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('JSON parse error:', error.message);
    return fallback;
  }
}

function stripThinking(content) {
  if (!content || typeof content !== 'string') return content;

  content = content.replace(/<think[\s\S]*?<\/think>/gi, '');

  const transitionMarkers = [
    /Drafting the response[\s\S]*?:[\s\n]*/i,
    /Final Polish[\s\S]*?:[\s\n]*/i,
    /Refining[\s\S]*?:[\s\n]*/i,
    /Synthesizing[\s\S]*?:[\s\n]*/i,
    /Answer:[\s\n]*/i,
    /Kết luận:[\s\n]*/i,
    /Trả lời:[\s\n]*/i,
  ];

  let lastMarkerEnd = -1;
  for (const marker of transitionMarkers) {
    const match = content.match(marker);
    if (match) {
      const idx = content.lastIndexOf(match[0]);
      const endIdx = idx + match[0].length;
      if (endIdx > lastMarkerEnd) {
        lastMarkerEnd = endIdx;
      }
    }
  }

  if (lastMarkerEnd !== -1) {
    content = content.substring(lastMarkerEnd);
  } else {
    const vnMatch = content.match(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ][\s\S]*/);
    if (vnMatch) {
      const vnIdx = content.indexOf(vnMatch[0]);
      if (vnIdx > 200) {
        content = vnMatch[0];
      }
    }
  }

  content = content.replace(/\*\*/g, '');
  content = content.replace(/^[-•]\s+/gm, '');
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  const vnStart = content.search(/[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/);
  if (vnStart > 50) {
    content = content.substring(vnStart);
  }

  return content.trim();
}

async function retryWithBackoff(fn, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
    }
  }
}

async function searchWithRetry(searchFn, name) {
  try {
    return await retryWithBackoff(searchFn);
  } catch (error) {
    console.error(`${name} error:`, error.message);
    return null;
  }
}

// Helper: fetch với timeout (thay cho axios timeout) + tự parse JSON
async function fetchJSON(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ============ WEB SEARCH SOURCES ============
const searchDuckDuckGo = (query) => searchWithRetry(async () => {
  const qs = new URLSearchParams({ q: query, format: 'json', no_html: '1', skip_disambig: '1' });
  const data = await fetchJSON(`https://api.duckduckgo.com/?${qs}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kami/1.0)' }
  });

  if (data.Abstract) {
    return {
      source: 'DuckDuckGo',
      title: data.Heading || query,
      content: data.Abstract,
      url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
    };
  }
  if (data.RelatedTopics && data.RelatedTopics.length > 0) {
    const firstTopic = data.RelatedTopics[0];
    if (firstTopic.Text) {
      return {
        source: 'DuckDuckGo',
        title: firstTopic.Text.split(' - ')[0] || query,
        content: firstTopic.Text,
        url: firstTopic.FirstURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
      };
    }
  }
  return null;
}, 'DuckDuckGo');

const searchWikipedia = (query) => searchWithRetry(async () => {
  const searchQs = new URLSearchParams({ action: 'query', list: 'search', srsearch: query, srlimit: '1', format: 'json', origin: '*' });
  const searchData = await fetchJSON(`https://vi.wikipedia.org/w/api.php?${searchQs}`, {
    headers: { 'User-Agent': 'KamiApp/1.0' }
  });

  const results = searchData?.query?.search;
  if (!results || results.length === 0) return null;

  const title = results[0].title;
  const extractQs = new URLSearchParams({ action: 'query', prop: 'extracts', titles: title, exintro: 'true', explaintext: 'true', exsectionformat: 'plain', format: 'json', origin: '*' });
  const extractData = await fetchJSON(`https://vi.wikipedia.org/w/api.php?${extractQs}`, {
    headers: { 'User-Agent': 'KamiApp/1.0' }
  });

  const pages = extractData?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  if (!page?.extract) return null;

  const content = page.extract.substring(0, 600).trim();
  if (content.length < 50) return null;

  return {
    source: 'Wikipedia',
    title: title,
    content: content,
    url: `https://vi.wikipedia.org/wiki/${encodeURIComponent(title)}`
  };
}, 'Wikipedia');

const searchSerper = (query) => {
  if (!SERPER_API_KEY) return null;
  return searchWithRetry(async () => {
    const data = await fetchJSON('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'vn', hl: 'vi', num: 3 })
    });

    const results = data.organic || [];
    if (results.length === 0) return null;

    return {
      source: 'Serper',
      results: results.map(r => ({ title: r.title, content: r.snippet, url: r.link }))
    };
  }, 'Serper');
};

const searchTavily = (query) => {
  if (!TAVILY_API_KEY) return null;
  return searchWithRetry(async () => {
    const data = await fetchJSON('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_API_KEY, query: query, search_depth: 'basic', include_answer: true, max_results: 3 })
    });

    return {
      source: 'Tavily',
      content: data.answer,
      results: data.results?.map(r => ({ title: r.title, content: r.content, url: r.url }))
    };
  }, 'Tavily');
};

// ============ UNIFIED SMART SEARCH (FORUM FIRST) ============
async function smartSearch(query, searchType, forumResult = null) {
  const cacheKey = normalizeForCache(query);
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.log(`✅ Search cache hit`);
    return cached;
  }

  console.log(`🔍 Search type: ${searchType}`);
  let result = null;

  // 1. FORUM FIRST - Nếu đã có forumResult từ trước, dùng luôn
  if (forumResult) {
    console.log(`✅ Using forum knowledge (${forumResult.items?.length} items)`);
    searchCache.set(cacheKey, forumResult);
    return forumResult;
  }

  // 2. Nếu chưa có forum result, thử tìm forum trước
  const categories = await fetchForumCategories();
  const quickForum = quickForumDetect(query, categories);
  if (quickForum.matchedCategory) {
    const forumRes = await searchForumKnowledge(quickForum.matchedCategory.id, query, 3);
    if (forumRes) {
      console.log(`✅ Forum search success: ${forumRes.items?.length} items`);
      searchCache.set(cacheKey, forumRes);
      return forumRes;
    }
  }

  // 3. Web search fallback
  const isRealtime = searchType === 'realtime';

  if (!isRealtime) {
    console.log(`🔍 Trying DuckDuckGo...`);
    result = await searchDuckDuckGo(query);
    if (result) {
      console.log(`✅ DuckDuckGo success`);
      const normalized = normalizeSearchResult(result);
      searchCache.set(cacheKey, normalized);
      return normalized;
    }
    console.log(`❌ DuckDuckGo failed`);

    console.log(`🔍 Trying Wikipedia...`);
    result = await searchWikipedia(query);
    if (result) {
      console.log(`✅ Wikipedia success`);
      const normalized = normalizeSearchResult(result);
      searchCache.set(cacheKey, normalized);
      return normalized;
    }
    console.log(`❌ Wikipedia failed`);
  }

  if (SERPER_API_KEY) {
    console.log(`🔍 Trying Serper...`);
    result = await searchSerper(query);
    if (result) {
      console.log(`✅ Serper success`);
      const normalized = normalizeSearchResult(result);
      searchCache.set(cacheKey, normalized);
      return normalized;
    }
    console.log(`❌ Serper failed`);
  }

  if (TAVILY_API_KEY) {
    console.log(`🔍 Trying Tavily...`);
    result = await searchTavily(query);
    if (result) {
      console.log(`✅ Tavily success`);
      const normalized = normalizeSearchResult(result);
      searchCache.set(cacheKey, normalized);
      return normalized;
    }
    console.log(`❌ Tavily failed`);
  }

  console.log(`❌ All search sources failed`);
  return null;
}

// ============ DETECTION ============
function quickDetect(message) {
  const lower = message.toLowerCase().trim();

  if (DETECTION_PATTERNS.never.test(lower)) {
    return { needsSearch: false, confidence: 1.0, reason: 'casual' };
  }
  if (DETECTION_PATTERNS.explicit.test(lower)) {
    return { needsSearch: true, confidence: 1.0, type: 'search' };
  }
  if (DETECTION_PATTERNS.realtime.test(lower)) {
    return { needsSearch: true, confidence: 1.0, type: 'realtime' };
  }
  if (DETECTION_PATTERNS.current.test(lower)) {
    return { needsSearch: true, confidence: 0.9, type: 'knowledge' };
  }
  if (DETECTION_PATTERNS.concept.test(lower)) {
    const commonTopics = /(python|javascript|lập trình|code|toán|vật lý|hóa|sinh|văn|nghệ thuật)/i;
    if (commonTopics.test(lower)) {
      return { needsSearch: false, confidence: 0.9 };
    }
  }
  if (DETECTION_PATTERNS.advice.test(lower)) {
    return { needsSearch: false, confidence: 0.85 };
  }
  return { needsSearch: false, confidence: 0.5 };
}

async function shouldSearch(message, groq) {
  if (IS_DEV) stats.search.total++;

  const cacheKey = normalizeForCache(message);
  const cached = detectionCache.get(cacheKey);
  if (cached) {
    if (IS_DEV) stats.search.cacheHits++;
    console.log(`💾 Detection cache hit`);
    return cached;
  }

  console.log(`🤖 Using AI detection`);
  try {
    const response = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Return JSON only: {needsSearch: boolean, type: string}' },
        { role: 'user', content: `Need internet search? "${message}"` }
      ],
      model: 'openai/gpt-oss-20b',
      temperature: 0,
      max_tokens: 100,
      response_format: { type: "json_object" },
      reasoning_effort: 'low',
      include_reasoning: false
    });

    const result = safeParseJSON(response.choices[0]?.message?.content || '{}');
    const aiDecision = { needsSearch: result.needsSearch || false, confidence: 0.9, type: result.type || 'knowledge' };
    detectionCache.set(cacheKey, aiDecision);
    return aiDecision;
  } catch (error) {
    console.error('AI detection error:', error);
    const fallback = { needsSearch: false, confidence: 0.5 };
    detectionCache.set(cacheKey, fallback);
    return fallback;
  }
}

// ============ MEMORY ============
function validateHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(msg => msg && msg.role && msg.content && typeof msg.content === 'string');
}

async function getShortTermMemory(userId, conversationId) {
  const key = `chat:${userId}:${conversationId}`;
  const history = await getData(key);
  if (!history) return [];
  if (typeof history === 'string') {
    try { return JSON.parse(history); } catch { return []; }
  }
  return Array.isArray(history) ? history : [];
}

async function saveShortTermMemory(userId, conversationId, history) {
  const key = `chat:${userId}:${conversationId}`;
  const data = Array.isArray(history) ? JSON.stringify(history) : history;
  await setData(key, data, MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

async function getLongTermMemory(userId) {
  const key = `user:profile:${userId}`;
  const profile = await getHashData(key);
  if (profile && Object.keys(profile).length > 0) {
    await setExpire(key, MEMORY_CONFIG.LONG_TERM_DAYS * 86400);
  }
  return profile || {};
}

async function saveLongTermMemory(userId, profileData) {
  const key = `user:profile:${userId}`;
  await setHashData(key, profileData, MEMORY_CONFIG.LONG_TERM_DAYS * 86400);
}

async function getSummaries(userId, conversationId) {
  const key = `summaries:${userId}:${conversationId}`;
  const data = await getData(key);
  if (!data) return [];
  try {
    const summaries = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(summaries) ? summaries : [];
  } catch { return []; }
}

async function saveSummaries(userId, conversationId, summaries) {
  const key = `summaries:${userId}:${conversationId}`;
  await setData(key, JSON.stringify(summaries), MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

async function createNewSummary(groq, messages, summaryNumber) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: 'Hãy tóm tắt 40 tin nhắn sau thành 3-4 câu ngắn gọn, giữ lại thông tin quan trọng, sự kiện chính và mạch lạc cuộc trò chuyện.' },
        { role: 'user', content: `Tóm tắt phần ${summaryNumber}:\n${JSON.stringify(messages)}` }
      ],
      model: 'openai/gpt-oss-20b',
      temperature: 0.3,
      max_tokens: 400,
      reasoning_effort: 'low',
      include_reasoning: false
    });
    return chatCompletion.choices[0]?.message?.content || '';
  } catch (error) {
    console.error('Error creating summary:', error);
    return `[Summary ${summaryNumber}] Cuộc trò chuyện tiếp diễn...`;
  }
}

async function manageMemory(userId, conversationId, conversationHistory, groq) {
  if (conversationHistory.length > MEMORY_CONFIG.MAX_MESSAGES) {
    const messagesToRemove = conversationHistory.length - MEMORY_CONFIG.MAX_MESSAGES;
    conversationHistory.splice(0, messagesToRemove);
    console.log(`🗑 Removed ${messagesToRemove} old messages, keeping ${MEMORY_CONFIG.MAX_MESSAGES}`);
  }

  const currentTotal = conversationHistory.length;
  const summaries = await getSummaries(userId, conversationId);
  const messagesProcessed = summaries.length * MEMORY_CONFIG.SUMMARY_THRESHOLD;
  const unprocessedMessages = currentTotal - messagesProcessed;

  if (unprocessedMessages >= MEMORY_CONFIG.SUMMARY_THRESHOLD) {
    const startIdx = messagesProcessed;
    const endIdx = startIdx + MEMORY_CONFIG.SUMMARY_THRESHOLD;
    const messagesToSummarize = conversationHistory.slice(startIdx, endIdx);
    const summaryNumber = summaries.length + 1;
    console.log(`📝 Creating summary ${summaryNumber} from messages ${startIdx}-${endIdx}...`);

    const newSummary = await createNewSummary(groq, messagesToSummarize, summaryNumber);
    summaries.push({
      number: summaryNumber,
      content: newSummary,
      messageRange: `${startIdx + 1}-${endIdx}`,
      createdAt: new Date().toISOString()
    });

    if (summaries.length > MEMORY_CONFIG.MAX_SUMMARIES) {
      const removed = summaries.shift();
      console.log(`🗑 Removed oldest summary #${removed.number}, keeping ${MEMORY_CONFIG.MAX_SUMMARIES}`);
    }

    await saveSummaries(userId, conversationId, summaries);
    console.log(`✅ Summary ${summaryNumber} created. Total summaries: ${summaries.length}`);
  }

  return summaries;
}

function buildContext(conversationHistory, summaries) {
  const recentMessages = conversationHistory.slice(-MEMORY_CONFIG.WORKING_MEMORY_LIMIT);
  const recentSummaries = summaries.slice(-MEMORY_CONFIG.SUMMARY_CONTEXT_LIMIT);

  return {
    recentMessages,
    recentSummaries,
    contextInfo: {
      totalMessages: conversationHistory.length,
      totalSummaries: summaries.length,
      messagesInContext: recentMessages.length,
      summariesInContext: recentSummaries.length
    }
  };
}

async function extractPersonalInfo(groq, conversationHistory) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: `Trích xuất thông tin cá nhân từ cuộc hội thoại (nếu có) theo format JSON:\n{\n  "name": "tên người dùng",\n  "nickname": "tên thường gọi",\n  "family": "thông tin gia đình",\n  "age": "tuổi",\n  "job": "nghề nghiệp",\n  "hobbies": "sở thích",\n  "location": "nơi ở",\n  "other": "thông tin khác"\n}\nChỉ trả về JSON, không có text thừa. Nếu không có thông tin nào thì trả về {}.` },
        { role: 'user', content: JSON.stringify(conversationHistory.slice(-10)) }
      ],
      model: 'openai/gpt-oss-20b',
      temperature: 0.1,
      max_tokens: 500,
      reasoning_effort: 'low',
      include_reasoning: false
    });

    const result = chatCompletion.choices[0]?.message?.content || '{}';
    return safeParseJSON(result, {});
  } catch (error) {
    console.error('Error extracting info:', error);
    return {};
  }
}

async function shouldExtractNow(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  const lastExtract = await getData(key);
  if (!lastExtract) return conversationHistory.length >= 5;

  try {
    const lastExtractData = typeof lastExtract === 'string' ? JSON.parse(lastExtract) : lastExtract;
    const timeSince = Date.now() - lastExtractData.timestamp;
    const messagesSince = conversationHistory.length - lastExtractData.messageCount;
    return (timeSince > 300000 && messagesSince >= 3) || messagesSince >= 10;
  } catch {
    return conversationHistory.length >= 5;
  }
}

async function markExtracted(userId, conversationId, conversationHistory) {
  const key = `last_extract:${userId}:${conversationId}`;
  await setData(key, JSON.stringify({
    timestamp: Date.now(),
    messageCount: conversationHistory.length,
    extractedAt: new Date().toISOString()
  }), MEMORY_CONFIG.SHORT_TERM_DAYS * 86400);
}

function mergeProfile(currentProfile, newInfo) {
  const updated = { ...currentProfile };
  for (const [key, value] of Object.entries(newInfo)) {
    if (!value || value === 'null' || value === 'undefined') continue;
    const val = typeof value === 'string' ? value.trim() : value;
    if (val && val !== 'không có' && val !== 'chưa có') {
      updated[key] = val;
    }
  }
  return updated;
}

// ============ GROQ KEY ROTATION ============
function getRandomKeyIndex() {
  return Math.floor(Math.random() * API_KEYS.length);
}

function getNextKeyIndex(currentIndex) {
  return (currentIndex + 1) % API_KEYS.length;
}

async function getUserKeyIndex(userId) {
  const key = `keyindex:${userId}`;
  let index = await getData(key);
  if (index === null) {
    index = getRandomKeyIndex();
    await setData(key, index, 86400);
  }
  return parseInt(index);
}

async function setUserKeyIndex(userId, index) {
  const key = `keyindex:${userId}`;
  await setData(key, index, 86400);
}

function isTooLargeError(error) {
  return (
    error.status === 413 ||
    error.message?.includes('Request too large') ||
    error.message?.includes('reduce your message size')
  );
}

function isQuotaOrRateError(error) {
  return (
    error.message?.includes('quota') ||
    error.message?.includes('rate limit') ||
    error.message?.includes('Rate limit') ||
    error.message?.includes('rate_limit') ||
    error.code === 'rate_limit_exceeded' ||
    error.status === 429 ||
    error.status === 403
  );
}

function shrinkMessages(messages) {
  const hasSystem = messages[0]?.role === 'system';
  const systemMsg = hasSystem ? messages[0] : null;
  const rest = hasSystem ? messages.slice(1) : messages;
  const keep = Math.max(1, Math.ceil(rest.length / 2));
  const shrunk = rest.slice(-keep);
  return systemMsg ? [systemMsg, ...shrunk] : shrunk;
}

async function callGroqWithRetry(userId, messages) {
  let currentKeyIndex = await getUserKeyIndex(userId);
  let attempts = 0;
  const maxAttempts = API_KEYS.length;
  let shrinkAttempts = 0;
  const maxShrinkAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const apiKey = API_KEYS[currentKeyIndex];
      const groq = new Groq({ apiKey });

      const chatCompletion = await groq.chat.completions.create({
        messages,
        model: 'openai/gpt-oss-120b',
        temperature: 0.7,
        max_tokens: 1200,
        top_p: 0.9,
        stream: false,
        reasoning_effort: 'low',
        include_reasoning: false
      });

      await setUserKeyIndex(userId, currentKeyIndex);
      return chatCompletion;

    } catch (error) {
      if (isTooLargeError(error) && shrinkAttempts < maxShrinkAttempts && messages.length > 1) {
        shrinkAttempts++;
        messages = shrinkMessages(messages);
        console.log(`⚠ 413 Request too large, cắt bớt messages (lần ${shrinkAttempts}), thử lại cùng key...`);
        continue;
      }

      if (isQuotaOrRateError(error) && attempts < maxAttempts - 1) {
        console.log(`Key ${currentKeyIndex + 1} hết quota, chuyển key...`);
        currentKeyIndex = getNextKeyIndex(currentKeyIndex);
        attempts++;
        continue;
      }

      throw error;
    }
  }

  throw new Error('Đã thử hết tất cả API keys');
}

async function callTempGroqWithRetry(userId, fn) {
  let currentKeyIndex = await getUserKeyIndex(userId);
  let attempts = 0;
  const maxAttempts = API_KEYS.length;

  while (attempts < maxAttempts) {
    try {
      const apiKey = API_KEYS[currentKeyIndex];
      const groq = new Groq({ apiKey });
      const result = await fn(groq);
      await setUserKeyIndex(userId, currentKeyIndex);
      return result;

    } catch (error) {
      if (isTooLargeError(error)) {
        console.log(`⚠ tempGroq: request too large, không xoay key`);
        throw error;
      }

      if (isQuotaOrRateError(error) && attempts < maxAttempts - 1) {
        console.log(`tempGroq key ${currentKeyIndex + 1} hết quota, chuyển key...`);
        currentKeyIndex = getNextKeyIndex(currentKeyIndex);
        attempts++;
        continue;
      }

      throw error;
    }
  }

  throw new Error('Đã thử hết tất cả API keys cho tempGroq');
}

// ============ VISION HANDLER ============
async function handleVisionRequest(req, res) {
  const { imageBase64, mimeType, prompt, userId, conversationId } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ success: false, error: 'Thiếu dữ liệu ảnh' });
  }

  const safeMime = mimeType || 'image/jpeg';
  if (!ALLOWED_IMAGE_MIME.includes(safeMime)) {
    return res.status(400).json({ success: false, error: 'Định dạng ảnh không hợp lệ. Chỉ hỗ trợ: jpeg, png, webp, gif' });
  }

  if (imageBase64.length > 5 * 1024 * 1024) {
    return res.status(413).json({ success: false, error: 'Ảnh quá lớn. Tối đa ~3.75MB' });
  }

  if (!userId || !userId.startsWith('user_')) {
    return res.status(400).json({ success: false, error: 'Invalid userId' });
  }

  const startTime = Date.now();

  try {
    const userPrompt = prompt && prompt.trim() !== '' ? prompt.trim() : 'Hãy mô tả chi tiết ảnh này bằng tiếng Việt.';

    const chatCompletion = await callTempGroqWithRetry(userId, async (groq) => {
      return groq.chat.completions.create({
        model: 'qwen/qwen3.6-27b',
        messages: [
          {
            role: 'system',
            content: 'Trả lời bằng văn xuôi tự nhiên, ngắn gọn, súc tích. Tuyệt đối không dùng markdown: không dùng **, *, ##, ###, không dùng danh sách bullet hay số thứ tự trừ khi người dùng yêu cầu. Trả lời bằng tiếng Việt. KHÔNG giải thích quá trình suy nghĩ, KHÔNG dùng từ "Based on", "Looking at", "I think". Trả lời trực tiếp kết quả.'
          },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${safeMime};base64,${imageBase64}` } },
              { type: 'text', text: userPrompt }
            ]
          }
        ],
        max_tokens: 1200,
        temperature: 0.7,
        reasoning_effort: 'none'
      });
    });

    let result = chatCompletion.choices[0]?.message?.content || 'Không thể phân tích ảnh';
    result = stripThinking(result);
    if (!result || result.trim() === '') result = 'Không thể phân tích ảnh';

    const finalConversationId = conversationId || 'default';
    let conversationHistory = validateHistory(await getShortTermMemory(userId, finalConversationId));
    conversationHistory.push(
      { role: 'user', content: `[Ảnh] ${userPrompt}` },
      { role: 'assistant', content: result }
    );
    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    const responseTime = Date.now() - startTime;
    console.log(`⚡ Vision response time: ${responseTime}ms`);

    return res.status(200).json({
      success: true, message: result, userId,
      conversationId: finalConversationId, responseTime
    });

  } catch (error) {
    console.error('Vision error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Lỗi phân tích ảnh' });
  }
}

function estimateTokens(text) {
  return Math.ceil((text || '').length / 2.5);
}

function truncateMessagesToFit(messages, maxTokens = 6500, reserveTokens = 1200) {
  if (messages.length === 0) return messages;

  const hasSystem = messages[0]?.role === 'system';
  const systemMsg = hasSystem ? messages[0] : null;
  const rest = hasSystem ? messages.slice(1) : messages;

  const systemTokens = systemMsg ? estimateTokens(systemMsg.content || '') : 0;
  const available = maxTokens - reserveTokens - systemTokens;

  if (available <= 0) {
    console.warn(`⚠ System prompt quá lớn (~${systemTokens} tokens), chỉ giữ tin nhắn mới nhất`);
    const lastFew = rest.slice(-2);
    return systemMsg ? [systemMsg, ...lastFew] : lastFew;
  }

  let total = 0;
  let cutIndex = 0;
  for (let i = rest.length - 1; i >= 0; i--) {
    total += estimateTokens(rest[i].content || '');
    if (total > available) {
      cutIndex = i + 1;
      break;
    }
  }

  const trimmedRest = cutIndex > 0 ? rest.slice(cutIndex) : rest;
  return systemMsg ? [systemMsg, ...trimmedRest] : trimmedRest;
}

// ============ MAIN HANDLER ============
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  maybeCleanupMemoryStore();

  if (req.body.imageBase64) {
    return handleVisionRequest(req, res);
  }

  const startTime = Date.now();

  try {
    const { message, userId, conversationId } = req.body;

    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ success: false, error: 'Message is required and cannot be empty' });
    }

    if (!userId || !userId.startsWith('user_')) {
      return res.status(400).json({ success: false, error: 'Invalid userId format. Expected format: user_<timestamp>' });
    }

    const finalConversationId = conversationId || 'default';

    if (message === '/history') {
      const conversationHistory = await getShortTermMemory(userId, finalConversationId);
      if (conversationHistory.length === 0) {
        return res.status(200).json({ success: true, message: "📭 Chưa có lịch sử chat nào.", userId, conversationId: finalConversationId });
      }

      let historyText = "🕘 LỊCH SỬ CHAT\n\n";
      const recentMessages = conversationHistory.slice(-40);
      recentMessages.forEach((msg) => {
        if (msg.role === 'user') historyText += `>>>👤 Bạn: ${msg.content}\n\n`;
        else if (msg.role === 'assistant') historyText += `>>>🤖 Kami: ${msg.content}\n\n\n`;
      });
      historyText += `\n📊 Tổng cộng: ${conversationHistory.length} tin nhắn (hiển thị 40 mới nhất)`;

      return res.status(200).json({ success: true, message: historyText, userId, conversationId: finalConversationId });
    }

    if (message === '/memory') {
      const userProfile = await getLongTermMemory(userId);
      const summaries = await getSummaries(userId, finalConversationId);

      let memoryText = "🧠 BỘ NHỚ AI\n\n";
      if (Object.keys(userProfile).length === 0) {
        memoryText += "📭 Chưa có thông tin cá nhân nào được lưu.\n\n";
      } else {
        memoryText += "👤 THÔNG TIN CÁ NHÂN:\n";
        const fieldNames = { name: "Tên", nickname: "Biệt danh", family: "Gia đình", age: "Tuổi", job: "Nghề nghiệp", hobbies: "Sở thích", location: "Nơi ở", other: "Khác" };
        for (const [key, value] of Object.entries(userProfile)) {
          const displayKey = fieldNames[key] || key.charAt(0).toUpperCase() + key.slice(1);
          memoryText += `▪ ${displayKey}: ${value}\n`;
        }
        memoryText += "\n";
      }

      if (summaries.length > 0) {
        memoryText += "📝 TÓM TẮT CÁC CUỘC HỘI THOẠI:\n";
        summaries.slice(-15).forEach((summary) => {
          memoryText += `\n[Phần ${summary.number}] Tin ${summary.messageRange}:\n${summary.content}\n`;
        });
        memoryText += `\n📊 Tổng: ${summaries.length} tóm tắt (hiển thị 15 mới nhất)`;
      } else {
        memoryText += "📭 Chưa có tóm tắt nào (cần >= 40 tin nhắn).";
      }

      return res.status(200).json({ success: true, message: memoryText, userId, conversationId: finalConversationId });
    }

    if (API_KEYS.length === 0) {
      return res.status(500).json({ success: false, error: 'No API keys configured' });
    }

    console.log(`📱 Request from ${userId}: "${message.substring(0, 50)}..."`);
    if (IS_DEV) stats.perf.totalRequests++;

    const responseCacheKey = `resp:${userId}:${finalConversationId}:${normalizeForCache(message)}`;
    const cachedResponse = responseCache.get(responseCacheKey);

    if (cachedResponse) {
      if (IS_DEV) stats.perf.responseCacheHits++;
      console.log(`💾 Response cache hit`);

      let conversationHistory = validateHistory(await getShortTermMemory(userId, finalConversationId));
      const lastMsg = conversationHistory[conversationHistory.length - 1];
      const alreadySaved = lastMsg?.role === 'assistant' && lastMsg?.content === cachedResponse;

      if (!alreadySaved) {
        conversationHistory.push(
          { role: 'user', content: message.trim() },
          { role: 'assistant', content: cachedResponse }
        );
        await saveShortTermMemory(userId, finalConversationId, conversationHistory);
      }

      const responseTime = Date.now() - startTime;
      return res.status(200).json({
        success: true, message: cachedResponse, userId,
        conversationId: finalConversationId, cached: true, responseTime
      });
    }

    let [conversationHistory, userProfile] = await Promise.all([
      getShortTermMemory(userId, finalConversationId),
      getLongTermMemory(userId)
    ]);

    conversationHistory = validateHistory(conversationHistory);
    console.log(`💾 Loaded ${conversationHistory.length} messages`);

    // ============ FORUM KNOWLEDGE: ALWAYS CHECK FIRST ============
    let forumKnowledge = null;
    let forumCategoryMatched = null;
    const categories = await fetchForumCategories();

    // Step 1: Quick regex match (fast, no AI cost)
    if (categories.length > 0) {
      const quickForum = quickForumDetect(message, categories);
      if (quickForum.matchedCategory) {
        forumCategoryMatched = quickForum.matchedCategory;
        forumKnowledge = await searchForumKnowledge(forumCategoryMatched.id, message, 3);
      }
    }

    // Step 2: Search decision
    let searchResult = null;
    const searchCacheKey = normalizeForCache(message);
    const cachedDecision = detectionCache.get(searchCacheKey);
    let searchDecision = null;

    if (cachedDecision) {
      searchDecision = cachedDecision;
      console.log(`💾 Using cached search decision`);
    } else {
      searchDecision = quickDetect(message);
      console.log(`⚡ Quick detection: ${searchDecision.needsSearch ? 'SEARCH' : 'SKIP'} (confidence: ${searchDecision.confidence})`);
      if (searchDecision.confidence >= 0.8) {
        detectionCache.set(searchCacheKey, searchDecision);
      }
    }

    // Forum rich = có ít nhất 2 items
    const forumIsRich = forumKnowledge && forumKnowledge.items && forumKnowledge.items.length >= 2;

    if (searchDecision.needsSearch) {
      // Truyền forumResult vào smartSearch để nó ưu tiên nếu có
      searchResult = await smartSearch(message, searchDecision.type, forumIsRich ? forumKnowledge : null);
      if (searchResult) {
        console.log(`✅ Search successful: ${searchResult.source}`);
      }
    }

    // Step 3: Background AI detection + forum matching nếu chưa khớp
    if (!cachedDecision && searchDecision.confidence < 0.8) {
      callTempGroqWithRetry(userId, async (groq) => {
        const aiDecision = await shouldSearch(message, groq);
        detectionCache.set(searchCacheKey, aiDecision);

        // Background forum matching nếu quick regex chưa match
        if (!forumKnowledge && categories.length > 0) {
          const forumMatch = await matchForumCategory(message, groq, categories);
          if (forumMatch.matchedCategory) {
            const bgForum = await searchForumKnowledge(forumMatch.matchedCategory.id, message, 3);
            if (bgForum) {
              console.log(`✅ Background forum cached: ${forumMatch.matchedCategory.name}`);
            }
          }
        }

        // Background web search nếu cần
        if (aiDecision.needsSearch && !searchResult && !forumIsRich) {
          const bgResult = await smartSearch(message, aiDecision.type);
          if (bgResult) {
            console.log(`✅ Background search cached: ${bgResult.source}`);
          }
        }

        return aiDecision;
      }).catch(err => console.error('Background detection error:', err));
    }

    conversationHistory.push({ role: 'user', content: message.trim() });

    let summaries = [];
    try {
      summaries = await callTempGroqWithRetry(userId, async (groq) => {
        return manageMemory(userId, finalConversationId, conversationHistory, groq);
      });
    } catch (err) {
      console.error('manageMemory failed, using existing summaries:', err.message);
      summaries = await getSummaries(userId, finalConversationId);
    }

    const context = buildContext(conversationHistory, summaries);
    const workingMemory = context.recentMessages;
    let summaryContext = '';
    if (context.recentSummaries.length > 0) {
      summaryContext = '\n📚 TÓM TẮT CÁC CUỘC TRÒ CHUYỆN TRƯỚC:\n';
      context.recentSummaries.forEach(s => {
        summaryContext += `\n[Phần ${s.number}] (Tin ${s.messageRange}):\n${s.content}\n`;
      });
    }

    const currentDate = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    // ============ BUILD PROMPT WITH FORUM PRIORITY ============
    const MAX_SEARCH_CHARS = 2500;

    // Forum section (ƯU TIÊN #1)
    let forumSection = '';
    if (forumKnowledge) {
      const compactForum = {
        source: forumKnowledge.source,
        category: categories.find(c => c.id === forumKnowledge.categoryId)?.name || '',
        items: (forumKnowledge.items || []).map(p => ({
          title: p.title,
          content: (p.content || '').slice(0, 400),
          author: p.author,
          type: p.type || 'post',
          viewCount: p.viewCount || 0,
          commentCount: p.commentCount || 0
        }))
      };
      let forumJson = JSON.stringify(compactForum);
      if (forumJson.length > MAX_FORUM_CHARS) {
        forumJson = forumJson.slice(0, MAX_FORUM_CHARS) + '..."}';
      }
      forumSection = `
📚 KIẾN THỨC TỪ DIỄN ĐÀN KAMI (nguồn nội bộ, ưu tiên cao nhất):
--- BẮT ĐẦU DỮ LIỆU ---
${forumJson}
--- KẾT THÚC DỮ LIỆU ---
`;
    }

    // Web search section
    let compactSearchResult = searchResult;
    if (searchResult && searchResult.source !== 'KamiForum') {
      compactSearchResult = {
        source: searchResult.source,
        content: (searchResult.content || '').slice(0, 1200),
        results: (searchResult.results || []).slice(0, 3).map(r => ({
          ...r,
          content: r.content ? r.content.slice(0, 500) : r.content
        }))
      };
    }
    let searchJson = searchResult && searchResult.source !== 'KamiForum' ? JSON.stringify(compactSearchResult) : '';
    if (searchJson.length > MAX_SEARCH_CHARS) {
      searchJson = searchJson.slice(0, MAX_SEARCH_CHARS) + '..."}';
    }
    const searchSection = searchResult && searchResult.source !== 'KamiForum'
      ? `\n🔍 KẾT QUẢ TÌM KIẾM WEB (bổ sung nếu forum không đủ):\n--- BẮT ĐẦU DỮ LIỆU ---\n${searchJson}\n--- KẾT THÚC DỮ LIỆU ---\n`
      : '';

    // Citation instruction nếu có forum knowledge
    const citationInstruction = forumKnowledge
      ? `\n📝 HƯỚNG DẪN TRÍCH DẪN: Khi trả lời dựa trên kiến thức từ Diễn đàn KAMI, hãy đề cập rõ nguồn gốc. Ví dụ: "Theo bài viết '[tên bài]' trong Diễn đàn KAMI..." hoặc "Cộng đồng KAMI chia sẻ rằng...". Nếu dùng web search, ghi "Theo [tên nguồn web]...".`
      : '';

    const systemPrompt = {
      role: 'system',
      content: `Bạn là Kami – AI thông minh được tạo ra bởi Nguyễn Đức Thạnh.
📅 Ngày hiện tại: ${currentDate}

${Object.keys(userProfile).length > 0 ? `
👤 THÔNG TIN NGƯỜI DÙNG:
${Object.entries(userProfile).map(([k, v]) => `- ${k}: ${v}`).join('\n')}
` : ''}

${summaryContext}

${forumSection}
${searchSection}
${citationInstruction}

💾 Context: ${context.contextInfo.messagesInContext} tin mới + ${context.contextInfo.summariesInContext} summaries
📊 Tổng: ${context.contextInfo.totalMessages} tin, ${context.contextInfo.totalSummaries} summaries

📋 NGUYÊN TẮC TRẢ LỜI:
1. ƯU TIÊN #1: Kiến thức từ Diễn đàn KAMI (nếu có) - đây là nguồn nội bộ đáng tin cậy
2. ƯU TIÊN #2: Web search result (nếu forum không đủ thông tin)
3. ƯU TIÊN #3: Kiến thức nội tại của AI (chỉ dùng khi không có nguồn khác)
4. KHÔNG BỊA ĐẶT - nếu không chắc thì nói thẳng
5. Giải thích bản chất trước, chi tiết sau. Mạch lạc, có cấu trúc.
6. Trả lời bằng tiếng Việt.`
    };

    let messages = [systemPrompt, ...workingMemory];
    const TPM_SAFETY_BUFFER = 700;
    messages = truncateMessagesToFit(messages, 8000 - TPM_SAFETY_BUFFER, 1200);
    console.log(`🤖 Calling AI with ${messages.length - 1} history messages (est ~${estimateTokens(messages.map(m => m.content).join(''))} tokens)...`);

    const chatCompletion = await callGroqWithRetry(userId, messages);

    const assistantMessage = chatCompletion.choices[0]?.message?.content || 'Không có phản hồi';

    console.log(`✅ AI responded`);

    conversationHistory.push({
      role: 'assistant',
      content: assistantMessage
    });

    await saveShortTermMemory(userId, finalConversationId, conversationHistory);

    responseCache.set(responseCacheKey, assistantMessage);

    if (await shouldExtractNow(userId, finalConversationId, conversationHistory)) {
      console.log(`🔍 Background extracting...`);

      callTempGroqWithRetry(userId, async (groq) => {
        const newInfo = await extractPersonalInfo(groq, conversationHistory);

        if (Object.keys(newInfo).length > 0) {
          const updatedProfile = mergeProfile(userProfile, newInfo);
          await saveLongTermMemory(userId, updatedProfile);
          await markExtracted(userId, finalConversationId, conversationHistory);
          console.log(`✅ Profile updated`);
        } else {
          await markExtracted(userId, finalConversationId, conversationHistory);
        }

        return newInfo;
      }).catch(err => console.error('Background extract error:', err));
    }

    if (redis) {
      const chatKey = `chat:${userId}:${finalConversationId}`;
      const ttl = await redis.ttl(chatKey);
      const daysRemaining = ttl / 86400;

      if (daysRemaining > 0 && daysRemaining < 2 && conversationHistory.length >= 3) {
        console.log(`⚠ Safety extract...`);

        callTempGroqWithRetry(userId, async (groq) => {
          const newInfo = await extractPersonalInfo(groq, conversationHistory);

          if (Object.keys(newInfo).length > 0) {
            const updatedProfile = mergeProfile(userProfile, newInfo);
            await saveLongTermMemory(userId, updatedProfile);
            console.log(`✅ Safety profile saved`);
          }

          return newInfo;
        }).catch(err => console.error('Background safety extract error:', err));
      }
    }

    const responseTime = Date.now() - startTime;

    if (IS_DEV) {
      const nonCachedRequests = stats.perf.totalRequests - stats.perf.responseCacheHits;
      if (nonCachedRequests > 0) {
        stats.perf.totalResponseTime = (stats.perf.totalResponseTime || 0) + responseTime;
        const avgResponseTime = stats.perf.totalResponseTime / nonCachedRequests;

        if (stats.perf.totalRequests % 10 === 0) {
          console.log(`📊 Stats:`, {
            totalRequests: stats.perf.totalRequests,
            responseCacheHitRate: `${Math.round(stats.perf.responseCacheHits / stats.perf.totalRequests * 100)}%`,
            avgResponseTime: `${Math.round(avgResponseTime)}ms`,
            searchCacheHitRate: stats.search.total > 0
              ? `${Math.round(stats.search.cacheHits / stats.search.total * 100)}%`
              : 'N/A'
          });
        }
      }
    }

    console.log(`⚡ Response time: ${responseTime}ms`);

    return res.status(200).json({
      success: true,
      message: assistantMessage,
      userId: userId,
      conversationId: finalConversationId,
      responseTime: responseTime,
      stats: {
        totalMessages: conversationHistory.length,
        workingMemorySize: workingMemory.length,
        summariesCount: summaries.length,
        summariesInContext: context.contextInfo.summariesInContext,
        userProfileFields: Object.keys(userProfile).length,
        storageType: REDIS_ENABLED ? 'Redis' : 'In-Memory',
        searchUsed: !!searchResult,
        searchSource: searchResult?.source || null,
        forumUsed: !!forumKnowledge,
        forumCategory: forumKnowledge?.categoryId || null,
        forumItemsCount: forumKnowledge?.items?.length || 0,
        modelUsed: 'openai/gpt-oss-120b',
        cached: false
      }
    });

  } catch (error) {
    console.error('❌ Error:', error);
    console.error('Error stack:', error.stack);

    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      errorType: error.name || 'Unknown',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
