/**
 * P2-10 前端工具测试：对话 Markdown 导出构建（标题/元信息/逐消息段落/SQL 代码块）。
 */
import { describe, expect, it } from 'vitest';
import { buildConversationMarkdown } from './conversationExport';
import { ChatMessage } from '../types/analytics';

function msg(
  partial: Partial<ChatMessage> & { role: ChatMessage['role']; content: string } & Record<string, unknown>,
): ChatMessage {
  return {
    id: partial.id || `m_${Math.random().toString(36).slice(2)}`,
    timestamp: partial.timestamp || new Date().toISOString(),
    ...partial,
  } as ChatMessage;
}

describe('buildConversationMarkdown', () => {
  it('包含标题、数据源与消息条数元信息', () => {
    const md = buildConversationMarkdown(
      [msg({ role: 'user', content: '本月拜访多少客户？' })],
      '客户拜访管理',
    );
    expect(md).toContain('# 智能问数对话导出');
    expect(md).toContain('- 数据源：客户拜访管理');
    expect(md).toContain('- 消息条数：1');
    expect(md).toContain('- 导出时间：');
  });

  it('按序输出用户提问与系统回答标题', () => {
    const md = buildConversationMarkdown(
      [
        msg({ role: 'user', content: '问一句' }),
        msg({ role: 'assistant', content: '答一句' }),
      ],
      '演示源',
    );
    expect(md).toContain('## 1. 用户提问');
    expect(md).toContain('问一句');
    expect(md).toContain('## 2. 系统回答');
    expect(md).toContain('答一句');
  });

  it('assistant 消息带 generatedSQL 时追加 sql 代码块', () => {
    const md = buildConversationMarkdown(
      [
        msg({ role: 'user', content: 'q' }),
        msg({ role: 'assistant', content: 'a', result: { generatedSQL: 'SELECT COUNT(*) FROM visits' } as any }),
      ],
      '演示源',
    );
    expect(md).toContain('```sql');
    expect(md).toContain('SELECT COUNT(*) FROM visits');
  });

  it('无 SQL 或纯空白 SQL 时不生成代码块', () => {
    const md = buildConversationMarkdown(
      [
        msg({ role: 'user', content: 'q' }),
        msg({ role: 'assistant', content: 'a' }),
        msg({ role: 'assistant', content: 'b', result: { generatedSQL: '   ' } as any }),
      ],
      '演示源',
    );
    expect(md).not.toContain('```sql');
  });

  it('空白内容以（无内容）占位', () => {
    const md = buildConversationMarkdown([msg({ role: 'user', content: '   ' })], '演示源');
    expect(md).toContain('（无内容）');
  });
});
