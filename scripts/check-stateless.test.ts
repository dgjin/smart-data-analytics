import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheck, STATE_WHITELIST, type WhitelistEntry } from './check-stateless';

/**
 * P2-3 进程内状态巡检脚本测试：
 * - 真实仓库与白名单双向一致（CI 门禁语义本体）
 * - fixture 覆盖正/负向：未登记拦截、函数内排除、字面量常量排除、类属性识别、陈旧白名单拦截
 */

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** 构造 fixture 仓库：files 的键为 server/ 下文件名 */
function makeFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'stateless-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'server'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'server', name), content);
  }
  return dir;
}

const WL_ENTRY: WhitelistEntry = { file: 'server/a.ts', name: 'store', category: 'local-accel', reason: '测试登记' };

describe('check-stateless: 真实仓库与白名单双向一致', () => {
  it('全部命中均已登记、白名单无陈旧条目', () => {
    const r = runCheck(process.cwd());
    expect(r.violations).toEqual([]);
    expect(r.stale).toEqual([]);
    // 首次盘点 17 处；后续新增须走白名单登记流程
    expect(r.hits.length).toBeGreaterThanOrEqual(17);
    expect(STATE_WHITELIST.length).toBeGreaterThanOrEqual(17);
  });
});

describe('check-stateless: fixture 扫描规则', () => {
  it('模块级空构造器 new Map() 被识别为可变存储', () => {
    const dir = makeFixture({ 'a.ts': `const store = new Map<string, number>();\nexport const get = () => store;\n` });
    const r = runCheck(dir, [WL_ENTRY]);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ file: 'server/a.ts', name: 'store', kind: 'Map' });
    expect(r.violations).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it('未登记的新增存储触发 violation（CI 拦截语义）', () => {
    const dir = makeFixture({
      'a.ts': `const store = new Map<string, number>();\nconst extra = new Set<string>();\n`,
    });
    const r = runCheck(dir, [WL_ENTRY]);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatchObject({ file: 'server/a.ts', name: 'extra', kind: 'Set' });
  });

  it('函数/箭头函数/方法内的局部 Map 全部排除', () => {
    const dir = makeFixture({
      'a.ts': [
        `export function f() { const m = new Map<string, number>(); return m.size; }`,
        `export const g = () => { const s = new Set<string>(); return s.size; };`,
        `export class Srv { run() { const t = new Map(); return t; } }`,
        `const store = new Map<string, number>();\n`,
      ].join('\n'),
    });
    const r = runCheck(dir, [WL_ENTRY]);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].name).toBe('store');
  });

  it('字面量初始化的常量查找表排除（new Set([...]) / new Map([[...]])）', () => {
    const dir = makeFixture({
      'a.ts': [
        `const KEYWORDS = new Set(['a', 'b']);`,
        `const TABLE = new Map([[1, 'x']]);`,
        `const store = new Map<string, number>();\n`,
      ].join('\n'),
    });
    const r = runCheck(dir, [WL_ENTRY]);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].name).toBe('store');
  });

  it('类属性识别为 ClassName.propName', () => {
    const dir = makeFixture({
      'a.ts': `export class Mem { private cache = new Map<string, number>(); }\n`,
    });
    const r = runCheck(dir, []);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].name).toBe('Mem.cache');
  });

  it('白名单陈旧条目（代码已删除）被拦截', () => {
    const dir = makeFixture({ 'a.ts': `export const x = 1;\n` });
    const r = runCheck(dir, [WL_ENTRY]);
    expect(r.hits).toHaveLength(0);
    expect(r.stale).toHaveLength(1);
    expect(r.stale[0].name).toBe('store');
  });

  it('模块级对象字面量属性中的 Map 同样被识别', () => {
    const dir = makeFixture({
      'a.ts': `export const reg = { cache: new Map<string, number>() };\n`,
    });
    const r = runCheck(dir, []);
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].name).toBe('cache');
  });

  it('测试文件（*.test.ts）不参与扫描', () => {
    const dir = makeFixture({ 'a.test.ts': `const m = new Map();\n`, 'b.ts': `export const x = 1;\n` });
    const r = runCheck(dir, []);
    expect(r.hits).toHaveLength(0);
  });
});
