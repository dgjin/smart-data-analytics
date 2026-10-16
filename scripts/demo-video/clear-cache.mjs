#!/usr/bin/env node
/**
 * 正式录制前清缓存：对 m2 / m5 用到的数据源重放「问数范围保存」（PUT scope，值不变），
 * 触发服务端 invalidateQueryCache → 清掉：
 *   - L1 精确问数缓存（m2 冷缓存时可完整展示流式进度 ~20-27s）
 *   - fqsql SQL 结果缓存（m5 大查询走真实后台执行耗时 ~8-14s）
 * 用法：node scripts/demo-video/clear-cache.mjs
 */
const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.token) throw new Error(`login failed: ${j?.error || r.status}`);
  return j.token;
};

const main = async () => {
  const token = await login();
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const listRes = await fetch(`${BASE}/api/datasources`, { headers: h });
  const listBody = await listRes.json().catch(() => null);
  const list = listBody?.dataSources || [];
  if (!listRes.ok || !list.length) throw new Error(`datasources failed: ${listBody?.error || listRes.status}`);

  const targets = list.filter((d) => /企业综合运营数仓|数据资源/.test(String(d.name)));
  if (!targets.length) throw new Error('未找到目标数据源（企业综合运营数仓 / 数据资源）');

  for (const d of targets) {
    const scope = d.scope === undefined ? null : d.scope;
    const r = await fetch(`${BASE}/api/datasources/${encodeURIComponent(d.id)}/scope`, {
      method: 'PUT',
      headers: h,
      body: JSON.stringify({ scope }),
    });
    console.log(`[clear] ${d.name} (${d.id}) -> ${r.ok ? 'OK 缓存已失效' : `FAIL ${r.status}`}`);
    if (!r.ok) console.log('   ', await r.text().catch(() => ''));
  }
  console.log('CLEAR_DONE');
};

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
