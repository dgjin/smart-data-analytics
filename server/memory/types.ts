/**
 * 统一记忆体（Memory）类型定义 —— 一期实现。
 *
 * 设计要点：
 * - 仅 CORRECTION（纠错）落 memory_items；其余类别由 channels Adapter 只读现有表复用，
 *   权威资产（指标/铁律/知识库/样例库/对话历史）不迁移、不双写。
 * - Router 对外返回"可直接拼进阶段一 prompt 的块 + few-shot 消息对"，保持与现有
 *   buildStage1System / 消息对注入格式兼容。
 */

/** 记忆类别（与设计文档 8 通道一一对应） */
export type MemoryKind =
  | 'IRON'
  | 'METRIC'
  | 'KNOWLEDGE'
  | 'EXTERNAL'
  | 'EXAMPLE'
  | 'NEGATIVE'
  | 'CONVERSATION'
  | 'CORRECTION';

/** 纠错类型：与前端点踩弹层选项一致 */
export type MemoryErrorType = 'TABLE_CHOICE' | 'COLUMN' | 'CALIBER' | 'UNDERSTANDING' | 'OTHER';

export type MemoryStatus = 'ACTIVE' | 'ARCHIVED' | 'DISABLED';

export type MemoryRole = 'ADMIN' | 'ANALYST' | 'VIEWER';

/** 记忆命名空间：数据源必填；个人记忆以 userId 约束召回域 */
export interface MemoryScope {
  dataSourceId: string;
  userId: number;
  role: MemoryRole;
}

/** memory_items 行（一期仅 CORRECTION） */
export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  dataSourceId: string;
  userId: number | null;
  question: string;
  content: string;
  errorType: MemoryErrorType;
  expectedSql: string;
  /** 问题向量（embedding_json 解析；引擎不可用时为 null，召回退化为 bigram） */
  embedding: number[] | null;
  confidence: number;
  hits: number;
  lastUsedAt: string | null;
  status: MemoryStatus;
  source: 'USER' | 'ADMIN' | 'DERIVED';
  createdBy: string;
  createdAt: string | null;
}

/** memory_candidates 行（待审核候选） */
export interface MemoryCandidate {
  id: number;
  kind: MemoryKind;
  dataSourceId: string;
  userId: number | null;
  question: string;
  wrongSql: string;
  errorType: MemoryErrorType;
  payload: Record<string, unknown>;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'MERGED';
  reviewedBy: string;
  reviewedAt: string | null;
  memoryId: number | null;
  createdAt: string | null;
}

/** 通道内单条命中 */
export interface ChannelHit {
  /** mem:<id>（memory_items）或 ext:<table>:<id>（现有表/外部源） */
  ref: string;
  kind: MemoryKind;
  question: string;
  /** 注入用文本（已按通道格式化的单条片段） */
  text: string;
  sql?: string;
  /** 通道内相关度 [0,1] */
  rel: number;
  confidence: number;
  createdAt: string | null;
}

/** 通道召回结果：prompt/pairs/examples 三者按通道性质选择 */
export interface ChannelResult {
  hits: ChannelHit[];
  /** 整段强制/文本注入块（iron/metric/knowledge/external/correction/negative 使用） */
  prompt?: string;
  /** few-shot 消息对（example/conversation 使用） */
  pairs?: { question: string; sql: string }[];
  /** 反例（NegativeExample 兼容结构） */
  examples?: { question: string; wrongTables: string }[];
  /** 是否强制注入（不受竞争预算裁剪） */
  forced?: boolean;
}

export interface RecallContext {
  scope: MemoryScope;
  query: string;
  /** 圈定表名（few-shot 相关性引导，可空） */
  relevantTables?: string[];
  traceId?: string;
}

/** 通道接口：每个通道只负责"从自己的来源取候选并格式化" */
export interface MemoryChannel {
  id: MemoryKind;
  recall(ctx: RecallContext): Promise<ChannelResult>;
}

/** 召回统计：用于 trace 与 memory_usage 留痕 */
export interface MemoryRecallStats {
  channelHits: Partial<Record<MemoryKind, number>>;
  deduped: number;
  injectedTokens: number;
  elapsedMs: number;
  forced: number;
  shadow: boolean;
}

/** Router 对外产出：与 liveQuery 现有拼装方式兼容 */
export interface MemoryRecallBundle {
  /** 强制段：铁律 */
  ironRulesPrompt: string;
  /** 强制段：语义指标 */
  metricPrompt: string;
  /** 文本注入块：纠错 + 知识 + 外部知识（已做预算裁剪） */
  knowledgeBlock: string;
  /** 反例（NegativeExample 兼容） */
  negativeExamples: { question: string; wrongTables: string }[];
  /** few-shot 消息对（团队样例在前、个人沉淀在后，已去重与预算裁剪） */
  fewShotPairs: { question: string; sql: string }[];
  stats: MemoryRecallStats;
  /** 全部召回条目（含未入选，供 shadow 对比与评测） */
  recalled: ChannelHit[];
}

export interface UsageRow {
  traceId: string;
  userId: number;
  dataSourceId: string;
  memoryRef: string;
  channel: string;
  rankNo: number;
  score: number;
  tokens: number;
  injected: number;
}

/** 点踩纠正采集入参（feedback 扩展） */
export interface RememberCorrectionInput {
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
  wrongSql: string;
  errorType: MemoryErrorType;
  note?: string;
  expectedSql?: string;
  traceId?: string;
}
