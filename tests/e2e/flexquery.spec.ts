/**
 * 灵活查询 E2E 固化用例（对齐 v0.4.15 现行 UI 重写：点击加字段 / JOIN 下拉化 / 行数选择器）。
 * 覆盖：选源选表 → 点击添加维度/指标 → SQL 预览 → 执行查询 → 结果展示；多表 JOIN 配置；行数上限。
 * 依赖：服务已在 BASE_URL 运行、admin/admin123 可用、环境至少有一个含问数范围的库表类数据源。
 * 选源策略：先经 API 读取各数据源「问数范围（scope）」，选中含范围内表的库表类数据源——
 * 灵活查询执行走 SELECT-only 安全执行层，范围外表会被 422 拒绝（安全设计，非缺陷）。
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

const ADMIN = { username: 'admin', password: 'admin123' };

interface PickedSource {
  id: string;
  /** 问数范围内的表名（执行只对这些表放行） */
  tables: string[];
}

/** 经 API 选出可真实执行的数据源：库表类 + connected + 问数范围非空（MySQL 优先，本地可达性最好） */
async function pickExecutableSource(request: APIRequestContext): Promise<PickedSource | null> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  if (!login.ok()) return null;
  const { token } = await login.json();
  const resp = await request.get('/api/datasources', { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok()) return null;
  const { dataSources } = await resp.json();
  const candidates = (dataSources as any[])
    .filter((d) => ['mysql', 'postgresql', 'greenplum'].includes(d.type) && d.status === 'connected')
    .sort((a, b) => (a.type === 'mysql' ? 0 : 1) - (b.type === 'mysql' ? 0 : 1));
  for (const d of candidates) {
    const all: string[] = (d.tables || []).map((t: any) => String(t?.name || '')).filter(Boolean);
    const rawScope: any[] = d.scope?.tables || [];
    const scope = rawScope.map((t) => (typeof t === 'string' ? t : String(t?.name || ''))).filter(Boolean);
    const inScope = scope.length ? all.filter((t) => scope.includes(t)) : all;
    if (inScope.length > 0) return { id: String(d.id), tables: inScope };
  }
  return null;
}

/** 登录并进入灵活查询页，按 API 预选结果切换数据源 */
async function openFlexQuery(page: Page, dsId: string) {
  await page.goto('/');
  await page.getByPlaceholder('请输入用户名').fill(ADMIN.username);
  await page.getByPlaceholder('请输入密码').fill(ADMIN.password);
  await page.getByRole('button', { name: /登\s*录/ }).click();
  await expect(page.getByText('当前数据源:')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: '灵活查询' }).first().click();
  await expect(page.getByText('灵活查询 · 拖拉拽定制固定报表')).toBeVisible({ timeout: 15_000 });

  const dsSelect = page.getByTestId('flexquery-datasource-select');
  await expect(dsSelect.locator(`option[value="${dsId}"]`)).toBeAttached({ timeout: 15_000 });
  await dsSelect.selectOption(dsId);

  // 等待 flex-schema 加载完成：目标表出现在表选择器中
  const tableSelect = page.getByTestId('flexquery-table-select');
  await expect(tableSelect).toBeVisible({ timeout: 15_000 });
}

/** 选中指定表并等待字段面板渲染 */
async function pickTable(page: Page, table: string) {
  const tableSelect = page.getByTestId('flexquery-table-select');
  await expect(tableSelect.locator(`option[value="${table}"]`)).toBeAttached({ timeout: 15_000 });
  await tableSelect.selectOption(table);
  // 选中后字段面板渲染出维度/指标分组
  await expect(page.getByText(/^维度字段（[1-9]/)).toBeVisible({ timeout: 10_000 });
}

test.describe('灵活查询（FlexQuery）', () => {
  test('基础流程：选表 → 添加维度/指标 → 执行查询 → 结果展示', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);

    // 点击字段行即按类型加入维度/指标区（title 由组件内置提示，稳定锚点）
    await page.locator('[title*="点击加为维度"]').first().click();
    await page.locator('[title*="点击加为指标"]').first().click();

    // SQL 预览实时生成
    await expect(page.locator('code').filter({ hasText: /SELECT/ }).first()).toBeVisible();

    // 执行查询（真实数据库；服务端超时上限 10s）
    const execResp = page.waitForResponse(
      (r) => r.url().includes('/api/query/execute-sql') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /执行查询（真实数据库）/ }).click();
    expect((await execResp).status()).toBe(200);

    // 结果区：仅在有结果时渲染「导出 CSV」（结果区与明细工具栏各一枚，取其一）；空态文案必须消失
    await expect(page.getByRole('button', { name: '导出 CSV' }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('执行查询后在此展示图表与明细')).toHaveCount(0);
  });

  test('多表 JOIN：添加关联表并生成 JOIN SQL', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds || ds!.tables.length < 2, '环境无含两张范围内表的库表类数据源，跳过 JOIN 用例');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);

    // 添加关联：选关联表 → 选主表字段 → 选关联表字段（v0.4.15 下拉化）
    await page.getByRole('button', { name: '+ 添加关联' }).click();
    await page.locator('select', { has: page.locator('option', { hasText: '选表…' }) }).selectOption(ds!.tables[1]);
    await page.locator('select', { has: page.locator('option', { hasText: '主表字段…' }) }).selectOption({ index: 1 });
    await page.locator('select', { has: page.locator('option', { hasText: '关联表字段…' }) }).selectOption({ index: 1 });

    // JOIN 配置后 SQL 预览实时生成 JOIN 语句（执行正确性由单测 buildFlexQuerySql 覆盖）
    await page.locator('[title*="点击加为维度"]').first().click();
    await expect(page.locator('code').filter({ hasText: /JOIN/ }).first()).toBeVisible();
  });

  test('行数上限：选表后回退防爆量 100，可选至 50000', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);

    // 行数选择器：含 50000 选项的 select 即行数选择器
    const limitSelect = page.locator('select', { has: page.locator('option', { hasText: /^50000$/ }) });
    // resetBuilder 在选表后将行数回退为 100（首次查询防爆量），可选至 50000
    await expect(limitSelect).toHaveValue('100');
    const options = await limitSelect.locator('option').allTextContents();
    expect(options).toEqual(['100', '500', '1000', '5000', '10000', '50000']);
    await limitSelect.selectOption('50000');
    await expect(limitSelect).toHaveValue('50000');
  });
});
