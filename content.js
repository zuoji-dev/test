/**
 * /api/content.js  —  内容读取接口
 *
 * GET /api/content
 *   → 从 Vercel KV 读取已同步的内容数组，毫秒级响应
 *   → 若 KV 为空（首次部署），返回 { ok: false, empty: true } 提示先触发同步
 *
 * GET /api/content?meta=1
 *   → 只返回元信息（条目数 + 最后同步时间），不返回完整数组，用于健康检查
 */

import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 元信息查询（轻量）
    if (req.query.meta === '1') {
      const [count, syncedAt] = await Promise.all([
        kv.get('arc:item_count'),
        kv.get('arc:synced_at'),
      ]);
      return res.status(200).json({
        ok: true,
        count: count ?? 0,
        syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
      });
    }

    // 完整内容
    const [raw, syncedAt] = await Promise.all([
      kv.get('arc:items'),
      kv.get('arc:synced_at'),
    ]);

    if (!raw) {
      return res.status(200).json({
        ok:    false,
        empty: true,
        hint:  'Database is empty. Trigger a sync first: GET /api/sync?secret=YOUR_SYNC_SECRET',
      });
    }

    const items = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const age   = syncedAt ? Math.floor((Date.now() - syncedAt) / 1000) : null;

    // 缓存 5 分钟，过期后 stale-while-revalidate 1 小时
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
    res.setHeader('X-Item-Count',  String(items.length));
    if (age !== null) res.setHeader('X-Cache-Age', String(age));

    return res.status(200).json({
      ok:       true,
      count:    items.length,
      syncedAt: syncedAt ? new Date(syncedAt).toISOString() : null,
      age,
      items,
    });

  } catch (err) {
    console.error('[Content] KV read error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
