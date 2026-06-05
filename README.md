# Arc Content Explorer — 部署说明

## 架构

```
浏览器
  │
  ├── GET /api/content     → 从 KV 读取（毫秒级）
  ├── GET /api/rpc         → 代理 Arc RPC
  └── GET /api/explorer/*  → 代理 Block Explorer

Vercel Cron（每小时）
  └── GET /api/sync        → 抓取 sitemap + 标题 → 写入 KV
```

**核心思路**：抓取和读取完全分离。`/api/sync` 在后台慢慢爬（最多 5 分钟），结果存进 Vercel KV（Redis）。前端调 `/api/content` 只是从 KV 读数据，永远不超时。

---

## 部署步骤

### 1. 推送代码到 GitHub

```bash
git init
git add .
git commit -m "Arc Content Explorer v2"
git remote add origin https://github.com/你的用户名/arc-content-explorer.git
git push -u origin main
```

### 2. 在 Vercel 导入项目

- 打开 https://vercel.com/new，选择你的 GitHub 仓库
- Framework Preset 选 **Other**
- Root Directory 留空（默认）
- 点击 Deploy

### 3. 创建 Vercel KV 数据库

1. 进入项目 Dashboard → **Storage** 标签
2. 点击 **Create Database** → 选 **KV**
3. 数据库名随意（如 `arc-kv`），Region 选离你最近的
4. 点击 **Connect to Project** → 选你的项目
5. Vercel 会自动注入这些环境变量：
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
   - `KV_REST_API_READ_ONLY_TOKEN`

### 4. 设置环境变量

在 Vercel 项目 Dashboard → **Settings** → **Environment Variables** 添加：

| 变量名 | 值 | 说明 |
|--------|-----|------|
| `SYNC_SECRET` | 任意字符串，如 `my-secret-123` | 手动触发同步时的鉴权密钥 |
| `CRON_SECRET` | Vercel 自动生成（部署后查看） | Vercel Cron 鉴权，不用手动设置 |

### 5. 首次手动触发同步

部署完成后，KV 里还没有数据，需要手动触发一次同步：

```
https://你的域名.vercel.app/api/sync?secret=你设置的SYNC_SECRET
```

浏览器会显示类似：
```json
{
  "ok": true,
  "count": 1234,
  "resolved": 980,
  "elapsedSec": 142.3,
  "syncedAt": "2026-06-05T10:00:00.000Z"
}
```

同步完成后刷新首页，内容就会全部显示。

### 6. 验证

- 检查内容数据：`/api/content?meta=1`
- 检查完整数据：`/api/content`
- 手动同步：`/api/sync?secret=YOUR_SYNC_SECRET`

---

## 自动同步

`vercel.json` 里已配置 Cron 每小时整点自动同步：

```json
"crons": [{ "path": "/api/sync", "schedule": "0 * * * *" }]
```

Vercel Hobby 计划每天有 2 次免费 Cron 调用，Pro 计划无限制。
如果是 Hobby 计划，可以把 schedule 改为 `"0 */12 * * *"`（每 12 小时一次）。

---

## KV 数据结构

| Key | 类型 | 内容 |
|-----|------|------|
| `arc:items` | String（JSON） | 完整内容数组 |
| `arc:synced_at` | Number | 最后同步时间戳（ms） |
| `arc:item_count` | Number | 条目总数 |

---

## 常见问题

**Q: 同步超时了怎么办？**  
A: `api/sync.js` 在 `vercel.json` 里配置了 `maxDuration: 300`（5 分钟），足够抓取数千个页面。如果还是超时，可以把 `CONCURRENCY` 从 12 调低到 6。

**Q: KV 免费额度够用吗？**  
A: Vercel KV 免费版有 30MB 存储和每月 30 万次请求。内容数组通常在 2-5MB，完全够用。

**Q: 如何只更新部分内容（增量同步）？**  
A: 目前是全量同步。如需增量，可在 sync.js 里读取现有 `arc:items`，对比 lastmod 字段，只重新抓取有更新的页面。
