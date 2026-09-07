/**
 * P1-2 Token 级流式输出：callLLMTextStream（SSE 逐字）+ callLLMJsonStream（完整结果转 chunk 流）。
 * 引擎选择/熔断转移与 llmClient 主通道一致（engineKind + resolveEngineWithFailover）。
 */
import {
  callLLMJson,
  engineKind,
  geminiModel,
  llmModel,
  qwenModel,
  qwenTimeoutMs,
  qwenUrl,
  recordUsage,
  resolveEngineWithFailover,
  type ChatMessage,
  type LlmStageRoute,
} from './llmClient';
import { ollamaTimeoutMs, withOllamaBackend } from './ollamaBackends';
import { makeLlmError } from './llmResilience';

// ========== P1-2 Token 级流式输出支持 ============

/** SSE event type for streaming chunks（error 帧用于流式过程异常通知前端） */
export interface StreamingChunk {
  type: 'chunk' | 'error';
  content: string;
  done?: boolean;
  error?: string;
}

/**
 * 以纯文本模式调用 LLM，返回 ReadableStream<string>用于 token-by-token 推送
 * 与 callLLMText 的区别：使用 stream=true+ SSE 逐字输出而非等待完整结果
 */
export async function callLLMTextStream(
  system: string, 
  user: string,
  opts?: { model?: string; timeoutMs?: number }
): Promise<ReadableStream<StreamingChunk>> {
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  
  const primary = engineKind();
  const { kind, circuitOpen } = resolveEngineWithFailover(primary);
  
  // 创建 TransformStream 用于构建流式输出
  const transformStream = new TransformStream<StreamingChunk>();
  const writer = transformStream.writable.getWriter();

  if (circuitOpen) {
    writer.write({ type: 'error', content: `LLM 引擎 ${primary} 熔断开路` });
    writer.close();
    return transformStream.readable;
  }

  const timeoutMs = opts?.timeoutMs || (kind === 'ollama' ? ollamaTimeoutMs() : qwenTimeoutMs());
  const modelOverride = opts?.model;
  const usedModel = kind === 'ollama' ? (modelOverride || llmModel()) : kind === 'qwen' ? (modelOverride || qwenModel()) : geminiModel();
  const t0 = Date.now();

  // 统一 AbortController 处理超时
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    if (kind === 'qwen') {
      // ========== 千问百炼 API 流式处理 ==========
      const res = await fetch(`${qwenUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.QWEN_API_KEY || ''}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: usedModel,
          messages,
          stream: true,  // ← 启用流式输出
          response_format: { type: 'json_object' },  // P0-1 结构化输出约束
        }),
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw makeLlmError(`Qwen API error: ${res.status} ${errorText}`, { status: res.status });
      }

      // 解析 SSE 流
      const textDecoder = new TextDecoder();
      const reader = res.body!.getReader();

      let fullContent = '';

      while (true) {
        const { done: doneReading, value } = await reader.read();
        if (doneReading) break;

        if (value) {
          const chunkStr = textDecoder.decode(value, { stream: true });
          // SSE 格式：data: {...}\n\n
          const lines = chunkStr.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                const jsonStr = line.slice(5).trim();
                if (jsonStr === '[DONE]') {
                  writer.write({ type: 'chunk', content: '', done: true });
                  break;
                }
                
                const parsed = JSON.parse(jsonStr);
                const choices = parsed.choices || [];
                
                if (choices.length > 0) {
                  const delta = choices[0].delta || {};
                  const content = delta.content || '';
                  
                  if (content) {
                    fullContent += content;
                    // 直接推送原始 token（打字机效果）
                    writer.write({ type: 'chunk', content });
                  }
                }
              } catch (e) {
                // 忽略解析错误（可能是截断的 JSON）
              }
            }
          }
        }
      }

      recordUsage({ 
        engine: kind, 
        model: usedModel, 
        channel: 'text_stream', 
        promptTokens: 0, 
        completionTokens: 0, 
        durationMs: Date.now() - t0, 
        ok: true 
      });
      
    } else if (kind === 'ollama') {
      // ========== Ollama API 流式处理（P2-2 多后端：仅初始连接参与故障转移，流式读取不包裹） ==========
      const res = await withOllamaBackend((base) =>
        fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: usedModel,
            messages,
            stream: true,  // ← 启用流式输出
            keep_alive: '30m',
            format: 'json',  // P0-1 结构化输出约束
          }),
        })
      );

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        throw makeLlmError(`Ollama API error: ${res.status} ${errorText}`, { status: res.status });
      }

      // 解析 SSE 流
      const textDecoder = new TextDecoder();
      const reader = res.body!.getReader();

      let fullContent = '';

      while (true) {
        const { done: doneReading, value } = await reader.read();
        if (doneReading) break;

        if (value) {
          const chunkStr = textDecoder.decode(value, { stream: true });
          const lines = chunkStr.split('\n');
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                
                // Ollama SSE 格式：{ "message": { "content": "xxx" }, "done": false }
                if (parsed.message?.content) {
                  const content = parsed.message.content;
                  fullContent += content;
                  // 直接推送原始 token（打字机效果）
                  writer.write({ type: 'chunk', content });
                }
                
                if (parsed.done) {
                  writer.write({ type: 'chunk', content: '', done: true });
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
      }

      recordUsage({ 
        engine: kind, 
        model: usedModel, 
        channel: 'text_stream', 
        promptTokens: 0, 
        completionTokens: 0, 
        durationMs: Date.now() - t0, 
        ok: true 
      });
      
    } else if (kind === 'gemini') {
      // ========== Gemini API 流式处理 ==========
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      
      const response = await ai.models.generateContentStream({
        model: usedModel,
        contents: [{ role: 'user', parts: [{ text: system + '\n\n' + user }] }],
      });

      let fullContent = '';
      
      // 订阅 Stream 事件
      for await (const item of response) {
        if (item.text) {
          const content = item.text;
          fullContent += content;
          writer.write({ type: 'chunk', content });
        }
        
        // 检查是否有结束标志
        if (item.candidates?.[0]?.finishReason) {
          writer.write({ type: 'chunk', content: '', done: true });
          break;
        }
      }

      recordUsage({ 
        engine: kind, 
        model: usedModel, 
        channel: 'text_stream', 
        promptTokens: 0, 
        completionTokens: 0, 
        durationMs: Date.now() - t0, 
        ok: true 
      });
    }
    
    // 正常完成时确保关闭 writer
    if (!writer.closed) {
      await writer.close();
    }
    
  } catch (err) {
    clearTimeout(timer);
    writer.write({ type: 'error', content: err instanceof Error ? err.message : 'Unknown error' });
    writer.close();
    recordUsage({ engine: kind, model: usedModel, channel: 'text_stream', promptTokens: 0, completionTokens: 0, durationMs: Date.now() - t0, ok: false });
    throw err;
  } finally {
    clearTimeout(timer);
    writer.releaseLock();
  }

  return transformStream.readable;
}

/**
 * JSON 模式流式输出：先获取完整结果再转为 chunk 流
 * 注意：这是简化方案，理想情况应直接从 SSE 解析增量 JSON
 */
export async function callLLMJsonStream(
  system: string, 
  user: string,
  history: ChatMessage[] = [],
  opts?: { model?: string; route?: LlmStageRoute }
): Promise<ReadableStream<StreamingChunk>> {
  const fullText = await callLLMJson(system, user, history, opts);
  
  const transformStream = new TransformStream<StreamingChunk>();
  const writer = transformStream.writable.getWriter();
  
  // 分批推送字符（模拟打字机效果）
  const step = 50;
  for (let i = 0; i < fullText.length; i += step) {
    await new Promise(resolve => setTimeout(resolve, 30));
    const chunk = fullText.slice(i, Math.min(i + step, fullText.length));
    writer.write({ type: 'chunk', content: chunk });
  }
  
  writer.write({ type: 'chunk', content: '', done: true });
  writer.close();
  
  return transformStream.readable;
}
