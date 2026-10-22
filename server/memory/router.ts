/**
 * Memory Router：统一召回编排（一期）。
 *
 * 流程：off/灰度判定 → 8 通道并行（单通道超时隔离）→ 去重 → 分通道预算 → 全局硬上限
 *      → 拼装强制段/文本块/few-shot 消息对/反例 → memory_usage 留痕。
 *
 * 失败策略：任何通道异常或超时都只降级该通道；Router 整体超时返回 null，
 * 调用方继续走原有七路上下文，问数主链路永不因记忆体失败而中断。
 */
import { approxTokens, budgetText } from '../llm/promptBudget';
import { observeMemoryRecall } from '../infra/monitoring';
import { recordSpan } from '../infra/trace';
import { normalizeSql } from '../query/queryFeedback';
import {
  MEMORY_BUDGETS,
  isMemoryEnabledForUser,
  memoryChannelTimeoutMs,
  memoryRecallTimeoutMs,
  memoryRouterMode,
  memoryTotalTokenBudget,
} from './config';
import { fusionScore } from './governance';
import { bumpCorrectionUsage, touchUsage } from './provider.mysql';
import { correctionChannel } from './channels/correction';
import { conversationChannel } from './channels/conversation';
import { exampleChannel } from './channels/example';
import { externalChannel } from './channels/external';
import { ironChannel } from './channels/iron';
import { knowledgeChannel } from './channels/knowledge';
import { metricChannel } from './channels/metric';
import { negativeChannel } from './channels/negative';
import type {
  ChannelHit,
  ChannelResult,
  MemoryChannel,
  MemoryKind,
  MemoryRecallBundle,
  RecallContext,
} from './types';

/** 通道执行顺序即注入顺序：强制段 → 纠错 → 知识 → 外部 → 样例 → 个人 → 反例 */
export const DEFAULT_MEMORY_CHANNELS: MemoryChannel[] = [
  ironChannel,
  metricChannel,
  correctionChannel,
  knowledgeChannel,
  externalChannel,
  exampleChannel,
  conversationChannel,
  negativeChannel,
];

/** 单次 Promise 超时：超时/异常统一返回 null，由调用方按"无命中"处理 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(1, ms));
    p.then((v) => {
      clearTimeout(timer);
      resolve(v);
    }).catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function recallAll(
  ctx: RecallContext,
  channels: MemoryChannel[]
): Promise<Map<MemoryKind, ChannelResult>> {
  const perChannel = memoryChannelTimeoutMs();
  const settled = await Promise.all(
    channels.map(async (ch) => {
      const result = await withTimeout(ch.recall(ctx).catch(() => null), perChannel);
      return [ch.id, result] as const;
    })
  );
  const map = new Map<MemoryKind, ChannelResult>();
  for (const [id, result] of settled) {
    if (result) map.set(id, result);
  }
  return map;
}

function pairCost(question: string, sql: string): number {
  return approxTokens(question) + approxTokens(sql) + 8;
}

/**
 * 把各通道结果拼装为注入包（纯函数，便于单测）。
 * 预算优先级：纠错 > 知识 > 外部 > few-shot > 反例；铁律/指标为强制段不参与裁剪。
 */
export function buildMemoryBundle(
  results: Map<MemoryKind, ChannelResult>,
  shadow = false
): MemoryRecallBundle {
  const channelHits: Partial<Record<MemoryKind, number>> = {};
  for (const [kind, result] of results) channelHits[kind] = result.hits.length;

  const iron = results.get('IRON');
  const metric = results.get('METRIC');
  const correction = results.get('CORRECTION');
  const knowledge = results.get('KNOWLEDGE');
  const external = results.get('EXTERNAL');
  const example = results.get('EXAMPLE');
  const conversation = results.get('CONVERSATION');
  const negative = results.get('NEGATIVE');

  const correctionHits = correction?.hits || [];

  // 1) 纠错块（最高优先级，按通道预算裁剪）
  let correctionBlock = '';
  if (correctionHits.length > 0) {
    const header =
      '【历史纠错记忆】（以下问题此前被用户或管理员确认回答有误；本次生成 SQL 必须避免同类错误，优先采用纠正要点与期望口径）:\n';
    correctionBlock = budgetText(`${header}${correctionHits.map((h) => h.text).join('\n')}\n`, MEMORY_BUDGETS.correction);
  }

  // 2) 知识 / 外部（各自通道预算后，再做全局硬上限）
  let knowledgePart = budgetText(knowledge?.prompt || '', MEMORY_BUDGETS.knowledge);
  let externalPart = budgetText(external?.prompt || '', MEMORY_BUDGETS.external);
  const totalBudget = memoryTotalTokenBudget();
  const usedByCorrection = approxTokens(correctionBlock);
  if (usedByCorrection + approxTokens(knowledgePart) + approxTokens(externalPart) > totalBudget) {
    const remainForExternal = Math.max(0, totalBudget - usedByCorrection - approxTokens(knowledgePart));
    externalPart = budgetText(externalPart, remainForExternal);
    if (usedByCorrection + approxTokens(knowledgePart) + approxTokens(externalPart) > totalBudget) {
      knowledgePart = budgetText(
        knowledgePart,
        Math.max(0, totalBudget - usedByCorrection - approxTokens(externalPart))
      );
    }
  }
  const knowledgeBlock = [correctionBlock.trim(), knowledgePart.trim(), externalPart.trim()]
    .filter(Boolean)
    .join('\n\n');

  // 3) few-shot：团队样例优先、个人沉淀补充；按归一化 SQL 去重并按共享预算裁剪
  let deduped = 0;
  const seenSql = new Set<string>();
  const fewShotPairs: { question: string; sql: string }[] = [];
  let fewShotTokens = 0;
  for (const source of [example?.pairs || [], conversation?.pairs || []]) {
    for (const pair of source) {
      const key = normalizeSql(pair.sql).toLowerCase();
      if (!key || seenSql.has(key)) {
        deduped++;
        continue;
      }
      const cost = pairCost(pair.question, pair.sql);
      if (fewShotTokens + cost > MEMORY_BUDGETS.fewShot) {
        deduped++;
        continue;
      }
      seenSql.add(key);
      fewShotPairs.push(pair);
      fewShotTokens += cost;
    }
  }

  // 4) 反例：与纠错记忆问题重复的丢弃（纠错信息更完整）
  const negativeQuestions = new Set(correctionHits.map((h) => h.question.trim()));
  const negativeExamples = (negative?.examples || [])
    .filter((e) => !negativeQuestions.has(e.question.trim()))
    .slice(0, MEMORY_BUDGETS.negativeMax);
  const negativeTokens =
    negativeExamples.length > 0
      ? approxTokens(negativeExamples.map((e) => `错误案例：${e.question}${e.wrongTables}`).join('\n'))
      : 0;

  const recalled: ChannelHit[] = [
    ...correctionHits,
    ...(knowledge?.hits || []),
    ...(external?.hits || []),
    ...(example?.hits || []),
    ...(conversation?.hits || []),
    ...(negative?.hits || []),
    ...(iron?.hits || []),
    ...(metric?.hits || []),
  ];

  return {
    ironRulesPrompt: iron?.prompt || '',
    metricPrompt: metric?.prompt || '',
    knowledgeBlock,
    negativeExamples,
    fewShotPairs,
    stats: {
      channelHits,
      deduped,
      injectedTokens:
        approxTokens(knowledgeBlock) + fewShotTokens + negativeTokens,
      elapsedMs: 0,
      forced: (iron?.hits.length || 0) + (metric?.hits.length || 0),
      shadow,
    },
    recalled,
  };
}

/** 写 memory_usage 留痕（fire-and-forget；traceId 缺失时跳过） */
export async function persistMemoryUsage(
  ctx: RecallContext,
  bundle: MemoryRecallBundle,
  shadow: boolean
): Promise<void> {
  const traceId = String(ctx.traceId || '').trim();
  if (!traceId || bundle.recalled.length === 0) return;
  const rows = bundle.recalled.slice(0, 100).map((hit, i) => ({
    traceId,
    userId: ctx.scope.userId,
    dataSourceId: ctx.scope.dataSourceId,
    memoryRef: hit.ref,
    channel: hit.kind,
    rankNo: i + 1,
    score: fusionScore(hit.kind, hit.rel, hit.confidence, hit.createdAt),
    tokens: approxTokens(hit.text),
    injected: shadow ? 0 : 1,
  }));
  await touchUsage(rows);
  if (!shadow) {
    const ids = bundle.recalled
      .filter((h) => h.ref.startsWith('mem:'))
      .map((h) => Number(h.ref.slice(4)))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length > 0) await bumpCorrectionUsage(ids);
  }
}

/**
 * 统一召回入口。
 * - off：返回 null（零开销，不触达任何表）；
 * - shadow：完整召回并写留痕，但返回 null（调用方不注入）；
 * - on：按 userId 灰度，命中则返回注入包。
 */
export async function recallMemory(ctx: RecallContext): Promise<MemoryRecallBundle | null> {
  const mode = memoryRouterMode();
  if (mode === 'off') return null;
  if (mode === 'on' && !isMemoryEnabledForUser(ctx.scope.userId)) return null;

  const started = Date.now();
  const results = await withTimeout(
    recallAll(ctx, DEFAULT_MEMORY_CHANNELS),
    memoryRecallTimeoutMs()
  );
  if (!results) {
    const durationMs = Date.now() - started;
    observeMemoryRecall({ mode, ok: false, durationMs, injectedTokens: 0, channelHits: {} });
    recordSpan('memory.recall', durationMs, 'error', { 'memory.mode': mode, 'memory.timeout': true });
    return null;
  }

  const shadow = mode === 'shadow';
  const bundle = buildMemoryBundle(results, shadow);
  bundle.stats.elapsedMs = Date.now() - started;
  observeMemoryRecall({
    mode,
    ok: true,
    durationMs: bundle.stats.elapsedMs,
    injectedTokens: bundle.stats.injectedTokens,
    channelHits: bundle.stats.channelHits,
  });
  // P2-1 链路埋点：与 Prometheus 指标同源，命中数便于对比「召回耗时高但无产出」的空转
  recordSpan('memory.recall', bundle.stats.elapsedMs, 'ok', {
    'memory.mode': mode,
    'memory.injected_tokens': bundle.stats.injectedTokens,
    'memory.hits': Object.values(bundle.stats.channelHits).reduce<number>((sum, n) => sum + (n || 0), 0),
  });
  void persistMemoryUsage(ctx, bundle, shadow).catch(() => undefined);
  return shadow ? null : bundle;
}
