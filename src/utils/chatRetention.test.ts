import { describe, expect, it } from 'vitest';
import { MAX_MESSAGES_PER_SOURCE, trimChatMessages } from './chatRetention';

interface Msg {
  id: number;
  dataSourceId?: string;
}

const msg = (id: number, ds: string): Msg => ({ id, dataSourceId: ds });

describe('trimChatMessages: P2-2 对话滚动上限', () => {
  it('总量未超单源上限时原样返回（快路径）', () => {
    const msgs = [msg(1, 'a'), msg(2, 'b')];
    expect(trimChatMessages(msgs)).toBe(msgs);
  });

  it('单源超出上限时仅保留该源最近 N 条，顺序不变', () => {
    const msgs = Array.from({ length: 250 }, (_, i) => msg(i, 'a'));
    const out = trimChatMessages(msgs);
    expect(out).toHaveLength(MAX_MESSAGES_PER_SOURCE);
    // 保留的是最新的 200 条（id 50..249）
    expect(out[0].id).toBe(50);
    expect(out[out.length - 1].id).toBe(249);
  });

  it('多源分组各自独立计数，互不挤占', () => {
    const a = Array.from({ length: 200 }, (_, i) => msg(i, 'a'));
    const b = Array.from({ length: 300 }, (_, i) => msg(1000 + i, 'b'));
    const out = trimChatMessages([...a, ...b], 200);
    const aCount = out.filter((m) => m.dataSourceId === 'a').length;
    const bCount = out.filter((m) => m.dataSourceId === 'b').length;
    expect(aCount).toBe(200);
    expect(bCount).toBe(200);
    // b 组保留最后 200 条（id 1100..1299）
    const bIds = out.filter((m) => m.dataSourceId === 'b').map((m) => m.id);
    expect(Math.min(...bIds)).toBe(1100);
  });

  it('无归属消息单独限量，不占用数据源配额', () => {
    const unassigned = Array.from({ length: 80 }, (_, i) => ({ id: i }) as Msg);
    const a = Array.from({ length: 250 }, (_, i) => msg(1000 + i, 'a'));
    const out = trimChatMessages([...unassigned, ...a], 200, 50);
    expect(out.filter((m) => !m.dataSourceId)).toHaveLength(50);
    // 无归属保留的是最新 50 条（id 30..79）
    const unIds = out.filter((m) => !m.dataSourceId).map((m) => m.id);
    expect(Math.min(...unIds)).toBe(30);
    expect(out.filter((m) => m.dataSourceId === 'a')).toHaveLength(200);
  });

  it('自定义上限生效（0 表示该组全部淘汰）', () => {
    const msgs = [msg(1, 'a'), msg(2, 'a'), msg(3, 'b')];
    const out = trimChatMessages(msgs, 0, 0);
    expect(out).toHaveLength(0);
  });
});
