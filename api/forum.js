// api/forum.js — KamiForum v3
// Yêu cầu env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_KEY

const MAX_TITLE = 200;
const MAX_CONTENT = 10000;
const MAX_COMMENT = 2000;
const MAX_AUTHOR = 50;
const POSTS_PER_PAGE = 100;

export default async function handler(req, res) {
  // ── CORS ──
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, apikey');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_KEY = process.env.ADMIN_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ success: false, errorCode: '500', error: 'Server chưa cấu hình xong' });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  try {
    // ─────────── GET ───────────
    if (req.method === 'GET') {
      const { action, category_id, q, page, post_id, user_id } = req.query;

      // ── Lấy danh mục ──
      if (action === 'categories') {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?select=*&order=sort_order.asc`, { headers });
        if (!r.ok) throw new Error(await r.text());
        return res.status(200).json({ success: true, categories: await r.json() });
      }

      // ── Lấy bài viết theo danh mục (có phân trang) ──
      if (action === 'posts') {
        const pg = Math.max(1, parseInt(page) || 1);
        const from = (pg - 1) * POSTS_PER_PAGE;
        const to = from + POSTS_PER_PAGE - 1;

        let url = `${SUPABASE_URL}/rest/v1/forum_posts?select=*,forum_categories(name,icon)&status=eq.approved&order=created_at.desc&limit=${POSTS_PER_PAGE}&offset=${from}`;
        if (category_id) url += `&category_id=eq.${encodeURIComponent(category_id)}`;

        // Đếm tổng
        let countUrl = `${SUPABASE_URL}/rest/v1/forum_posts?select=id&status=eq.approved`;
        if (category_id) countUrl += `&category_id=eq.${encodeURIComponent(category_id)}`;

        const [r, countR] = await Promise.all([
          fetch(url, { headers }),
          fetch(countUrl, { headers })
        ]);

        if (!r.ok) throw new Error(await r.text());
        const posts = await r.json();
        const total = (await countR.json()).length;

        return res.status(200).json({ 
          success: true, 
          posts,
          pagination: {
            page: pg,
            perPage: POSTS_PER_PAGE,
            total,
            totalPages: Math.ceil(total / POSTS_PER_PAGE)
          }
        });
      }

      // ── Chi tiết bài viết + comments ──
      if (action === 'detail') {
        if (!post_id) return res.status(400).json({ success: false, error: 'Thiếu post_id' });

        // Lấy post + tăng view count
        const postUrl = `${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${post_id}&select=*,forum_categories(name,icon)`;
        const commentsUrl = `${SUPABASE_URL}/rest/v1/forum_comments?post_id=eq.${post_id}&select=*&order=created_at.desc`;

        const [rPost, rComments] = await Promise.all([
          fetch(postUrl, { headers }),
          fetch(commentsUrl, { headers })
        ]);

        if (!rPost.ok) throw new Error(await rPost.text());
        const posts = await rPost.json();
        if (!posts.length) return res.status(404).json({ success: false, error: 'Không tìm thấy bài viết' });

        // Tăng view count (fire and forget)
        fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${post_id}`, {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({ view_count: (posts[0].view_count || 0) + 1 })
        }).catch(() => {});

        return res.status(200).json({
          success: true,
          post: posts[0],
          comments: await rComments.json()
        });
      }

      // ── Thông tin user (Của tôi) ──
      if (action === 'myStats') {
        if (!user_id) return res.status(400).json({ success: false, error: 'Thiếu user_id' });

        const statsUrl = `${SUPABASE_URL}/rest/v1/forum_user_stats?user_id=eq.${encodeURIComponent(user_id)}`;
        const myPostsUrl = `${SUPABASE_URL}/rest/v1/forum_posts?user_id=eq.${encodeURIComponent(user_id)}&select=*,forum_categories(name)&order=created_at.desc`;

        const [rStats, rPosts] = await Promise.all([
          fetch(statsUrl, { headers }),
          fetch(myPostsUrl, { headers })
        ]);

        const stats = await rStats.json();
        const myPosts = await rPosts.json();

        return res.status(200).json({
          success: true,
          stats: stats[0] || { total_posts: 0, approved_posts: 0, pending_posts: 0, rejected_posts: 0, total_comments: 0 },
          posts: myPosts
        });
      }

      // ── Search ──
      if (action === 'search') {
        if (!q || !q.trim()) {
          return res.status(400).json({ success: false, error: 'Thiếu từ khóa' });
        }
        const keyword = encodeURIComponent(q.trim());
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_posts?select=*,forum_categories(name)&status=eq.approved&or=(title.ilike.*${keyword}*,content.ilike.*${keyword}*)&order=created_at.desc&limit=20`,
          { headers }
        );
        if (!r.ok) throw new Error(await r.text());
        return res.status(200).json({ success: true, posts: await r.json() });
      }

      // ── Admin: lấy tất cả bài ──
      if (action === 'admin') {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/forum_posts?select=*,forum_categories(name)&order=created_at.desc`,
          { headers }
        );
        if (!r.ok) throw new Error(await r.text());
        return res.status(200).json({ success: true, posts: await r.json() });
      }

      return res.status(400).json({ success: false, error: 'Thiếu action' });
    }

    // ─────────── POST ───────────
    if (req.method === 'POST') {
      const body = req.body || {};

      // ── Moderate ──
      if (body.action === 'moderate') {
        return await handleModerate(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Delete post ──
      if (body.action === 'delete') {
        return await handleDelete(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Update post ──
      if (body.action === 'update') {
        return await handleUpdate(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      // ── Add comment ──
      if (body.action === 'comment') {
        return await handleComment(body, SUPABASE_URL, headers, res);
      }
      // ── Delete comment ──
      if (body.action === 'deleteComment') {
        return await handleDeleteComment(body, SUPABASE_URL, headers, res);
      }
      // ── Category management ──
      if (body.action === 'addCategory') {
        return await handleAddCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      if (body.action === 'editCategory') {
        return await handleEditCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }
      if (body.action === 'deleteCategory') {
        return await handleDeleteCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res);
      }

      // ── Gửi bài mới ──
      return await handleSubmit(body, SUPABASE_URL, headers, res);
    }

    // ── DELETE: Xóa bài của chính mình ──
    if (req.method === 'DELETE') {
      const { id, userId } = req.body || {};
      if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });

      // Kiểm tra quyền: admin hoặc chính chủ
      const postR = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}&select=user_id`, { headers });
      const posts = await postR.json();
      if (!posts.length) return res.status(404).json({ success: false, error: 'Không tìm thấy bài' });

      const isOwner = posts[0].user_id === userId;
      const isAdmin = body.adminKey === ADMIN_KEY;

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ success: false, error: 'Không có quyền xóa' });
      }

      const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, {
        method: 'DELETE',
        headers: { ...headers, Prefer: 'return=minimal' }
      });
      if (!r.ok) throw new Error(await r.text());
      return res.status(200).json({ success: true, message: 'Đã xóa bài viết' });
    }

    return res.status(405).json({ success: false, error: 'Method không hỗ trợ' });

  } catch (error) {
    console.error('forum API error:', error);
    return res.status(500).json({ success: false, error: 'Lỗi hệ thống: ' + error.message });
  }
}

// ============ HANDLERS ============

function verifyAdmin(body, ADMIN_KEY) {
  if (!ADMIN_KEY) return { ok: false, error: 'Admin key chưa cấu hình' };
  if (body.adminKey !== ADMIN_KEY) return { ok: false, error: 'Admin key không đúng' };
  return { ok: true };
}

async function handleSubmit(body, SUPABASE_URL, headers, res) {
  const { category_id, title, content, author, userId, username, isAnonymous } = body;

  if (!category_id || !title?.trim() || !content?.trim()) {
    return res.status(400).json({ success: false, error: 'Thiếu danh mục, tiêu đề hoặc nội dung' });
  }
  if (title.length > MAX_TITLE) {
    return res.status(413).json({ success: false, error: `Tiêu đề tối đa ${MAX_TITLE} ký tự` });
  }
  if (content.length > MAX_CONTENT) {
    return res.status(413).json({ success: false, error: `Nội dung tối đa ${MAX_CONTENT} ký tự` });
  }

  const insertBody = {
    category_id,
    title: title.trim(),
    content: content.trim(),
    author: isAnonymous ? 'Ẩn danh' : (author?.trim() || username || 'Người dùng'),
    user_id: userId || null,
    username: username || null,
    is_anonymous: !!isAnonymous,
    status: 'pending'
  };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(insertBody)
  });

  if (!r.ok) {
    console.error('Supabase insert error:', await r.text());
    return res.status(500).json({ success: false, error: 'Không lưu được bài viết' });
  }

  const result = await r.json();
  return res.status(200).json({ 
    success: true, 
    message: 'Đã gửi bài, chờ admin duyệt!',
    post: result[0]
  });
}

async function handleComment(body, SUPABASE_URL, headers, res) {
  const { post_id, content, author, userId, username, isAnonymous, parent_id } = body;

  if (!post_id || !content?.trim()) {
    return res.status(400).json({ success: false, error: 'Thiếu bài viết hoặc nội dung comment' });
  }
  if (content.length > MAX_COMMENT) {
    return res.status(413).json({ success: false, error: `Comment tối đa ${MAX_COMMENT} ký tự` });
  }

  const insertBody = {
    post_id,
    content: content.trim(),
    author: isAnonymous ? 'Ẩn danh' : (author?.trim() || username || 'Người dùng'),
    user_id: userId || null,
    username: username || null,
    is_anonymous: !!isAnonymous,
    parent_id: parent_id || null
  };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_comments`, {
    method: 'POST',
    headers,
    body: JSON.stringify(insertBody)
  });

  if (!r.ok) {
    console.error('Comment insert error:', await r.text());
    return res.status(500).json({ success: false, error: 'Không lưu được comment' });
  }

  const result = await r.json();
  return res.status(200).json({ success: true, comment: result[0] });
}

async function handleDeleteComment(body, SUPABASE_URL, headers, res) {
  const { id, userId, adminKey } = body;
  const ADMIN_KEY = process.env.ADMIN_KEY;

  if (!id) return res.status(400).json({ success: false, error: 'Thiếu id comment' });

  // Kiểm tra quyền
  const commentR = await fetch(`${SUPABASE_URL}/rest/v1/forum_comments?id=eq.${id}&select=user_id`, { headers });
  const comments = await commentR.json();
  if (!comments.length) return res.status(404).json({ success: false, error: 'Không tìm thấy comment' });

  const isOwner = comments[0].user_id === userId;
  const isAdmin = adminKey === ADMIN_KEY;

  if (!isOwner && !isAdmin) {
    return res.status(403).json({ success: false, error: 'Không có quyền xóa' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_comments?id=eq.${id}`, {
    method: 'DELETE',
    headers: { ...headers, Prefer: 'return=minimal' }
  });

  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ success: true, message: 'Đã xóa comment' });
}

async function handleModerate(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, status } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, error: auth.error });

  if (!id || !['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ success: false, error: 'Thiếu id hoặc status không hợp lệ' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ status })
  });

  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ 
    success: true, 
    message: status === 'approved' ? 'Đã duyệt' : 'Đã từ chối' 
  });
}

async function handleDelete(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, error: auth.error });

  if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, {
    method: 'DELETE',
    headers: { ...headers, Prefer: 'return=minimal' }
  });

  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ success: true, message: 'Đã xóa' });
}

async function handleUpdate(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, title, content, category_id } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, error: auth.error });

  if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });

  const updateData = {};
  if (title !== undefined) updateData.title = String(title).trim();
  if (content !== undefined) updateData.content = String(content).trim();
  if (category_id !== undefined) updateData.category_id = category_id;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, error: 'Không có dữ liệu cập nhật' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(updateData)
  });

  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ success: true, message: 'Đã cập nhật' });
}

async function handleAddCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { name, icon, sort_order, view_mode } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, error: auth.error });

  if (!name?.trim()) return res.status(400).json({ success: false, error: 'Thiếu tên danh mục' });

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      name: name.trim(),
      icon: icon || '📁',
      sort_order: sort_order || 0,
      view_mode: view_mode || 'list'
    })
  });

  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ success: true, message: 'Đã thêm danh mục' });
}

async function handleEditCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id, name, icon, sort_order, view_mode } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, error: auth.error });

  if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });

  const updateData = {};
  if (name !== undefined) updateData.name = String(name).trim();
  if (icon !== undefined) updateData.icon = icon;
  if (sort_order !== undefined) updateData.sort_order = sort_order;
  if (view_mode !== undefined) updateData.view_mode = view_mode;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ success: false, error: 'Không có dữ liệu cập nhật' });
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(updateData)
  });

  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ success: true, message: 'Đã cập nhật danh mục' });
}

async function handleDeleteCategory(body, ADMIN_KEY, SUPABASE_URL, headers, res) {
  const { id } = body;
  const auth = verifyAdmin(body, ADMIN_KEY);
  if (!auth.ok) return res.status(403).json({ success: false, error: auth.error });

  if (!id) return res.status(400).json({ success: false, error: 'Thiếu id' });

  const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_categories?id=eq.${id}`, {
    method: 'DELETE',
    headers: { ...headers, Prefer: 'return=minimal' }
  });

  if (!r.ok) throw new Error(await r.text());
  return res.status(200).json({ success: true, message: 'Đã xóa danh mục' });
}
