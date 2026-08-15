/**
 * P2-2 对话滚动上限：zustand persist 的 chatMessages 无限增长会导致 localStorage 膨胀，
 * 追加消息时按数据源分组各自保留最近 N 条（无归属消息单独限量），防超配额。
 */

/** 单个数据源保留的最大消息条数（评估建议约 200 条/源） */
export const MAX_MESSAGES_PER_SOURCE = 200;

/** 无数据源归属的消息（欢迎语等）全局保留上限 */
export const MAX_UNASSIGNED_MESSAGES = 50;

/**
 * 滚动裁剪：保留每个 dataSourceId 分组的最后 maxPerDs 条 + 无归属消息的最后 maxUnassigned 条。
 * 输入顺序保持不变（时间正序），仅淘汰各组更早的历史。
 */
export function trimChatMessages<T extends { dataSourceId?: string }>(
  messages: T[],
  maxPerDs: number = MAX_MESSAGES_PER_SOURCE,
  maxUnassigned: number = MAX_UNASSIGNED_MESSAGES
): T[] {
  // 快路径：总量不超过单源上限时任何分组都不会超限
  if (messages.length <= maxPerDs) return messages;

  const keptPerDs = new Map<string, number>();
  let keptUnassigned = 0;
  const kept: T[] = [];

  // 从最新往回数，命中配额则保留
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const ds = msg.dataSourceId ?? '';
    if (!ds) {
      if (keptUnassigned < maxUnassigned) {
        kept.push(msg);
        keptUnassigned++;
      }
      continue;
    }
    const used = keptPerDs.get(ds) || 0;
    if (used < maxPerDs) {
      kept.push(msg);
      keptPerDs.set(ds, used + 1);
    }
  }

  kept.reverse();
  return kept;
}
