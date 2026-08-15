/**
 * P2-10 前端工具测试：SSE 流解析（stage/trace/done/clarify/error 分发 + 跨块分段）。
 */
import { describe, expect, it, vi } from 'vitest';
import { readSseStream, stageLabel } from './sseStream';

/** 用给定分块构造 Response（每块独立 enqueue，模拟网络分片到达） */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body);
}

describe('stageLabel', () => {
  it('已知阶段返回可读文案', () => {
    expect(stageLabel('understanding')).toContain('理解问题');
    expect(stageLabel('introspecting')).toContain('数据自省');
    expect(stageLabel('sql_ready')).toContain('SQL 已生成');
    expect(stageLabel('executed')).toContain('SQL 已执行');
    expect(stageLabel('analyzing')).toContain('洞察');
  });

  it('未知/空阶段回落默认文案', () => {
    expect(stageLabel('whatever')).toBe('处理中…');
    expect(stageLabel('')).toBe('处理中…');
  });
});

describe('readSseStream', () => {
  it('stage 事件携带附加字段 info（sql_ready + sql）', async () => {
    const onStage = vi.fn();
    await readSseStream(
      sseResponse(['event: stage\ndata: {"stage":"sql_ready","sql":"SELECT 1"}\n\n']),
      { onStage },
    );
    expect(onStage).toHaveBeenCalledTimes(1);
    const [label, stage, info] = onStage.mock.calls[0];
    expect(label).toContain('SQL 已生成');
    expect(stage).toBe('sql_ready');
    expect(info).toEqual({ sql: 'SELECT 1' });
  });

  it('跨分块到达的事件仍能完整解析（缓冲拼接）', async () => {
    const onStage = vi.fn();
    await readSseStream(
      sseResponse(['event: sta', 'ge\ndata: {"stage":"executed"}', '\n\n']),
      { onStage },
    );
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onStage.mock.calls[0][1]).toBe('executed');
  });

  it('trace 事件要求 title 为字符串，否则忽略', async () => {
    const onTrace = vi.fn();
    await readSseStream(
      sseResponse([
        'event: trace\ndata: {"title":"步骤一","detail":"x"}\n\n',
        'event: trace\ndata: {"detail":"no title"}\n\n',
      ]),
      { onTrace },
    );
    expect(onTrace).toHaveBeenCalledTimes(1);
    expect(onTrace.mock.calls[0][0]).toMatchObject({ title: '步骤一' });
  });

  it('done / clarify 触发 onTerminal 且 data 原样透传', async () => {
    const onTerminal = vi.fn();
    await readSseStream(
      sseResponse([
        'event: done\ndata: {"answer":"ok"}\n\n',
        'event: clarify\ndata: {"question":"选哪个？"}\n\n',
      ]),
      { onTerminal },
    );
    expect(onTerminal.mock.calls).toEqual([
      ['done', { answer: 'ok' }],
      ['clarify', { question: '选哪个？' }],
    ]);
  });

  it('error 事件抛出异常并携带服务端文案', async () => {
    await expect(
      readSseStream(sseResponse(['event: error\ndata: {"error":"引擎不可用"}\n\n']), {}),
    ).rejects.toThrow('引擎不可用');
  });

  it('非 JSON 段与空 data 段被安全跳过', async () => {
    const onStage = vi.fn();
    const onTerminal = vi.fn();
    await readSseStream(
      sseResponse([
        'event: stage\ndata: {not-json}\n\n',
        'event: stage\ndata: \n\n',
        'event: stage\ndata: {"stage":"analyzing"}\n\n',
      ]),
      { onStage, onTerminal },
    );
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();
  });
});
