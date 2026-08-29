/**
 * Phase 1-4 冒烟回归：针对近期三次 critical 缺陷各一条防线用例（改进计划 1-4）。
 * 1) 页面加载无白屏（ErrorBoundary 不触发）
 *    —— 防线对象：渲染期异常直接白屏的回归（如 ErrorBoundary/下游组件类型级崩溃）。
 * 2) 核心 API 一律返回 JSON，绝不回退 HTML
 *    —— 防线对象：未匹配 /api/* 或鉴权失败时返回 index.html/Express HTML 错误页，
 *       导致前端 res.json() 抛出 "Unexpected token '<', <!DOCTYPE..." 的回归。
 * 3) 知识库面板加载非空
 *    —— 防线对象：/api/knowledge CRUD 路由缺失导致知识库面板空白的回归（cb8ed88）。
 */
import { expect, test, type Page } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'admin123' };

async function loginAsAdmin(page: Page) {
  await page.goto('/');
  await page.getByPlaceholder('请输入用户名').fill(ADMIN.username);
  await page.getByPlaceholder('请输入密码').fill(ADMIN.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page.getByText('当前数据源:')).toBeVisible({ timeout: 30_000 });
}

test.describe('冒烟：critical 回归防线', () => {
  test('登录后主界面正常渲染，ErrorBoundary 白屏兜底不触发', async ({ page }) => {
    await loginAsAdmin(page);
    // 主界面骨架就绪：侧边导航可见
    await expect(page.getByRole('button', { name: /数据源与 Schema/ }).first()).toBeVisible();
    // ErrorBoundary 兜底 UI 不得出现（出现即代表渲染链崩溃）
    await expect(page.getByText('页面渲染出现异常')).toHaveCount(0);
  });

  test('核心 API 返回 JSON：健康检查 200 / 未知路由 404 JSON / 未授权 401 JSON', async ({ request }) => {
    // 健康检查：公开端点，必须 JSON
    const health = await request.get('/api/health');
    expect(health.status()).toBe(200);
    expect(health.headers()['content-type']).toContain('application/json');
    const healthBody = await health.json();
    expect(healthBody.status).toBe('ok');

    // 未知 API 路由：必须 404 JSON（而非 SPA fallback 的 index.html）
    const notFound = await request.get('/api/__smoke_no_such_endpoint__');
    expect(notFound.status()).toBe(404);
    expect(notFound.headers()['content-type']).toContain('application/json');
    const nfBody = await notFound.json();
    expect(nfBody.error).toBeTruthy();

    // 受保护端点匿名访问：必须 401 JSON（而非 HTML 错误页）
    const anon = await request.get('/api/admin/users');
    expect(anon.status()).toBe(401);
    expect(anon.headers()['content-type']).toContain('application/json');
  });

  test('知识库面板加载非空：CRUD 路由在线且面板渲染无错误', async ({ page, request }) => {
    // API 层防线：知识库列表路由必须存在（cb8ed88 前因路由缺失返回 404 → 面板空白）
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok()).toBeTruthy();
    const { token } = await login.json();
    const dsResp = await request.get('/api/datasources', { headers: { Authorization: `Bearer ${token}` } });
    expect(dsResp.ok()).toBeTruthy();
    const { dataSources } = await dsResp.json();
    test.skip(!dataSources?.length, '环境无任何数据源，跳过知识库链路');
    const dsId = dataSources[0].id;
    const kbResp = await request.get(`/api/knowledge?dataSourceId=${encodeURIComponent(dsId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(kbResp.status()).toBe(200);
    expect(kbResp.headers()['content-type']).toContain('application/json');
    const kbBody = await kbResp.json();
    expect(Array.isArray(kbBody.docs)).toBeTruthy();

    // UI 层防线：面板真实渲染、接口 200、无错误横幅
    await loginAsAdmin(page);
    await page.getByRole('button', { name: /数据源与 Schema/ }).first().click();
    // 先挂响应监听再点击，避免面板挂载即发的 loadDocs 请求被漏捕
    const kbResponse = page.waitForResponse(
      (r) => r.url().includes('/api/knowledge?') && r.request().method() === 'GET',
      { timeout: 15_000 },
    );
    await page.getByRole('button', { name: /业务知识库 \(Knowledge Base\)/ }).click();
    expect((await kbResponse).status()).toBe(200);
    // 面板头部与 ADMIN 操作区渲染完成
    await expect(page.getByRole('button', { name: /登记知识/ })).toBeVisible({ timeout: 15_000 });
    // 不得出现"加载知识库失败"错误横幅（路由缺失/返回 HTML 时的直接表现）
    await expect(page.getByText(/加载知识库失败/)).toHaveCount(0);
  });
});
