import { useState } from 'react';
import { TraceStepInfo } from '../AnalysisTracePanel';

/**
 * 流式问数状态集合（P0 上帝组件拆分：自 QueryChat 提取，行为保持一致）。
 * 收敛 SSE 流式链路相关状态：阶段进度文案 / SQL 先行预览 / Token 级流式内容缓冲 /
 * 流式接收标记 / 实时推导步骤链。
 */
export function useStreamState() {
  // P2-7 SSE 流式进度：服务端阶段事件推送的实时状态文案
  const [streamProgress, setStreamProgress] = useState<string | null>(null);
  // P2-1 SQL 先行回显：sql_ready/executed 阶段携带的 SQL，长等待期提前展示
  const [streamPreviewSql, setStreamPreviewSql] = useState<string | null>(null);
  // P1-2 Token 级流式输出：LLM 生成内容的增量缓冲区（打字机效果）
  const [streamingContent, setStreamingContent] = useState<string>('');
  // 当前查询是否正在接收流式内容
  const [isReceivingStream, setIsReceivingStream] = useState<boolean>(false);
  // M1 推导留痕：SSE trace 事件实时追加的步骤链（查询中展示步骤器）
  const [liveTraceSteps, setLiveTraceSteps] = useState<TraceStepInfo[]>([]);

  // 终端事件到达后复位流式临时状态（finally 中统一调用）
  const resetStreamState = () => {
    setStreamProgress(null);
    setStreamPreviewSql(null);
  };

  return {
    streamProgress,
    setStreamProgress,
    streamPreviewSql,
    setStreamPreviewSql,
    streamingContent,
    setStreamingContent,
    isReceivingStream,
    setIsReceivingStream,
    liveTraceSteps,
    setLiveTraceSteps,
    resetStreamState,
  };
}
