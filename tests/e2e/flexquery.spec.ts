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

  // 两轮择源：优先「问数范围（scope）非空」的源——无范围（全表放行）的库可能含百万行大表，
  // 真执行会被 EXPLAIN 扫描防线拦截 422（安全设计，非缺陷）；仅在无 scope 非空源时才回退全表源。
  const pick = (requireScope: boolean): PickedSource | null => {
    for (const d of candidates) {
      const all: string[] = (d.tables || []).map((t: any) => String(t?.name || '')).filter(Boolean);
      const rawScope: any[] = d.scope?.tables || [];
      const scope = rawScope.map((t) => (typeof t === 'string' ? t : String(t?.name || ''))).filter(Boolean);
      if (requireScope && scope.length === 0) continue;
      const inScope = scope.length ? all.filter((t) => scope.includes(t)) : all;
      if (inScope.length > 0) return { id: String(d.id), tables: inScope };
    }
    return null;
  };
  return pick(true) ?? pick(false);
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

  test('行数上限：选表后回退默认 10000，可选至 100000', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);

    // 行数选择器：含 100000 选项的 select 即行数选择器
    const limitSelect = page.locator('select', { has: page.locator('option', { hasText: /^100000$/ }) });
    // resetBuilder 在选表后将行数回退为默认 10000（v0.9.64 起不再降为 100），可选至 100000（执行层硬上限）
    await expect(limitSelect).toHaveValue('10000');
    const options = await limitSelect.locator('option').allTextContents();
    expect(options).toEqual(['100', '500', '1000', '5000', '10000', '50000', '100000']);
    await limitSelect.selectOption('100000');
    await expect(limitSelect).toHaveValue('100000');
  });

  test('[v0.9.76 P1] 编辑器区块：语义指标 / OR 条件组 / 时间衍生列', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);

    // P1-7：字段面板语义指标区块（默认分组下渲染；无指标时为空态引导文案）
    await expect(page.getByText(/^语义指标（\d+）$/)).toBeVisible();

    // P1-11：OR 条件组空态 → 添加一组后出现组头与计数
    await expect(page.getByText('未设置 OR 组（上方 WHERE 条件均为 AND 关系）')).toBeVisible();
    await page.getByRole('button', { name: '+ 添加 OR 组' }).click();
    await expect(page.getByText('组 1（任一满足）')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ 添加 OR 组（1/5）' })).toBeVisible();

    // P1-8：时间衍生列区块存在；未为日期维度配置时间粒度时新增入口禁用
    await expect(page.getByText('时间衍生列（同比/环比/累计/移动平均）')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ 添加衍生' })).toBeDisabled();
  });

  test('[v0.9.76 P1-9] 结果缓存：二次执行命中缓存并可强制刷新', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);
    await page.locator('[title*="点击加为维度"]').first().click();
    await page.locator('[title*="点击加为指标"]').first().click();

    // 第一次执行：结果渲染（若 10 分钟内已有同 SQL 缓存亦可能直接命中，两种都继续）
    const first = page.waitForResponse((r) => r.url().includes('/api/query/execute-sql') && r.request().method() === 'POST', { timeout: 30_000 });
    await page.getByRole('button', { name: /执行查询（真实数据库）/ }).click();
    expect((await first).status()).toBe(200);
    await expect(page.getByRole('button', { name: '导出 CSV' }).first()).toBeVisible({ timeout: 15_000 });

    // 第二次执行同 SQL → 服务端 SQL 结果缓存必命中（TTL 10 分钟），响应标记 cached=true
    const second = page.waitForResponse((r) => r.url().includes('/api/query/execute-sql') && r.request().method() === 'POST', { timeout: 30_000 });
    await page.getByRole('button', { name: /执行查询（真实数据库）/ }).click();
    const secondResp = await second;
    expect((await secondResp.json()).cached).toBe(true);
    await expect(page.getByText('缓存命中')).toBeVisible({ timeout: 15_000 });

    // 强制刷新：绕过缓存重执行（bypassCache: true），响应 cached=false
    const forced = page.waitForResponse(
      (r) => r.url().includes('/api/query/execute-sql') && r.request().method() === 'POST' && r.request().postDataJSON()?.bypassCache === true,
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: '强制刷新' }).click();
    const forcedResp = await forced;
    expect((await forcedResp.json()).cached).toBe(false);
  });

  test('[v0.9.76 P1-10] 后台执行：提交任务队列并回填结果', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);
    await page.locator('[title*="点击加为维度"]').first().click();
    await page.locator('[title*="点击加为指标"]').first().click();

    // 勾选后台执行：提示文案切换（走任务队列，不受交互超时限制）
    await page.getByLabel('后台执行（大查询）').check();
    await expect(page.getByText('后台任务走独立连接池与超时策略，提交后可在任务中心查看结果')).toBeVisible();

    const submit = page.waitForResponse(
      (r) => r.url().includes('/api/query/execute-sql-async') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /执行查询（真实数据库）/ }).click();
    expect((await submit).status()).toBe(202);

    // 前端轮询任务状态（2s 间隔）至终态后回填结果，结果区渲染导出入口
    await expect(page.getByRole('button', { name: '导出 CSV' }).first()).toBeVisible({ timeout: 60_000 });
  });

  test('[v0.9.76 P1-12] 图表下钻：点击柱状图打开明细弹层', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);
    await page.locator('[title*="点击加为维度"]').first().click();
    await page.locator('[title*="点击加为指标"]').first().click();

    const exec = page.waitForResponse((r) => r.url().includes('/api/query/execute-sql') && r.request().method() === 'POST', { timeout: 30_000 });
    await page.getByRole('button', { name: /执行查询（真实数据库）/ }).click();
    expect((await exec).status()).toBe(200);

    // 默认柱状图 + 首维度无时间粒度 → 可下钻；点击首根柱体应打开明细弹层
    const bar = page.locator('.recharts-bar-rectangle').first();
    await expect(bar).toBeVisible({ timeout: 15_000 });
    await bar.click();
    await expect(page.getByText(/^下钻明细：/)).toBeVisible({ timeout: 15_000 });
  });

  test('[v0.9.77 P2-16] 字段搜索：关键字过滤与清空恢复', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);

    const fieldRows = page.locator('[title*="点击加为维度"],[title*="点击加为指标"]');
    const total = await fieldRows.count();
    expect(total).toBeGreaterThan(0);

    // 无匹配关键字 → 字段行全部过滤 + 空态引导（拼音首字母匹配语义由 pinyin 单测覆盖）
    const search = page.getByPlaceholder('搜索字段（名称/描述）…');
    await search.fill('zzzz-not-exist');
    await expect(fieldRows).toHaveCount(0);
    await expect(page.getByText('无匹配字段').first()).toBeVisible();

    // 清空关键字 → 字段行恢复
    await search.fill('');
    await expect(fieldRows).toHaveCount(total);
  });

  test('[v0.9.77 P2-14] 执行后：预估扫描行数提示与固定报表 Excel 导出', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);
    await page.locator('[title*="点击加为维度"]').first().click();
    await page.locator('[title*="点击加为指标"]').first().click();

    const exec = page.waitForResponse(
      (r) => r.url().includes('/api/query/execute-sql') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /执行查询（真实数据库）/ }).click();
    const execResp = await exec;
    expect(execResp.status()).toBe(200);

    // P2-14a：EXPLAIN 预估扫描行数 pill（服务端评估成功时渲染；防线关闭/评估失败时不渲染，跳过断言）
    const execBody = await execResp.json();
    if (typeof execBody.estimatedRows === 'number') {
      await expect(page.getByText(/预估扫描 /)).toBeVisible({ timeout: 15_000 });
    }

    // P2-14b：保存为固定报表 → 库列表出现导出入口 → 触发 xlsx 下载（服务端重放执行）
    const name = `E2E-导出验证-${Date.now()}`;
    await page.getByPlaceholder('报表名称（固化/保存用）').fill(name);
    await page.getByRole('button', { name: '保存为固定报表' }).click();
    const exportBtn = page.locator('[title*="导出 Excel"]').first();
    await expect(exportBtn).toBeVisible({ timeout: 15_000 });
    try {
      const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
      await exportBtn.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.xlsx$/);
    } finally {
      // 清理：删除本用例创建的固定报表，避免污染环境（失败路径也执行）
      const login = await request.post('/api/auth/login', { data: ADMIN });
      const { token } = await login.json();
      const list = await request.get('/api/flex-queries', { headers: { Authorization: `Bearer ${token}` } });
      const { queries } = await list.json();
      const created = (queries as Array<{ queryId?: string; query?: { name?: string } }>).find((q) => q.query?.name === name);
      if (created?.queryId) {
        await request.delete(`/api/flex-queries/${encodeURIComponent(created.queryId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    }
  });

  test('[v0.9.77 P2-14c] 图表类型：KPI 卡片切换与堆叠开关', async ({ page, request }) => {
    const ds = await pickExecutableSource(request);
    test.skip(!ds, '环境无可执行的库表类数据源，跳过灵活查询链路');
    await openFlexQuery(page, ds!.id);
    await pickTable(page, ds!.tables[0]);
    await page.locator('[title*="点击加为维度"]').first().click();
    await page.locator('[title*="点击加为指标"]').first().click();

    const exec = page.waitForResponse(
      (r) => r.url().includes('/api/query/execute-sql') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /执行查询（真实数据库）/ }).click();
    expect((await exec).status()).toBe(200);
    await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 15_000 });

    // 切换 KPI 卡片：recharts 画布消失（纯卡片网格视图，不要求维度）
    const chartSelect = page.locator('select', { has: page.locator('option', { hasText: 'KPI 卡片' }) });
    await chartSelect.selectOption('kpi');
    await expect(page.locator('.recharts-surface')).toHaveCount(0);

    // 切回柱状图恢复渲染；勾选「堆叠」开关图表不崩溃（≥2 指标才有堆叠视觉差异）
    await chartSelect.selectOption('bar');
    await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 10_000 });
    await page.locator('label', { hasText: '堆叠' }).locator('input[type="checkbox"]').check();
    await expect(page.locator('.recharts-surface').first()).toBeVisible();
  });
});
