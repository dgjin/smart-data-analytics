/**
 * v0.9.93 自动运维路由契约测试：双通道鉴权（OPS_API_TOKEN / ADMIN JWT）+
 * 事件列表（过滤/游标/限幅）+ 摘要 + ack/resolve（幂等与 404/400）+ 日志尾读（501/404/过滤）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));

import opsEventsRoutes from './opsEvents';

applyTestEnv();

const app = buildApp('/api/ops', opsEventsRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

const adminAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('ADMIN', 1)] };
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };
const auditInsert: DbStubRule = { match: 'INSERT INTO query_audit_log', rows: [] };

/** INSERT/UPDATE 的 ResultSetHeader 语义返回（dbStub 原样透传行集，用「带属性的数组」冒充 affectedRows） */
const resultSet = (props: Record<string, unknown>) => Object.assign([] as unknown[], props);

const stub = (...rules: DbStubRule[]) => dbStub([adminAuth, ...rules]);

/** ops_events 行（列名与路由 SELECT 对齐） */
const eventRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  severity: 'ERROR',
  source: 'task',
  category: 'TASK',
  entity_type: 'task',
  entity_id: 't1',
  message: 'boom',
  detail: null,
  trace_id: 't1',
  status: 'NEW',
  dedup_count: 1,
  handled_by: '',
  handled_at: null,
  created_at: new Date('2026-09-30T00:00:00Z'),
  last_seen_at: new Date('2026-09-30T00:00:00Z'),
  ...over,
});

let tmpLogFile: string | null = null;

beforeEach(() => {
  querySpy.mockReset();
  delete process.env.OPS_API_TOKEN;
  delete process.env.LOG_FILE;
  querySpy.mockImplementation(stub());
});

afterEach(() => {
  delete process.env.OPS_API_TOKEN;
  delete process.env.LOG_FILE;
  if (tmpLogFile) {
    try {
      fs.unlinkSync(tmpLogFile);
    } catch {
      /* 忽略 */
    }
    tmpLogFile = null;
  }
});

describe('鉴权：双通道（OPS_API_TOKEN / ADMIN JWT）', () => {
  it('无凭据 → 401', async () => {
    const res = await request(app).get('/api/ops/events');
    expect(res.status).toBe(401);
  });

  it('OPS_API_TOKEN 正确 → 放行（机器通道不触碰 users 表）', async () => {
    process.env.OPS_API_TOKEN = 'secret-token';
    querySpy.mockImplementation(stub({ match: 'FROM ops_events', rows: () => [eventRow()] }));
    const res = await request(app).get('/api/ops/events').set('Authorization', 'Bearer secret-token');
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBe(1);
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('FROM users'))).toBe(false);
  });

  it('OPS_API_TOKEN 错误 → 回退 JWT 校验 → 401', async () => {
    process.env.OPS_API_TOKEN = 'secret-token';
    const res = await request(app).get('/api/ops/events').set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('VIEWER JWT → 403', async () => {
    querySpy.mockImplementation(dbStub([viewerAuth]));
    const res = await request(app).get('/api/ops/events').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(403);
  });

  it('ADMIN JWT → 放行', async () => {
    querySpy.mockImplementation(stub({ match: 'FROM ops_events', rows: () => [eventRow()] }));
    const res = await request(app).get('/api/ops/events').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
  });
});

describe('GET /events：过滤与游标', () => {
  it('status/severity/source 过滤生效且 limit 限幅到 200', async () => {
    querySpy.mockImplementation(stub({ match: 'FROM ops_events', rows: () => [eventRow()] }));
    const res = await request(app)
      .get('/api/ops/events?status=new&severity=error&source=task&limit=9999')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM ops_events'));
    expect(call).toBeTruthy();
    const sql = String(call![0]);
    expect(sql).toContain('status = ?');
    expect(sql).toContain('severity = ?');
    expect(sql).toContain('source = ?');
    const params = call![1] as unknown[];
    expect(params.slice(0, 3)).toEqual(['NEW', 'ERROR', 'task']);
    expect(params[params.length - 1]).toBe(200);
  });

  it('游标分页：cursor → id < ?；满页返回 nextCursor', async () => {
    querySpy.mockImplementation(
      stub({ match: 'FROM ops_events', rows: () => [eventRow({ id: 9 }), eventRow({ id: 8 })] })
    );
    const res = await request(app)
      .get('/api/ops/events?cursor=10&limit=2')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.body.nextCursor).toBe(8);
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM ops_events'));
    expect(String(call![0])).toContain('id < ?');
    expect((call![1] as unknown[])[0]).toBe(10);
  });

  it('非法 status/时间格式被忽略（不进 SQL）', async () => {
    querySpy.mockImplementation(stub({ match: 'FROM ops_events', rows: () => [] }));
    const res = await request(app)
      .get('/api/ops/events?status=HACK&since=not-a-date')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    const call = querySpy.mock.calls.find((c) => String(c[0]).includes('FROM ops_events'));
    const sql = String(call![0]);
    expect(sql).not.toContain('status = ?');
    expect(sql).not.toContain('created_at >=');
  });
});

describe('GET /events/summary：态势摘要', () => {
  it('返回状态计数与近 24h 分类分布', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'GROUP BY status', rows: () => [{ status: 'NEW', cnt: 3 }] },
        { match: 'INTERVAL 24 HOUR', rows: () => [{ category: 'TASK', severity: 'ERROR', cnt: 2 }] }
      )
    );
    const res = await request(app)
      .get('/api/ops/events/summary')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.byStatus).toEqual([{ status: 'NEW', cnt: 3 }]);
    expect(res.body.last24h[0].category).toBe('TASK');
  });
});

describe('POST /events/:id/ack 与 /resolve', () => {
  it('ack 成功（NEW → ACK）并写审计', async () => {
    querySpy.mockImplementation(
      stub({ match: 'UPDATE ops_events SET', rows: resultSet({ affectedRows: 1 }) }, auditInsert)
    );
    const res = await request(app)
      .post('/api/ops/events/7/ack')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ note: '已重启 worker' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, id: 7, status: 'ACK' });
    expect(querySpy.mock.calls.some((c) => String(c[0]).includes('INSERT INTO query_audit_log'))).toBe(true);
  });

  it('ack 幂等：已处理（affectedRows=0，现态 ACK）→ already', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'UPDATE ops_events SET', rows: resultSet({ affectedRows: 0 }) },
        { match: 'SELECT status FROM ops_events', rows: () => [{ status: 'ACK' }] }
      )
    );
    const res = await request(app)
      .post('/api/ops/events/7/ack')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({});
    expect(res.body).toMatchObject({ success: true, status: 'ACK', already: true });
  });

  it('ack 事件不存在 → 404', async () => {
    querySpy.mockImplementation(
      stub(
        { match: 'UPDATE ops_events SET', rows: resultSet({ affectedRows: 0 }) },
        { match: 'SELECT status FROM ops_events', rows: () => [] }
      )
    );
    const res = await request(app)
      .post('/api/ops/events/7/ack')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('无效 id → 400', async () => {
    const res = await request(app)
      .post('/api/ops/events/abc/ack')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(400);
  });

  it('resolve：ACK → RESOLVED', async () => {
    querySpy.mockImplementation(
      stub({ match: 'UPDATE ops_events SET', rows: resultSet({ affectedRows: 1 }) }, auditInsert)
    );
    const res = await request(app)
      .post('/api/ops/events/7/resolve')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send({ note: '已修复' });
    expect(res.body).toMatchObject({ success: true, status: 'RESOLVED' });
  });

  it('机器通道 ack 的审计归属为 ops-agent', async () => {
    process.env.OPS_API_TOKEN = 'secret-token';
    querySpy.mockImplementation(
      stub({ match: 'UPDATE ops_events SET', rows: resultSet({ affectedRows: 1 }) }, auditInsert)
    );
    await request(app)
      .post('/api/ops/events/7/ack')
      .set('Authorization', 'Bearer secret-token')
      .send({ note: 'auto' });
    const auditCall = querySpy.mock.calls.find((c) => String(c[0]).includes('INSERT INTO query_audit_log'));
    expect(auditCall).toBeTruthy();
    expect((auditCall![1] as unknown[])[1]).toBe('ops-agent');
    expect(String((auditCall![1] as unknown[])[6])).toContain('运维事件 #7 已受理');
  });
});

describe('GET /logs：JSONL 尾读', () => {
  it('未配置 LOG_FILE → 501', async () => {
    const res = await request(app).get('/api/ops/logs').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(501);
  });

  it('日志文件不存在 → 404', async () => {
    process.env.LOG_FILE = path.join(os.tmpdir(), 'definitely-not-exists-ops-test.jsonl');
    const res = await request(app).get('/api/ops/logs').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('过滤（level/requestId/关键字）+ 非 JSON 行 raw 返回 + 时间倒序', async () => {
    tmpLogFile = path.join(os.tmpdir(), `ops-logs-${process.pid}-${Date.now()}.jsonl`);
    fs.writeFileSync(
      tmpLogFile,
      [
        JSON.stringify({ ts: '2026-09-30T01:00:00Z', level: 'info', msg: '[HTTP] GET /api/x', requestId: 'r1' }),
        JSON.stringify({ ts: '2026-09-30T01:00:01Z', level: 'error', msg: '[DB] boom', requestId: 'r2' }),
        'legacy plain text line',
      ].join('\n') + '\n'
    );
    process.env.LOG_FILE = tmpLogFile;

    const all = await request(app).get('/api/ops/logs').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(all.status).toBe(200);
    const lines = all.body.lines as Array<Record<string, unknown>>;
    expect(lines.length).toBe(3);
    expect(lines[0].level).toBe('info'); // 正序（tail 语义：最新在底部）
    expect(lines[1].level).toBe('error');
    expect(lines[lines.length - 1].raw).toBe('legacy plain text line');

    const errOnly = await request(app)
      .get('/api/ops/logs?level=error')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect((errOnly.body.lines as unknown[]).length).toBe(1);

    const byReq = await request(app)
      .get('/api/ops/logs?requestId=r1')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    const reqLines = byReq.body.lines as Array<Record<string, unknown>>;
    expect(reqLines.length).toBe(1);
    expect(reqLines[0].requestId).toBe('r1');

    const byQ = await request(app)
      .get('/api/ops/logs?q=boom')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect((byQ.body.lines as unknown[]).length).toBe(1);
  });
});
