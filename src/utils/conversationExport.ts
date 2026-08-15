/**
 * P1-6 QueryChat 拆分：对话 Markdown 导出（问题 + 回答 + SQL）构建与下载。
 */
import { ChatMessage } from '../types/analytics';

/** 构建对话导出 Markdown 文本（纯函数，便于单测） */
export function buildConversationMarkdown(messages: ChatMessage[], dsName: string): string {
  const lines: string[] = [
    '# 智能问数对话导出',
    '',
    `- 数据源：${dsName}`,
    `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
    `- 消息条数：${messages.length}`,
    '',
  ];
  messages.forEach((msg, idx) => {
    lines.push(`## ${idx + 1}. ${msg.role === 'user' ? '用户提问' : '系统回答'}`);
    lines.push('');
    lines.push(String(msg.content || '').trim() || '（无内容）');
    const sql = (msg as any).result?.generatedSQL;
    if (msg.role === 'assistant' && typeof sql === 'string' && sql.trim()) {
      lines.push('', '```sql', sql.trim(), '```');
    }
    lines.push('');
  });
  return lines.join('\n');
}

/** 触发浏览器下载 Markdown 文件（沿用 Blob + a.click 方案） */
export function downloadMarkdownFile(content: string, dsName: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `问数对话_${dsName}_${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(url);
}
