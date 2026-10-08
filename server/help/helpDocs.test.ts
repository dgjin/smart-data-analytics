/**
 * 帮助文档读取（helpDocs）测试（v0.9.100 架构图读取；v0.9.101 切换为交互式 HTML 视图器）：
 * - DIAGRAM_SPECS 元数据契约：id 顺序（推导过程 → 功能流程 → 系统架构）与字段完整；
 * - readDiagrams 读取仓库真实产物：vitest 下候选路径即项目仓 docs/diagrams/，
 *   三张核心图均已入库（git 跟踪），直接断言 available / html 视图器与 data-embed 注入 / updatedAt。
 * 文档（manual/changelog）读取分支较薄（readDoc 容错逐路径回退），此处不重复覆盖。
 */
import { describe, it, expect } from 'vitest';
import { DIAGRAM_SPECS, readDiagrams } from './helpDocs';

describe('DIAGRAM_SPECS：架构图元数据契约', () => {
  it('三张核心图按推导过程 → 功能流程 → 系统架构顺序，字段完整', () => {
    expect(DIAGRAM_SPECS.map((s) => s.id)).toEqual(['derivation', 'func-flow', 'architecture']);
    expect(DIAGRAM_SPECS.map((s) => s.title)).toEqual([
      '智能问数推导过程图',
      '系统功能流程图',
      '完整系统架构图',
    ]);
    for (const s of DIAGRAM_SPECS) {
      expect(s.filename.endsWith('.html')).toBe(true);
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

describe('readDiagrams：读取仓库真实产物', () => {
  it('三张图均可用，html 为完整交互式视图器（<html> 开标签注入 data-embed），带 updatedAt', () => {
    const items = readDiagrams();
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.available, `${item.id} 应存在（docs/diagrams/${item.filename}）`).toBe(true);
      const html = item.html ?? '';
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('archify');
      // 服务端嵌入标记：data-embed="true" 位于 <html> 开标签内（CSS 选择器中的同名字样不计）
      const openStart = html.indexOf('<html');
      const openTag = html.slice(openStart, html.indexOf('>', openStart) + 1);
      expect(openTag).toContain('data-embed="true"');
      expect(item.updatedAt).toBeTruthy();
    }
  });
});
