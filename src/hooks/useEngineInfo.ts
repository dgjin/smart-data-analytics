import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

export interface EngineInfo {
  engine: 'ollama' | 'gemini' | 'qwen';
  model: string;
  /** 展示标签（如 "Ollama qwen3.6:latest"），由服务端按实际配置给出 */
  label: string;
}

// 模块级缓存：引擎信息在会话内不变，多个组件共享一次请求
let cached: EngineInfo | null = null;
let inflight: Promise<EngineInfo | null> | null = null;

function loadEngineInfo(): Promise<EngineInfo | null> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = apiFetch('/api/system/engine')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (cached = d && d.label ? (d as EngineInfo) : null))
      .catch(() => null);
  }
  return inflight;
}

/** 当前实际使用的 AI 引擎信息；未加载完成或请求失败时返回 null（调用方给兜底文案） */
export function useEngineInfo(): EngineInfo | null {
  const [info, setInfo] = useState<EngineInfo | null>(cached);
  useEffect(() => {
    let alive = true;
    loadEngineInfo().then((d) => {
      if (alive && d) setInfo(d);
    });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
