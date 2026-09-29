/**
 * help 路由契约测试（v0.9.88 帮助中心「智能问答」）：
 * 鉴权守卫（登录即可用，不限角色）+ 参数校验（400）+ 成功透传（含历史清洗）+ 业务异常兜底（502）；
 * 同时覆盖既有 GET /manual、GET /changelog 的透传与 404 分支。
 * 文档读取（helpDocs）与问答业务（helpAsk.answerHelpQuestion）mock，仅验证 HTTP 契约。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { applyTestEnv, activeUserRow, tokenFor, dbStub, buildApp } from './routeTestKit';
import type { DbStubRule } from './routeTestKit';

const querySpy = vi.fn();
vi.mock('../infra/db', () => ({ getPool: () => ({ query: (...args: unknown[]) => querySpy(...args) }) }));
vi.mock('../infra/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

/** 文档读取桩（不读真实文件，404 分支可控） */
const docs = vi.hoisted(() => ({ readManual: vi.fn(), readDoc: vi.fn() }));
vi.mock('../help/helpDocs', () => ({
  readManual: docs.readManual,
  readDoc: docs.readDoc,
  candidatePaths: () => ['/nonexistent/用户使用指南.md'],
  candidatePathsFor: () => ['/nonexistent/更新日志.md'],
  CHANGELOG_FILENAME: '更新日志.md',
  MANUAL_FILENAMES: ['用户使用指南.md', '系统功能说明书.md'],
}));

/** 问答业务桩；normalizeHelpHistory 保留真实实现以验证历史清洗透传 */
const h = vi.hoisted(() => ({ answerHelpQuestion: vi.fn() }));
vi.mock('../help/helpAsk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../help/helpAsk')>();
  return { ...actual, answerHelpQuestion: h.answerHelpQuestion };
});

import helpRoutes from './help';

applyTestEnv();

const app = buildApp('/api/help', helpRoutes);

const ADMIN_TOKEN = tokenFor('ADMIN', 1);
const VIEWER_TOKEN = tokenFor('VIEWER', 9);

/** authMiddleware 回查行 */
const viewerAuth: DbStubRule = { match: 'must_change_password FROM users WHERE id', rows: () => [activeUserRow('VIEWER', 9)] };

beforeEach(() => {
  querySpy.mockReset();
  querySpy.mockImplementation(dbStub([viewerAuth]));
  docs.readManual.mockReset();
  docs.readDoc.mockReset();
  h.answerHelpQuestion.mockReset();
});

describe('鉴权守卫（authMiddleware，登录即可用）', () => {
  it('缺少 token → 401（GET 与 POST 均拦截）', async () => {
    const getRes = await request(app).get('/api/help/manual');
    expect(getRes.status).toBe(401);

    const postRes = await request(app).post('/api/help/ask').send({ question: '怎么用' });
    expect(postRes.status).toBe(401);
    expect(h.answerHelpQuestion).not.toHaveBeenCalled();
  });

  it('VIEWER 角色可访问（帮助中心不限管理员）', async () => {
    docs.readManual.mockReturnValue({ markdown: '# 指南', updatedAt: '2026-09-29T00:00:00.000Z' });
    const res = await request(app).get('/api/help/manual').set('Authorization', `Bearer ${VIEWER_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.markdown).toBe('# 指南');
  });
});

describe('GET /manual 与 /changelog：文档透传与缺失分支', () => {
  it('/manual 命中 → 200 原样返回 markdown 与 updatedAt', async () => {
    docs.readManual.mockReturnValue({ markdown: '# 使用指南', updatedAt: '2026-09-29T01:02:03.000Z' });
    const res = await request(app).get('/api/help/manual').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ markdown: '# 使用指南', updatedAt: '2026-09-29T01:02:03.000Z' });
  });

  it('/manual 文档缺失 → 404 提示文案', async () => {
    docs.readManual.mockReturnValue(null);
    const res = await request(app).get('/api/help/manual').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('使用指南文件不存在，请联系管理员');
  });

  it('/changelog 命中与缺失两分支', async () => {
    docs.readDoc.mockReturnValue({ markdown: '# 更新日志', updatedAt: 'x' });
    let res = await request(app).get('/api/help/changelog').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.markdown).toBe('# 更新日志');

    docs.readDoc.mockReturnValue(null);
    res = await request(app).get('/api/help/changelog').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /ask：智能问答契约', () => {
  const post = (body: Record<string, unknown>) =>
    request(app).post('/api/help/ask').set('Authorization', `Bearer ${VIEWER_TOKEN}`).send(body);

  it('缺 question / 纯空白 → 400，不触发问答', async () => {
    let res = await post({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('question 必填');

    res = await post({ question: '   ' });
    expect(res.status).toBe(400);
    expect(h.answerHelpQuestion).not.toHaveBeenCalled();
  });

  it('question 超过 500 字 → 400', async () => {
    const res = await post({ question: '长'.repeat(501) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('问题过长');
    expect(h.answerHelpQuestion).not.toHaveBeenCalled();
  });

  it('成功 → 200 透传 {answer, sections}；question 去除首尾空白、history 经清洗后透传', async () => {
    h.answerHelpQuestion.mockResolvedValue({ answer: 'A', sections: ['用户使用指南 · 金额单位设置'] });
    const rawHistory = [
      ...Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: `问题${i}` })),
      { role: 'system', content: '非法角色' },
    ];
    const res = await post({ question: '  金额单位在哪里设置？  ', history: rawHistory });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ answer: 'A', sections: ['用户使用指南 · 金额单位设置'] });

    const [question, history] = h.answerHelpQuestion.mock.calls[0] as [string, unknown[]];
    expect(question).toBe('金额单位在哪里设置？');
    expect(history).toHaveLength(6); // 8 条合法消息取最近 6 条，system 剔除
    expect((history[0] as { content: string }).content).toBe('问题2');
  });

  it('history 非数组 → 按空历史透传', async () => {
    h.answerHelpQuestion.mockResolvedValue({ answer: 'A', sections: [] });
    await post({ question: '怎么用', history: 'bad' });
    expect(h.answerHelpQuestion).toHaveBeenCalledWith('怎么用', []);
  });

  it('业务层异常（LLM 不可用等）→ 502 兜底文案', async () => {
    h.answerHelpQuestion.mockRejectedValue(new Error('LLM 引擎熔断开路中'));
    const res = await post({ question: '怎么用' });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('AI 回答失败');
  });
});
