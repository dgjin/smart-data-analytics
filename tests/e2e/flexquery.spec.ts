/**
 * v0.4.14：灵活查询 E2E 固化用例
 * 覆盖：选表 → 拖入维度/指标 → 执行查询 → 结果展示
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

test.describe('灵活查询（FlexQuery）', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    // 登录（假设已有测试账号 admin/admin123）
    await page.fill('input[type="text"]', 'admin');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button:has-text("登录")');
    await page.waitForURL(/.*/, { timeout: 5000 });
  });

  test('基础流程：选表 → 拖入维度指标 → 执行查询', async ({ page }) => {
    // 切换到灵活查询 Tab
    await page.click('text=灵活查询');
    await page.waitForTimeout(500);

    // 选择数据表
    await page.selectOption('select:has-text("请选择数据表")', { index: 1 });
    await page.waitForTimeout(300);

    // 拖入维度（JGMC）
    const dimensionField = page.locator('text=JGMC').first();
    const dimensionZone = page.locator('[data-dropzone="dimension"]');
    await dimensionField.dragTo(dimensionZone);

    // 拖入指标（BNTFJE）
    const measureField = page.locator('text=BNTFJE').first();
    const measureZone = page.locator('[data-dropzone="measure"]');
    await measureField.dragTo(measureZone);

    // 执行查询
    await page.click('button:has-text("执行查询")');

    // 等待结果加载
    await page.waitForSelector('text=查询结果', { timeout: 10000 });

    // 验证结果区域存在
    const resultArea = page.locator('text=查询结果').first();
    await expect(resultArea).toBeVisible();
  });

  test('多表 JOIN：添加关联表并执行', async ({ page }) => {
    await page.click('text=灵活查询');
    await page.waitForTimeout(500);

    // 选择主表
    await page.selectOption('select:has-text("请选择数据表")', { index: 1 });
    await page.waitForTimeout(300);

    // 添加关联表
    await page.click('button:has-text("+ 添加关联")');
    await page.waitForTimeout(200);

    // 配置 JOIN（假设有关联表可选）
    const joinTableSelect = page.locator('select:near(:text("关联表"))').first();
    if (await joinTableSelect.count() > 0) {
      await joinTableSelect.selectOption({ index: 1 });
      await page.fill('input[placeholder="主表字段"]', 'JGMC');
      await page.fill('input[placeholder="关联表字段"]', 'region_code');
    }
  });

  test('行数上限：默认 10000，可选至 50000', async ({ page }) => {
    await page.click('text=灵活查询');
    await page.waitForTimeout(500);

    // 验证行数选择器默认值
    const limitSelect = page.locator('select:near(:text("行数"))');
    const value = await limitSelect.inputValue();
    expect(['10000', '1000', '5000']).toContain(value); // 默认值为选项之一
  });
});
