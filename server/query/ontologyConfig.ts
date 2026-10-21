/**
 * 业务本体配置（v0.9.110）：开关与注入预算，环境变量缺省即启用（与记忆体/知识库同模式）。
 * 无本体数据时零注入，因此默认开启不改变既有问数行为。
 */

/** 本体注入总开关：缺省开启，'0' 关闭（关闭后圈表不加权、prompt 不注入，可作全量回退开关） */
export function ontologyEnabled(): boolean {
  return process.env.ONTOLOGY_ENABLED !== '0';
}

/** 本体段注入预算（近似 token）：默认 1500，命中项多时由 buildOntologyPrompt 内部截断 */
export function ontologyTokenBudget(): number {
  const raw = Number(process.env.ONTOLOGY_TOKEN_BUDGET);
  return Number.isFinite(raw) && raw >= 200 ? Math.floor(raw) : 1500;
}

/**
 * 实体 embedding 精排开关：缺省复用 embedding 可用性（调用失败自动降级纯关键词匹配），
 * '0' 显式关闭可省一次 embedding 往返（无 embedding 模型的本地环境建议关闭）。
 */
export function ontologyEmbeddingEnabled(): boolean {
  return process.env.ONTOLOGY_EMBEDDING_ENABLED !== '0';
}
