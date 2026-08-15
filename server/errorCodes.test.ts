import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './errorCodes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('errorCodes: P1-8 统一错误码', () => {
  it('全部错误码为非空 SCREAMING_SNAKE_CASE，且键名与码值一致', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(key).toBe(value);
      expect(value.length).toBeGreaterThan(3);
    }
  });

  it('码值全局唯一（不同失败原因不得共用同一 code）', () => {
    const values = Object.values(ERROR_CODES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('覆盖关键失败原因：输入 / 权限 / 限流 / 并发 / 计划 / LLM / 兜底', () => {
    for (const required of [
      'INVALID_INPUT',
      'FORBIDDEN',
      'AI_SWITCHED_OFF',
      'RATE_LIMITED',
      'QUERY_IN_FLIGHT',
      'PLAN_INVALID',
      'PLAN_MISMATCH',
      'NOT_FOUND',
      'SQL_REJECTED',
      'LLM_UNAVAILABLE',
      'INTERNAL_ERROR',
    ]) {
      expect(ERROR_CODES).toHaveProperty(required);
    }
  });

  it('三个业务路由的错误响应均已附带 code 字段（不遗漏裸 error 响应）', () => {
    const routesDir = join(process.cwd(), 'server', 'routes');
    for (const file of ['query.ts', 'report.ts', 'conversation.ts']) {
      const source = readFileSync(join(routesDir, file), 'utf-8');
      const bare = source.match(/res\.status\(\d+\)\.json\(\{\s*error:/);
      expect(bare, `${file} 存在未附带 code 的裸 error 响应`).toBeNull();
    }
  });
});
