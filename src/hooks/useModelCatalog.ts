import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

/** 可选模型条目（与 server/llmClient.ts ModelOption 对齐） */
export interface ModelOption {
  engine: 'ollama' | 'gemini' | 'qwen';
  model: string;
  label: string;
  isDefault: boolean;
}

/**
 * 当前部署可用的模型目录（供用户自选）。
 * 加载失败返回空数组，选择器自动隐藏（不影响问数主流程）。
 */
export function useModelCatalog(): { models: ModelOption[]; loading: boolean } {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    apiFetch('/api/system/models')
      .then((r) => (r.ok ? r.json() : { models: [] }))
      .then((d) => {
        if (alive && Array.isArray(d?.models)) setModels(d.models);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { models, loading };
}
