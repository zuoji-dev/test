/**
 * /api/sync.js  —  后台同步任务
 *
 * 触发方式：
 *   - Vercel Cron 每小时自动调用（vercel.json 里配置）
 *   - 手动 GET /api/sync?secret=YOUR_SYNC_SECRET  强制触发
 *
 * 流程：
 *   1. 并发抓取 3 个 sitemap XML
 *   2. 解析 URL → 分类 → 去重
 *   3. 并发 12 路抓取各页面真实标题（maxDuration=300s，有充足时间）
 *   4. 写入 Vercel KV：
 *        arc:items        → 完整内容数组（JSON）
 *        arc:synced_at    → 最后同步时间戳
 *        arc:item_count   → 条目数量
 *   5. 返回同步结果摘要
 *
 * 环境变量（Vercel 控制台配置）：
 *   KV_REST_API_URL      自动注入（绑定 KV 数据库后）
 *   KV_REST_API_TOKEN    自动注入
 *   SYNC_SECRET          可选，防止未授权手动触发
 */

import { kv } from '@vercel/kv';

// ── 配置 ──────────────────────────────────────────────────────
const SITEMAP_SOURCES = [
  { key: 'content', url: 'https://community.arc.io/sitemap/content/sitemap.xml' },
  { key: 'events',  url: 'https://community.arc.io/sitemap/events/sitemap.xml'  },
  { key: 'forum',   url: 'https://community.arc.io/sitemap/forum/sitemap.xml'   },
];
const CONCURRENCY = 12;
const FETCH_TIMEOUT_MS = 10000;

// ── slug → 可读标题 ────────────────────────────────────────────
function slugToTitle(slug) {
  let t = slug
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-[a-z0-9]{8,12}$/, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return t
    .replace(/\bAi\b/g, 'AI').replace(/\bUsdc\b/gi, 'USDC')
    .replace(/\bEurc\b/gi, 'EURC').replace(/\bSdk\b/gi, 'SDK')
    .replace(/\bDefi\b/gi, 'DeFi').replace(/\bCctp\b/gi, 'CCTP')
    .replace(/\bErc\b/gi, 'ERC').replace(/\bQcad\b/gi, 'QCAD')
    .replace(/\bTradfi\b/gi, 'TradFi')
    .replace(/(?!^)\bOf\b/g, 'of').replace(/(?!^)\bAnd\b/g, 'and')
    .replace(/(?!^)\bThe\b/g, 'the').replace(/(?!^)\bFor\b/g, 'for')
    .replace(/(?!^)\bWith\b/g, 'with').replace(/(?!^)\bTo\b/g, 'to')
    .replace(/(?!^)\bIn\b/g, 'in').replace(/(?!^)\bOn\b/g, 'on');
}

// ── URL 分类 ───────────────────────────────────────────────────
function classifyContent(loc, lastmod) {
  let type = 'resource', category = 'forum', boardName = null;

  if      (loc.includes('/public/blogs/'))       { type = 'blog';       category = 'blog';     }
  else if (loc.includes('/public/videos/'))      { type = 'video';      category = 'video';    }
  else if (loc.includes('/public/podcasts/'))    { type = 'podcast';    category = 'resource'; }
  else if (loc.includes('/public/resources/'))   { type = 'resource';   category = 'resource'; }
  else if (loc.includes('/public/externals/'))   { type = 'external';   category = 'external'; }
  else if (loc.includes('/public/collections/')) { type = 'collection'; category = 'resource'; }
  else if (loc.includes('/public/events/'))      { type = 'event';      category = 'events';   }
  else if (loc.includes('/public/forum/') || (loc.includes('/clubs/') && loc.includes('/forum/'))) {
    type = 'forum'; category = 'forum';
    const m = loc.match(/\/forum\/boards\/([^/]+)\//);
    if (m) boardName = m[1];
  }

  const pathParts = loc.replace('https://community.arc.io/', '').split('/');
  const lastPart  = pathParts[pathParts.length - 1];
  const skipList  = ['blogs','videos','podcasts','resources','externals','collections','events','forum','content','albums'];
  if (skipList.includes(lastPart) || lastPart.endsWith('.xml')) return null;

  const noiseSegs = ['t', 'p', 'boards', 'forum'];
  let slug = lastPart;
  for (let s = pathParts.length - 1; s >= 0; s--) {
    const seg = pathParts[s];
    if (/^\d+$/.test(seg) || noiseSegs.includes(seg)) continue;
    slug = seg; break;
  }

  return { url: loc, slug, title: slugToTitle(slug), realTitle: null,
           pubDate: null, lastmod: lastmod || null, type, category, boardName };
}

// ── 抓取 sitemap ───────────────────────────────────────────────
async function fetchSitemap(source) {
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'ArcContentExplorer/2.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const items = [];
    const re = /<url>([\s\S]*?)<\/url>/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const locM = m[1].match(/<loc>(.*?)<\/loc>/);
      const modM = m[1].match(/<lastmod>(.*?)<\/lastmod>/);
      if (locM) items.push({ loc: locM[1].trim(), lastmod: modM ? modM[1].trim() : null });
    }
    console.log(`[Sync] Sitemap ${source.key}: ${items.length} URLs`);
    return items;
  } catch (e) {
    console.warn(`[Sync] Sitemap ${source.key} failed:`, e.message);
    return [];
  }
}

// ── 抓取单页真实标题 ───────────────────────────────────────────
async function fetchRealTitle(item) {
  try {
    const res = await fetch(item.url, {
      headers: { 'User-Agent': 'ArcContentExplorer/2.0' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const html = await res.text();

    let title = null, pubDate = null;

    // JSON-LD（最准确）
    const ldM = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (ldM) {
      try {
        const ld = JSON.parse(ldM[1]);
        title   = ld.headline || ld.name || null;
        pubDate = ld.datePublished || ld.dateCreated || null;
        if (!title && ld.itemListElement?.length) {
          const last = ld.itemListElement[ld.itemListElement.length - 1];
          if (last.name && last.name !== 'navigation.home') title = last.name;
        }
      } catch {}
    }

    // <title> 标签
    if (!title) {
      const tM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (tM) title = tM[1].trim()
        .replace(/\s*\|\s*[^|]*Arc\s*House\s*$/i, '')
        .replace(/\s*[-|]\s*(Blog|Video|Event|Podcast|Resource|Forum|Content|General|External|Collection|Club)\s*$/i, '');
    }

    // og:title 兜底
    if (!title) {
      const ogM = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/i);
      if (ogM) title = ogM[1];
    }

    // 发布时间
    if (!pubDate) {
      const apM = html.match(/<meta[^>]*property="article:published_time"[^>]*content="([^"]*)"/i);
      if (apM) pubDate = apM[1];
    }

    return (title && title.length > 3) ? { title, pubDate } : null;
  } catch {
    return null;
  }
}

// ── 并发池执行 ─────────────────────────────────────────────────
async function runPool(items, concurrency, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

// ── 主同步逻辑 ─────────────────────────────────────────────────
async function runSync() {
  const t0 = Date.now();
  console.log('[Sync] Starting full sync...');

  // 1. 抓取并解析所有 sitemap
  const sitemapResults = await Promise.all(SITEMAP_SOURCES.map(fetchSitemap));

  // 2. 去重分类
  const seen = new Set();
  const allContent = [];
  for (const items of sitemapResults) {
    for (const raw of items) {
      const item = classifyContent(raw.loc, raw.lastmod);
      if (item && !seen.has(item.url)) {
        seen.add(item.url);
        allContent.push(item);
      }
    }
  }
  console.log(`[Sync] Parsed ${allContent.length} unique items`);

  // 3. 并发抓取真实标题（服务端无 CORS，maxDuration=300s 有充足时间）
  let resolved = 0;
  await runPool(allContent, CONCURRENCY, async (item) => {
    const result = await fetchRealTitle(item);
    if (result) {
      item.realTitle = result.title;
      if (result.pubDate) item.pubDate = result.pubDate;
      resolved++;
    }
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[Sync] Done in ${elapsed}s — ${resolved}/${allContent.length} real titles`);

  // 4. 写入 Vercel KV
  const syncedAt = Date.now();
  await kv.set('arc:items',      JSON.stringify(allContent));
  await kv.set('arc:synced_at',  syncedAt);
  await kv.set('arc:item_count', allContent.length);

  console.log(`[Sync] Written to KV. Count: ${allContent.length}`);

  return {
    ok:        true,
    count:     allContent.length,
    resolved,
    elapsedSec: parseFloat(elapsed),
    syncedAt:  new Date(syncedAt).toISOString(),
  };
}

// ── Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  // 允许 Vercel Cron（带 Authorization header）和手动带 secret 参数触发
  const cronHeader = req.headers['authorization'];
  const isCron     = cronHeader === `Bearer ${process.env.CRON_SECRET}`;
  const isManual   = req.query.secret && req.query.secret === process.env.SYNC_SECRET;

  if (!isCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized. Pass ?secret=YOUR_SYNC_SECRET or trigger via Vercel Cron.' });
  }

  try {
    const result = await runSync();
    return res.status(200).json(result);
  } catch (err) {
    console.error('[Sync] Fatal error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
