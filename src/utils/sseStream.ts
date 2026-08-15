/**
 * P1-6 QueryChat 拆分：SSE 流解析通用工具（P2-7 问数流式链路）。
 * 按 event/data 分段解析服务端 text/event-stream 响应；错误事件直接抛异常由调用方统一降级。
 */

/** SSE 阶段事件 → 用户可读的进度文案 */
export function stageLabel(stage: string): string {
  switch (stage) {
    case 'understanding':
      return '正在理解问题语义并匹配数据字段…';
    case 'introspecting':
      return '数据自省中：正在确认真实取值…';
    case 'executed':
      return 'SQL 已执行，正在生成分析解读…';
    case 'analyzing':
      return '正在基于真实数据生成洞察…';
    default:
      return '处理中…';
  }
}

export interface SseStreamHandlers {
  /** 阶段进度事件（stage 文案直接可渲染） */
  onStage?: (label: string, stage: string) => void;
  /** M1 推导留痕步骤事件（追加步骤器） */
  onTrace?: (step: any) => void;
  /** 终端事件（done / clarify），payload 与非流式 JSON 响应同构 */
  onTerminal?: (event: 'done' | 'clarify', data: any) => void;
}

/** 消费 SSE 响应体：逐块解码、按空行分段、event:/data: 行解析后分发回调 */
export async function readSseStream(response: Response, handlers: SseStreamHandlers): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      let eventName = 'message';
      let dataStr = '';
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      let data: any;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (eventName === 'stage') {
        handlers.onStage?.(stageLabel(String(data?.stage || '')), String(data?.stage || ''));
      } else if (eventName === 'trace') {
        if (data && typeof data.title === 'string') handlers.onTrace?.(data);
      } else if (eventName === 'done' || eventName === 'clarify') {
        handlers.onTerminal?.(eventName, data);
      } else if (eventName === 'error') {
        throw new Error(String(data?.error || '查询失败'));
      }
    }
  }
}
