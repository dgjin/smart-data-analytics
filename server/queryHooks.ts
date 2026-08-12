/**
 * P2-10 问数生命周期钩子（Vanna 2.0 lifecycle hooks 轻版抽象）。
 * 在问数链路的「进入前 / 结束后」两个切面广播事件，审计、缓存写入等横切逻辑
 * 以及未来的插件（指标采集、敏感词审计、A/B 实验）都可挂接，无需再改路由主流程。
 */

export interface QueryHookContext {
  userId: number;
  username: string;
  dataSourceId: string;
  question: string;
  startedAt: number;
  /** 链路元信息（是否 live、是否流式等），供钩子按需消费 */
  meta?: Record<string, any>;
}

export interface QueryOutcome {
  /** SUCCESS / CLARIFY / FALLBACK / CACHE / DENIED_* / ERROR */
  status: string;
  executedSql?: string;
  rowCount?: number;
  durationMs: number;
  detail?: string;
}

type BeforeHook = (ctx: QueryHookContext) => void;
type AfterHook = (ctx: QueryHookContext, outcome: QueryOutcome) => void;

const beforeHooks: BeforeHook[] = [];
const afterHooks: AfterHook[] = [];

export function onBeforeQuery(hook: BeforeHook): void {
  beforeHooks.push(hook);
}

export function onAfterQuery(hook: AfterHook): void {
  afterHooks.push(hook);
}

/** 广播进入事件；钩子异常不阻断主链路 */
export function emitBeforeQuery(ctx: QueryHookContext): void {
  for (const h of beforeHooks) {
    try {
      h(ctx);
    } catch (err) {
      console.warn('[QueryHooks] before hook error:', err);
    }
  }
}

/** 广播结束事件；钩子异常不阻断主链路 */
export function emitAfterQuery(ctx: QueryHookContext, outcome: QueryOutcome): void {
  for (const h of afterHooks) {
    try {
      h(ctx, outcome);
    } catch (err) {
      console.warn('[QueryHooks] after hook error:', err);
    }
  }
}
