#!/usr/bin/env node
/**
 * probe-ds：在「数据资源」数据源上实测 m2 候选问数问题（SSE 全链路）。
 * 目的：确认改用数据资源后 m2 演示可稳定录制 —— 护栏通过 / 延迟量级 / 结果质量（SQL、图表、KPI、归因）。
 * 用法：node scripts/demo-video/probe-ds.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.SQ_BASE || 'http://127.0.0.1:3000';
const OUT = join(__dirname, 'diag');
mkdirSync(OUT, { recursive: true });

const QUESTIONS = [
  '分析各业务一级类别的累计投放金额与当年已回现情况',
  '对比各机构的累计投放金额与投资收益',
];

const login = async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const j = await r.json();
  if (!r.ok || !j?.token) throw new Error(`login failed: ${j?.error || r.status}`);
  return j.token;
};

// 解析 SSE：按 \n\n 分帧，提取 event 与 data
async function runQuestion(token, ds, question, idx) {
  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(78)}\n[probe-ds] Q${idx}: ${question}\n[probe-ds] ds=${ds.name} (${ds.id})`);

  const res = await fetch(`${BASE}/api/query/natural-language`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataSourceId: ds.id, query: question, stream: true }),
  });
  console.log(`[probe-ds] HTTP ${res.status} ct=${res.headers.get('content-type')}`);

  const summary = { question, httpStatus: res.status, events: [], done: null, error: null };
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const body = await res.json().catch(() => null);
    console.log(`[probe-ds] non-SSE JSON: ${JSON.stringify(body).slice(0, 500)}`);
    summary.done = { nonSse: body };
    writeFileSync(join(OUT, `probe-ds-q${idx}.json`), JSON.stringify(summary, null, 2));
    return summary;
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = (frame.match(/^event: (.+)$/m) || [])[1];
      const dm = frame.match(/^data: (.+)$/m);
      if (!ev || !dm) continue;
      let data = null;
      try { data = JSON.parse(dm[1]); } catch { data = { raw: dm[1].slice(0, 200) }; }
      summary.events.push({ t: +el(), ev });
      if (ev === 'stage') console.log(`[probe-ds] t=${el()}s STAGE ${data.stage}${data.detail ? ' | ' + String(data.detail).slice(0, 90) : ''}`);
      else if (ev === 'trace') console.log(`[probe-ds] t=${el()}s trace ${data.step || ''} ${String(data.title || data.detail || '').slice(0, 90)}`);
      else if (ev === 'error') { summary.error = data; console.log(`[probe-ds] t=${el()}s ERROR ${JSON.stringify(data).slice(0, 300)}`); }
      else {
        summary.done = data;
        console.log(`[probe-ds] t=${el()}s EVENT[${ev}] body keys=${Object.keys(data || {}).join(',')}`);
        if (ev === 'refuse') {
          console.log(`[probe-ds] REFUSE reason: ${String(data.refuseReason || data.reason || '').slice(0, 400)}`);
        } else if (ev === 'clarify') {
          console.log(`[probe-ds] CLARIFY: ${String(data.clarification?.question || '').slice(0, 300)}`);
        }
      }
    }
  }
  const total = +el();

  // 结果摘要
  const done = summary.done || {};
  const result = done.result || {};
  const sql = String(done.executedSql || result.executedSql || result.sql || '').replace(/\s+/g, ' ');
  const rows = result.rows || result.data || [];
  const charts = result.charts || result.chartConfigs || [];
  const kpi = result.kpiCards || result.metrics || result.kpis || [];
  const explain = String(result.aiExplanation || result.explanation || done.aiExplanation || '');
  const recs = result.recommendedQuestions || result.followups || [];
  console.log(`[probe-ds] TOTAL ${total}s  rowCount=${done.rowCount ?? result.rowCount ?? rows.length}`);
  console.log(`[probe-ds] SQL: ${sql.slice(0, 600)}`);
  console.log(`[probe-ds] rows=${rows.length} charts=${Array.isArray(charts) ? charts.length : 'n/a'} kpi=${Array.isArray(kpi) ? kpi.length : 'n/a'} recs=${Array.isArray(recs) ? recs.length : 'n/a'}`);
  if (Array.isArray(rows) && rows.length) console.log(`[probe-ds] row0=${JSON.stringify(rows[0]).slice(0, 400)}`);
  console.log(`[probe-ds] AI解释: ${explain.replace(/\n+/g, ' ').slice(0, 500)}`);
  summary.totalSec = total;
  writeFileSync(join(OUT, `probe-ds-q${idx}.json`), JSON.stringify(summary, null, 2));
  console.log(`[probe-ds] full body saved -> diag/probe-ds-q${idx}.json`);
  return summary;
}

const main = async () => {
  const token = await login();
  const listRes = await fetch(`${BASE}/api/datasources`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await listRes.json();
  const list = body?.dataSources || [];
  console.log('[probe-ds] datasources:');
  list.forEach((d, i) => console.log(`  #${i} ${d.name} (${d.id}) type=${d.type}`));
  const ds = list.find((d) => /数据资源/.test(String(d.name)));
  if (!ds) throw new Error('未找到「数据资源」数据源');
  console.log(`[probe-ds] target: ${ds.name} (${ds.id})`);

  for (let i = 0; i < QUESTIONS.length; i++) {
    try {
      await runQuestion(token, ds, QUESTIONS[i], i + 1);
    } catch (e) {
      console.error(`[probe-ds] Q${i + 1} FATAL: ${e.message}`);
    }
  }
  console.log('\nPROBE_DS_DONE');
};

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
