/**
 * 全局错误边界测试：正常子树透传渲染、渲染崩溃兜底 UI 与错误详情展示。
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb(): never {
  throw new Error('测试爆炸');
}

let consoleErrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React 自身也会把捕获的错误打到 console.error，静默以保持测试输出干净
  consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleErrSpy.mockRestore();
  cleanup();
});

describe('ErrorBoundary', () => {
  it('子树正常时原样渲染 children', () => {
    render(
      <ErrorBoundary>
        <div>正常内容</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('正常内容')).toBeTruthy();
    expect(screen.queryByText('页面渲染出现异常')).toBeNull();
  });

  it('子树抛错时展示兜底 UI 与错误详情', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    expect(screen.getByText('页面渲染出现异常')).toBeTruthy();
    expect(screen.getByText('测试爆炸')).toBeTruthy();
    expect(screen.getByText('刷新页面')).toBeTruthy();
  });

  it('崩溃时通过 console.error 记录 componentStack', () => {
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );
    const calls = consoleErrSpy.mock.calls;
    expect(
      calls.some((args) => String(args[0]).includes('[ErrorBoundary]'))
    ).toBe(true);
  });
});
