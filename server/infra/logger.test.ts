/**
 * v0.9.93 结构化日志单测：记录构建（字段协议）/模块标签提取/Error 序列化/值安全化。
 * 只测纯函数（buildLogRecord 等，不经 IO）——写入通道（fd/格式自适应）由运行时行为保证。
 */
import { describe, it, expect } from 'vitest';
import { buildLogRecord, extractModuleTag, serializeError, safeValue } from './logger';
import { runWithLogContext } from './asyncContext';

describe('extractModuleTag：[Module] 前缀提取', () => {
  it('常规模块标签（兼容空格与短横线）', () => {
    expect(extractModuleTag('[TaskQueue] worker 已启动')).toBe('TaskQueue');
    expect(extractModuleTag('[HTTP] GET /api/x')).toBe('HTTP');
    expect(extractModuleTag('[Ops-Events] x')).toBe('Ops-Events');
  });

  it('无标签 / 数字开头 / 超长标签不提取', () => {
    expect(extractModuleTag('纯消息')).toBeUndefined();
    expect(extractModuleTag('[123] x')).toBeUndefined();
    expect(extractModuleTag(`[${'A'.repeat(40)}] x`)).toBeUndefined();
  });
});

describe('buildLogRecord：结构化字段协议', () => {
  it('基础字段 ts/level/msg + module 提取', () => {
    const r = buildLogRecord('info', '[TaskQueue] worker 已启动', []);
    expect(r.level).toBe('info');
    expect(r.msg).toBe('[TaskQueue] worker 已启动');
    expect(r.module).toBe('TaskQueue');
    expect(typeof r.ts).toBe('string');
    expect(Number.isNaN(Date.parse(r.ts as string))).toBe(false);
  });

  it('Error 实参 → err 字段（name/message/code/stack 透传）', () => {
    const err = Object.assign(new Error('boom'), { code: 'ECONNREFUSED', errno: -61 });
    const r = buildLogRecord('error', '[DB] 连接失败:', [err]);
    expect(r.err).toMatchObject({ name: 'Error', message: 'boom', code: 'ECONNREFUSED', errno: '-61' });
    expect(String((r.err as Record<string, unknown>).stack)).toContain('boom');
  });

  it('多个 Error → err 数组；非 Error 实参 → args 数组', () => {
    const multi = buildLogRecord('error', 'multi', [new Error('a'), new Error('b')]);
    expect(Array.isArray(multi.err)).toBe(true);
    expect((multi.err as unknown[]).length).toBe(2);
    const mixed = buildLogRecord('warn', '[X] msg', ['suffix', 42, { k: 'v' }]);
    expect(mixed.args).toEqual(['suffix', 42, { k: 'v' }]);
  });

  it('asyncContext 字段自动注入（requestId/userId/username/taskId/taskType）', () => {
    runWithLogContext(
      { requestId: 'r9', userId: 3, username: 'alice', taskId: 't9', taskType: 'report_generate' },
      () => {
        const r = buildLogRecord('info', '[HTTP] GET /', []);
        expect(r).toMatchObject({
          requestId: 'r9',
          userId: 3,
          username: 'alice',
          taskId: 't9',
          taskType: 'report_generate',
        });
      }
    );
  });

  it('无上下文时不注入链路字段', () => {
    const r = buildLogRecord('info', 'orphan', []);
    expect(r.requestId).toBeUndefined();
    expect(r.taskId).toBeUndefined();
  });

  it('对象消息保留结构；超长字符串截断', () => {
    const obj = buildLogRecord('info', { a: 1 }, []);
    expect(obj.msg).toEqual({ a: 1 });
    const long = buildLogRecord('info', 'x'.repeat(5000), []);
    expect(String(long.msg)).toContain('[truncated');
  });
});

describe('safeValue / serializeError：序列化安全', () => {
  it('循环引用不抛错（深度兜底）', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => safeValue(cyclic)).not.toThrow();
  });

  it('BigInt / 函数 / Symbol 兜底为字符串', () => {
    expect(safeValue(10n)).toBe('10n');
    expect(typeof safeValue(() => 1)).toBe('string');
    expect(typeof safeValue(Symbol('s'))).toBe('string');
  });

  it('Date → ISO 字符串', () => {
    expect(safeValue(new Date('2026-09-30T00:00:00Z'))).toBe('2026-09-30T00:00:00.000Z');
  });

  it('无栈 Error 也完整输出（SSR/跨域错误常见）', () => {
    const err = new Error('no stack');
    delete (err as { stack?: string }).stack;
    const r = serializeError(err);
    expect(r).toMatchObject({ name: 'Error', message: 'no stack' });
    expect(r.stack).toBeUndefined();
  });

  it('超长错误消息截断', () => {
    const r = serializeError(new Error('y'.repeat(3000)));
    expect(String(r.message)).toContain('[truncated');
  });
});
