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
    case 'sql_ready':
      return 'SQL 已生成，正在安全校验并执行…';
    case 'executed':
      return 'SQL 已执行，正在生成分析解读…';
    case 'analyzing':
      return '正在基于真实数据生成洞察…';
    default:
      return '处理中…';
  }
}

export interface SseStreamHandlers {
  /** 阶段进度事件（stage 文案直接可渲染；info 携带事件附加字段，如 sql_ready/executed 的 sql） */
  onStage?: (label: string, stage: string, info?: Record<string, any>) => void;
  /** M1 推导留痕步骤事件（追加步骤器） */
  onTrace?: (step: any) => void;
  /** P1-2 Token 级流式输出：LLM 生成内容逐字推送（打字机效果） */
  onChunk?: (content: string) => void;
  /** 终端事件（done / clarify / refuse），payload 与非流式 JSON 响应同构 */
  onTerminal?: (event: 'done' | 'clarify' | 'refuse', data: any) => void;
  /** P2-5 断线续传：每个事件的服务端序号（SSE id 字段），调用方记录最后已收序号用于断点续传 */
  onEventId?: (id: string) => void;
}

/** 消费 SSE 响应体：逐块解码、按空行分段、event:/data: 行解析后分发回调 */
export async function readSseStream(response: Response, handlers: SseStreamHandlers): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  
  // P1-2 流式内容累积
  let streamContentBuffer = '';
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    
    for (const part of parts) {
      let eventName = 'message';
      let dataStr = '';
      let eventId = '';
      
      for (const line of part.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        else if (line.startsWith('id:')) eventId = line.slice(3).trim();
      }
      
      if (eventId) handlers.onEventId?.(eventId);
      if (!dataStr) continue;
      
      // P1-2 检查是否是流式 chunk 事件（直接推送文本内容）
      if (eventName === 'chunk') {
        try {
          const chunkData = JSON.parse(dataStr);
          if (chunkData.type === 'chunk' && chunkData.content) {
            streamContentBuffer += chunkData.content;
            // 实时推送给前端渲染（打字机效果）
            handlers.onChunk?.(chunkData.content);
          }
          
          if (chunkData.done) {
            console.log('[P1-2 Stream] Content stream done, total:', streamContentBuffer.length);
          }
          
          if (chunkData.error) {
            console.error('[P1-2 Stream] Error:', chunkData.error);
          }
        } catch (e) {
          // 忽略解析错误
        }
        continue;
      }
      
      let data: any;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }
      
      if (eventName === 'stage') {
        const stage = String(data?.stage || '');
        const { stage: _stage, ...info } = data || {};
        handlers.onStage?.(stageLabel(stage), stage, info);
      } else if (eventName === 'trace') {
        if (data && typeof data.title === 'string') handlers.onTrace?.(data);
      } else if (eventName === 'done' || eventName === 'clarify' || eventName === 'refuse') {
        handlers.onTerminal?.(eventName, data);
      } else if (eventName === 'error') {
        // P2-5：error 属终态事件——挂 sseTerminal 标记供调用方区分「业务终态错误」与
        // 「网络中断」，后者才允许断线续传（终态错误直接呈现，不重试）
        const err = new Error(String(data?.error || '查询失败')) as Error & { sseTerminal?: boolean };
        err.sseTerminal = true;
        throw err;
      }
    }
  }
}
