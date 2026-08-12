import { describe, expect, it, vi } from 'vitest';

// mock 数据库与 embedding：编辑链路只验证 docId 复用与切块入库次数
const querySpy = vi.fn(async (..._args: any[]) => [{ affectedRows: 1 }, []]);
vi.mock('./db', () => ({ getPool: () => ({ query: (...args: any[]) => querySpy(...args) }) }));
vi.mock('./llmClient', () => ({ callEmbedding: vi.fn(async () => { throw new Error('无 embedding 模型'); }) }));

import { saveKnowledgeDoc } from './knowledgeBase';

describe('saveKnowledgeDoc: 登记与编辑（docId 复用）', () => {
  it('新增时生成 kb_ 前缀 docId 并按块入库', async () => {
    querySpy.mockClear();
    const { docId, chunkCount } = await saveKnowledgeDoc('ds1', '口径', '不良率 = 不良余额 / 总余额', 'admin');
    expect(docId).toMatch(/^kb_/);
    expect(chunkCount).toBe(1);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('编辑时传入 existingDocId 原样复用（不生成新 id）', async () => {
    const { docId } = await saveKnowledgeDoc('ds1', '口径v2', '更新后的口径说明', 'admin', 'kb_fixed_123');
    expect(docId).toBe('kb_fixed_123');
  });

  it('多段落内容切多块且逐块入库', async () => {
    querySpy.mockClear();
    // 每段 460 字 > CHUNK_SIZE(400)，段落无法合并，各自独立成块
    const content = Array.from({ length: 3 }, (_, i) => `段落${i}：${'知识内容'.repeat(115)}`).join('\n');
    const { chunkCount } = await saveKnowledgeDoc('ds1', '长文档', content, 'admin');
    expect(chunkCount).toBeGreaterThanOrEqual(3);
    expect(querySpy).toHaveBeenCalledTimes(chunkCount);
  });

  it('空内容返回 0 块且不写库', async () => {
    querySpy.mockClear();
    const { chunkCount } = await saveKnowledgeDoc('ds1', '空', '   ', 'admin');
    expect(chunkCount).toBe(0);
    expect(querySpy).not.toHaveBeenCalled();
  });
});
