# KamiMp3 API 🎵

Backend API cho app nghe nhạc KamiMp3 — mạng xã hội chia sẻ nhạc MP3 qua Telegram.

## 🏗️ Kiến trúc

```
User upload MP3 → Telegram Bot/Channel → Vercel Webhook → Upstash Redis
                                                              ↓
                                                        App gọi API
```

## 🚀 Deploy

### 1. Tạo Upstash Redis
- Vào [upstash.com](https://upstash.com)
- Tạo Redis database
- Copy `UPSTASH_REDIS_REST_URL` và `UPSTASH_REDIS_REST_TOKEN`

### 2. Deploy lên Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel --prod
```

### 3. Set Environment Variables

Trong Vercel Dashboard → Project Settings → Environment Variables:

```
BOT_TOKEN=your_telegram_bot_token
CHANNEL_ID=-100xxxxxxxxxx
UPSTASH_REDIS_REST_URL=https://...upstash.io
UPSTASH_REDIS_REST_TOKEN=your_token
ADMIN_USER_ID=your_admin_user_id (optional)
```

### 4. Set Telegram Webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://your-project.vercel.app/api/webhook&allowed_updates=%5B%22message%22%2C%22channel_post%22%2C%22edited_message%22%2C%22edited_channel_post%22%5D"
```

## 📡 API Endpoints

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/webhook` | POST | Nhận webhook từ Telegram |
| `/api/songs` | GET | Lấy danh sách bài hát (phân trang, search) |
| `/api/search?q=query` | GET | Tìm kiếm bài hát |
| `/api/delete` | POST | Xóa bài hát (chỉ chủ sở hữu) |
| `/api/stats` | GET | Thống kê |

### GET /api/songs

Params:
- `offset` (default: 0) — Bắt đầu từ vị trí nào
- `limit` (default: 50, max: 200) — Số lượng mỗi trang
- `search` — Tìm kiếm theo tên
- `userId` — Lọc bài của 1 user
- `sort` — `newest`, `oldest`, `name`

Response:
```json
{
  "songs": [...],
  "total": 1000,
  "offset": 0,
  "limit": 50,
  "hasMore": true,
  "stats": { "totalSongs": 1000 }
}
```

### GET /api/search?q=hello&limit=20

Response:
```json
{
  "songs": [...],
  "total": 5,
  "query": "hello"
}
```

### POST /api/delete

Body:
```json
{
  "message_id": 12345,
  "userId": "user_xxx"
}
```

## 🔒 Bảo mật

- Webhook Telegram có thể verify bằng secret token (nếu cần)
- Xóa bài hát chỉ cho phép chủ sở hữu hoặc admin
- CORS đã bật cho tất cả origin (có thể restrict lại nếu cần)

## 📱 Tích hợp với KamiMp3 App

Trong app JavaScript, thay `syncAll()` để gọi API thay vì `getUpdates`:

```javascript
const API_URL = 'https://your-project.vercel.app/api';

function syncAll(auto) {
    if(!auto) msg('Đang đồng bộ...');

    fetch(API_URL + '/songs?limit=200&offset=0')
    .then(r => r.json())
    .then(data => {
        var newAdded = 0;
        data.songs.forEach(song => {
            var found = ALL.some(a => a.message_id === song.message_id);
            if(!found) {
                ALL.unshift(song);
                newAdded++;
            }
        });
        saveAll(); renderHome(); renderMy();
        if(!auto) msg('Đồng bộ xong, +' + newAdded + ' bài mới');
    })
    .catch(e => msg('Lỗi: ' + e.message));
}
```
