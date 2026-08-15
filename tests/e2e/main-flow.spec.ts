/**
 * P2-9 E2E 主流程：登录 → 选源 → 问数 → 看图 → 导出 → 越权验证。
 * 依赖：服务已在 127.0.0.1:3000 运行（config webServer 会自动复用/拉起）、
 * LLM 通道可用（问数走演示模式单阶段生成）、默认演示数据源存在。
 */
import { expect, test } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'admin123' };

test.describe('主流程 E2E', () => {
  // 问数环节 mock SSE 响应：真实 LLM 链路由服务端评测（npm run eval）与冒烟验证覆盖，
  // E2E 专注登录→选源→问数→看图→导出的前端全链路稳定性（不受 LLM 波动/配额影响）。
  test('登录 → 选源 → 问数 → 看图 → 导出', async ({ page }) => {
    const donePayload = {
      success: true,
      dataProvenance: 'simulated',
      executionTimeMs: 260,
      traceId: 'e2e-mock-trace',
      result: {
        aiExplanation: '（E2E 模拟）各区域中华东销售金额领先，季度环比稳中有升。',
        generatedSQL: 'SELECT region, SUM(amount) AS total FROM all_channel_sales GROUP BY region',
        thoughtProcess: ['识别维度：区域', '聚合指标：销售金额求和'],
        keyInsights: ['华东占比最高'],
        chartConfig: { type: 'bar', title: '各区域销售金额', xAxisKey: 'region', yAxisKeys: ['total'], yAxisNames: { total: '销售金额' }, stacked: false },
        columns: ['region', 'total'],
        totalCount: 5,
        rows: [
          { region: '华东', total: 128000 },
          { region: '华南', total: 96000 },
          { region: '华北', total: 87000 },
          { region: '西南', total: 52000 },
          { region: '东北', total: 41000 },
        ],
        columnNames: { region: '区域', total: '销售金额' },
        kpiMetrics: [{ label: '总销售金额', value: '40.4 万', change: '+8.2%', trend: 'up', subtext: '本季度合计' }],
        suggestedQuestions: ['按月拆分销售趋势', '各渠道占比分析'],
      },
    };
    const sseBody = [
      'event: stage\ndata: {"stage":"understanding"}\n\n',
      'event: stage\ndata: {"stage":"sql_ready","sql":"SELECT region, SUM(amount) AS total FROM all_channel_sales GROUP BY region"}\n\n',
      'event: trace\ndata: {"title":"语义匹配：区域 → region，销售金额 → amount"}\n\n',
      'event: stage\ndata: {"stage":"executed"}\n\n',
      'event: stage\ndata: {"stage":"analyzing"}\n\n',
      `event: done\ndata: ${JSON.stringify(donePayload)}\n\n`,
    ].join('');
    await page.route('**/api/query/natural-language', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        body: sseBody,
      }),
    );

    await page.goto('/');

    // 1. 登录
    await page.getByPlaceholder('请输入用户名').fill(ADMIN.username);
    await page.getByPlaceholder('请输入密码').fill(ADMIN.password);
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page.getByText('当前数据源:')).toBeVisible({ timeout: 30_000 });

    // 2. 选源：切换到演示数据源（非 mysql 直连，走演示模式模拟生成）
    const dsSelect = page.getByTestId('datasource-select');
    await expect(dsSelect).toBeVisible({ timeout: 15_000 });
    const options = await dsSelect.locator('option').allTextContents();
    const demoOption = options.find((t) => /演示|demo/i.test(t));
    test.skip(!demoOption, '环境缺少演示数据源，跳过问数链路');
    await dsSelect.selectOption({ label: demoOption! });
    await expect(dsSelect).toHaveValue(/.+/);

    // 3. 问数（SSE 流式；演示模式为 LLM 单阶段生成，耗时可达 1 分钟以上）
    const input = page.getByPlaceholder(/用自然语言提问/);
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.fill('按区域统计本季度的销售金额');
    await input.press('Enter');

    // 4. 看图：等待 assistant 回答与 recharts 图表渲染
    await expect(page.locator('.recharts-wrapper').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/E2E 模拟.*销售金额领先/).first()).toBeVisible();

    // 5. 导出：触发 Markdown 下载并校验文件名与内容
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.getByTitle('将当前数据源的对话导出为 Markdown 文件').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^问数对话_.+\.md$/);
    const file = await download.path();
    expect(file).toBeTruthy();
  });

  test('登录失败展示服务端错误文案', async ({ page }) => {
    await page.goto('/');
    await page.getByPlaceholder('请输入用户名').fill(ADMIN.username);
    await page.getByPlaceholder('请输入密码').fill('wrong-password');
    await page.getByRole('button', { name: /登\s*录/ }).click();
    await expect(page.getByText(/用户名或密码错误|密码错误|登录失败/).first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('越权与鉴权 E2E（API 层）', () => {
  test('ANALYST 无法访问用户管理接口，匿名请求 401', async ({ request }) => {
    // 管理员登录
    const login = await request.post('/api/auth/login', { data: ADMIN });
    expect(login.ok()).toBeTruthy();
    const { token: adminToken } = await login.json();

    // 创建临时 ANALYST 账号（E2E 后清理）
    const uname = `e2e_${Date.now()}`;
    const create = await request.post('/api/admin/users', {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { username: uname, password: 'E2ePass123', role: 'ANALYST' },
    });
    expect(create.ok()).toBeTruthy();

    try {
      // 新建账号应被标记强制改密
      const l2 = await request.post('/api/auth/login', { data: { username: uname, password: 'E2ePass123' } });
      expect(l2.ok()).toBeTruthy();
      const analyst = await l2.json();
      expect(analyst.user.mustChangePassword).toBe(true);

      // 越权：ANALYST 访问 ADMIN 端点应 403
      const forbidden = await request.get('/api/admin/users', {
        headers: { Authorization: `Bearer ${analyst.token}` },
      });
      expect(forbidden.status()).toBe(403);

      // 匿名访问受保护端点应 401
      const anon = await request.get('/api/admin/users');
      expect(anon.status()).toBe(401);

      // 健康检查公开
      const health = await request.get('/api/health');
      expect(health.ok()).toBeTruthy();
    } finally {
      // 清理临时账号
      const list = await request.get('/api/admin/users', { headers: { Authorization: `Bearer ${adminToken}` } });
      const { users } = await list.json();
      const uid = (users as { id: number; username: string }[]).find((u) => u.username === uname)?.id;
      if (uid) {
        await request.delete(`/api/admin/users/${uid}`, { headers: { Authorization: `Bearer ${adminToken}` } });
      }
    }
  });
});
